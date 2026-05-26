'use strict';

const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { createAuthMiddleware } = require('../middleware/auth');

const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 60000;
const RECONNECT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_RING_SIZE = 100;
const DASHBOARD_WS_PATH = '/ws/dashboard';
const LEGACY_DASHBOARD_WS_PATH = '/api/chat/ws';
const AGENT_WS_PREFIX = '/ws/agent/';

function sanitizeUrl(url) {
  if (typeof url !== 'string') {
    return '';
  }

  return url
    .replace(/([?&]token=)[^&]*/gi, '$1<REDACTED>')
    .replace(/([?&]reconnect_token=)[^&]*/gi, '$1<REDACTED>');
}

function parseQuery(url) {
  if (typeof url !== 'string') {
    return {};
  }

  const queryIndex = url.indexOf('?');
  if (queryIndex === -1) {
    return {};
  }

  const out = {};
  for (const pair of url.slice(queryIndex + 1).split('&')) {
    if (!pair) {
      continue;
    }

    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) {
      out[decodeURIComponent(pair)] = '';
      continue;
    }

    const key = decodeURIComponent(pair.slice(0, separatorIndex));
    const value = decodeURIComponent(pair.slice(separatorIndex + 1));
    out[key] = value;
  }

  return out;
}

function mintReconnectToken() {
  return crypto.randomBytes(16).toString('hex');
}

function attachWsServer(httpServer, { token, bus, ringSize = DEFAULT_RING_SIZE } = {}) {
  const authRequired = process.env.DASHBOARD_REQUIRE_AUTH === 'true';
  if (authRequired && (!token || typeof token !== 'string')) {
    throw new Error('attachWsServer: token is required');
  }
  if (!bus || typeof bus.publish !== 'function' || typeof bus.subscribe !== 'function') {
    throw new Error('attachWsServer: bus is required and must implement publish() + subscribe()');
  }
  if (!Number.isInteger(ringSize) || ringSize < 1) {
    throw new Error('attachWsServer: ringSize must be a positive integer');
  }

  const authenticate = authRequired ? createAuthMiddleware(token) : null;
  const dashboardWss = new WebSocketServer({ noServer: true, clientTracking: true });
  const agentWss = new WebSocketServer({ noServer: true, clientTracking: true });
  const registry = new Map();
  const rings = new Map();
  const disconnectedSessions = new Map();
  const agentSockets = new Map();

  function appendToRing(enrichedMsg) {
    const channel = enrichedMsg.channel;
    if (typeof channel !== 'string' || channel.length === 0) {
      return;
    }

    let ring = rings.get(channel);
    if (!ring) {
      ring = [];
      rings.set(channel, ring);
    }

    ring.push(enrichedMsg);
    if (ring.length > ringSize) {
      ring.splice(0, ring.length - ringSize);
    }
  }

  const ringUnsubscribe = bus.subscribe('*', appendToRing);

  function pruneDisconnectedSessions() {
    const now = Date.now();
    for (const [reconnectToken, entry] of disconnectedSessions.entries()) {
      if (entry.expiresAt <= now) {
        disconnectedSessions.delete(reconnectToken);
      }
    }
  }

  function sendJson(ws, payload) {
    ws.send(JSON.stringify(payload));
  }

  function sendMessageFrame(state, enrichedMsg) {
    try {
      const messageType = typeof enrichedMsg.type === 'string' ? enrichedMsg.type : null;
      const payload = { ...enrichedMsg };
      if (messageType) {
        delete payload.type;
      }
      sendJson(state.ws, { type: 'message', eventType: messageType, ...payload });
    } catch {
      // Connection is likely closing.
    }
  }

  function attachBusSubscriber(state, channel) {
    if (state.busUnsubscribes.has(channel)) {
      return;
    }

    const unsubscribe = bus.subscribe(channel, (enrichedMsg) => {
      sendMessageFrame(state, enrichedMsg);
    });
    state.busUnsubscribes.set(channel, unsubscribe);
  }

  function detachBusSubscriber(state, channel) {
    const unsubscribe = state.busUnsubscribes.get(channel);
    if (unsubscribe) {
      unsubscribe();
      state.busUnsubscribes.delete(channel);
    }
  }

  function detachAllBusSubscribers(state) {
    for (const unsubscribe of state.busUnsubscribes.values()) {
      try {
        unsubscribe();
      } catch {
        // Best-effort cleanup.
      }
    }
    state.busUnsubscribes.clear();
  }

  function sendErrorFrame(state, code, detail) {
    try {
      sendJson(state.ws, { type: 'error', code, detail });
    } catch {
      // Connection is likely closing.
    }
  }

  function publishDashboardEvent(agentName, event) {
    bus.publish(event.channelKey, { ...event, agentName });

    if (typeof agentName === 'string' && agentName && event.channelKey.startsWith('discord:')) {
      bus.publish(`dashboard:${agentName}`, { ...event, agentName, channelKey: `dashboard:${agentName}` });
    }
  }

  function forwardToAgent(agentName, payload, state) {
    const agentSocket = agentSockets.get(agentName);
    if (!agentSocket || agentSocket.readyState !== 1) {
      sendErrorFrame(state, 'agent_offline', `agent ${agentName} is offline`);
      return false;
    }

    try {
      sendJson(agentSocket, { kind: 'send', payload });
      return true;
    } catch (err) {
      sendErrorFrame(state, 'agent_send_failed', err.message);
      return false;
    }
  }

  function normalizeDashboardFrame(frame) {
    const verb = typeof frame.kind === 'string' ? frame.kind : frame.type;
    if (typeof verb !== 'string') {
      return null;
    }

    switch (verb) {
      case 'subscribe':
      case 'unsubscribe':
        return { type: verb, channel: typeof frame.channel === 'string' ? frame.channel : null };
      case 'ack':
        return {
          type: 'ack',
          channel: typeof frame.channel === 'string' ? frame.channel : null,
          sequence: frame.sequence,
        };
      case 'send': {
        if (typeof frame.agentName === 'string' && typeof frame.text === 'string') {
          return {
            type: 'send',
            agentName: frame.agentName,
            channel: `dashboard:${frame.agentName}`,
            text: frame.text,
            attachments: Array.isArray(frame.attachments) ? frame.attachments.filter((value) => typeof value === 'string') : [],
          };
        }

        if (typeof frame.channel === 'string' && typeof frame.content === 'string') {
          const agentName = frame.channel.startsWith('dashboard:') ? frame.channel.slice('dashboard:'.length) : null;
          return {
            type: 'send',
            agentName,
            channel: frame.channel,
            text: frame.content,
            attachments: [],
            legacy: true,
          };
        }

        return { type: 'send', channel: null, text: null, attachments: [] };
      }
      default:
        return { type: verb };
    }
  }

  function handleDashboardFrame(state, raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    } catch {
      sendErrorFrame(state, 'bad_json', 'frame did not parse as JSON');
      return;
    }

    const normalized = normalizeDashboardFrame(frame);
    if (!normalized) {
      sendErrorFrame(state, 'bad_frame', 'frame must be an object with a kind/type');
      return;
    }

    switch (normalized.type) {
      case 'subscribe': {
        if (typeof normalized.channel !== 'string' || normalized.channel.length === 0 || normalized.channel === '*') {
          sendErrorFrame(state, 'bad_channel', 'subscribe.channel must be a non-empty non-wildcard string');
          return;
        }

        state.subscribed_channels.add(normalized.channel);
        attachBusSubscriber(state, normalized.channel);
        sendJson(state.ws, { type: 'subscribed', channel: normalized.channel });
        return;
      }
      case 'unsubscribe': {
        if (typeof normalized.channel !== 'string' || normalized.channel.length === 0) {
          sendErrorFrame(state, 'bad_channel', 'unsubscribe.channel must be a non-empty string');
          return;
        }

        state.subscribed_channels.delete(normalized.channel);
        detachBusSubscriber(state, normalized.channel);
        sendJson(state.ws, { type: 'unsubscribed', channel: normalized.channel });
        return;
      }
      case 'ack': {
        if (typeof normalized.channel !== 'string' || normalized.channel.length === 0) {
          sendErrorFrame(state, 'bad_channel', 'ack.channel must be a non-empty string');
          return;
        }
        if (!Number.isInteger(normalized.sequence) || normalized.sequence < 0) {
          sendErrorFrame(state, 'bad_frame', 'ack.sequence must be a non-negative integer');
          return;
        }

        const previous = state.last_ack_seen.get(normalized.channel) ?? -1;
        if (normalized.sequence > previous) {
          state.last_ack_seen.set(normalized.channel, normalized.sequence);
        }
        return;
      }
      case 'send': {
        if (typeof normalized.channel !== 'string' || normalized.channel.length === 0) {
          sendErrorFrame(state, 'bad_channel', 'send requires agentName or channel');
          return;
        }
        if (typeof normalized.text !== 'string') {
          sendErrorFrame(state, 'bad_frame', 'send.text must be a string');
          return;
        }

        const agentName = normalized.agentName || (normalized.channel.startsWith('dashboard:') ? normalized.channel.slice('dashboard:'.length) : null);
        const payload = {
          id: crypto.randomUUID(),
          text: normalized.text,
          attachments: normalized.attachments,
          isSlashCommand: normalized.text.trim().startsWith('/'),
          rawCommand: normalized.text.trim().startsWith('/') ? normalized.text.trim().split(/\s+/, 1)[0] : undefined,
          channelKey: normalized.channel,
        };

        if (normalized.legacy) {
          bus.publish(normalized.channel, {
            id: crypto.randomUUID(),
            source: 'dashboard',
            source_message_id: crypto.randomUUID(),
            author_id: 'hive-owner',
            author_kind: 'user',
            content: normalized.text,
            attachments: [],
            metadata: {},
          });
        } else {
          bus.publish(normalized.channel, {
            type: 'user_message',
            source: 'dashboard',
            text: normalized.text,
            attachments: normalized.attachments,
            channelKey: normalized.channel,
            ts: Date.now(),
            agentName,
          });
        }

        if (agentName) {
          forwardToAgent(agentName, payload, state);
        }
        return;
      }
      default:
        sendErrorFrame(state, 'bad_type', `unknown frame type: ${normalized.type}`);
    }
  }

  function authenticateDashboardUpgrade(req) {
    if (!authRequired) {
      return true;
    }

    const query = parseQuery(req.url || '');
    let authorized = false;
    authenticate(
      { headers: req.headers || {}, query },
      {
        status() {
          return this;
        },
        json() {
          return this;
        },
      },
      () => {
        authorized = true;
      }
    );

    return authorized;
  }

  function isLoopbackAddress(address) {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  }

  function rejectUpgrade(socket, statusCode, statusText) {
    socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }

  function pathFromUrl(url) {
    if (typeof url !== 'string') {
      return '';
    }

    const queryIndex = url.indexOf('?');
    return queryIndex === -1 ? url : url.slice(0, queryIndex);
  }

  function buildDashboardState(ws, query, sanitizedUrl) {
    pruneDisconnectedSessions();

    const incomingReconnectToken = typeof query.reconnect_token === 'string' ? query.reconnect_token : null;
    const replayMessages = [];
    let state;

    if (incomingReconnectToken && disconnectedSessions.has(incomingReconnectToken)) {
      const saved = disconnectedSessions.get(incomingReconnectToken);
      disconnectedSessions.delete(incomingReconnectToken);

      state = {
        client_id: crypto.randomUUID(),
        ws,
        connected_at: new Date().toISOString(),
        last_ack_seen: new Map(saved.state.last_ack_seen),
        subscribed_channels: new Set(saved.state.subscribed_channels),
        reconnect_token: mintReconnectToken(),
        busUnsubscribes: new Map(),
        sanitizedUrl,
      };

      for (const channel of state.subscribed_channels) {
        const ring = rings.get(channel) || [];
        const lastAck = state.last_ack_seen.get(channel) ?? -1;
        for (const msg of ring) {
          if (msg.sequence > lastAck) {
            replayMessages.push(msg);
          }
        }
      }
    } else {
      state = {
        client_id: crypto.randomUUID(),
        ws,
        connected_at: new Date().toISOString(),
        last_ack_seen: new Map(),
        subscribed_channels: new Set(),
        reconnect_token: mintReconnectToken(),
        busUnsubscribes: new Map(),
        sanitizedUrl,
      };
    }

    return { state, replayMessages };
  }

  dashboardWss.on('connection', (ws, req) => {
    const sanitizedUrl = sanitizeUrl(req.url || '');
    const query = parseQuery(req.url || '');
    const { state, replayMessages } = buildDashboardState(ws, query, sanitizedUrl);
    registry.set(state.client_id, state);

    sendJson(ws, {
      type: 'hello',
      client_id: state.client_id,
      reconnect_token: state.reconnect_token,
    });

    for (const channel of state.subscribed_channels) {
      attachBusSubscriber(state, channel);
    }
    for (const msg of replayMessages) {
      sendMessageFrame(state, msg);
    }

    let lastPongAt = Date.now();
    const heartbeatInterval = setInterval(() => {
      pruneDisconnectedSessions();
      if (Date.now() - lastPongAt > HEARTBEAT_TIMEOUT_MS) {
        try {
          ws.close(1011, 'heartbeat timeout');
        } catch {
          // Connection is already closing.
        }
        return;
      }

      try {
        ws.ping();
      } catch {
        // Connection is already closing.
      }
    }, HEARTBEAT_INTERVAL_MS);

    ws.on('pong', () => {
      lastPongAt = Date.now();
    });

    ws.on('message', (raw) => {
      handleDashboardFrame(state, raw);
    });

    ws.on('close', (code, reason) => {
      clearInterval(heartbeatInterval);
      registry.delete(state.client_id);

      if (state.subscribed_channels.size > 0) {
        disconnectedSessions.set(state.reconnect_token, {
          state: {
            client_id: state.client_id,
            last_ack_seen: new Map(state.last_ack_seen),
            subscribed_channels: Array.from(state.subscribed_channels),
          },
          expiresAt: Date.now() + RECONNECT_TTL_MS,
        });
      }

      detachAllBusSubscribers(state);
      console.error(
        `[hive-dashboard ws] disconnect ${state.client_id} code=${code} reason=${Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason)}`
      );
    });

    ws.on('error', (err) => {
      console.error(`[hive-dashboard ws] error ${state.client_id} ${err.message}`);
    });
  });

  agentWss.on('connection', (ws, req, agentName) => {
    agentSockets.set(agentName, ws);
    console.log(`[hive-dashboard ws] agent connected ${agentName}`);

    ws.on('message', (raw) => {
      try {
        const event = JSON.parse(raw.toString('utf8'));
        if (!event || typeof event.type !== 'string' || typeof event.channelKey !== 'string' && event.type !== 'agent_status') {
          return;
        }

        if (event.type === 'agent_status' && typeof event.status === 'string') {
          bus.publish(`dashboard:${agentName}`, {
            ...event,
            agentName,
            channelKey: `dashboard:${agentName}`,
            ts: event.ts || Date.now(),
          });
          return;
        }

        publishDashboardEvent(agentName, {
          ...event,
          ts: event.ts || Date.now(),
        });
      } catch (err) {
        console.error(`[hive-dashboard ws] agent frame parse failed for ${agentName}: ${err.message}`);
      }
    });

    ws.on('close', () => {
      if (agentSockets.get(agentName) === ws) {
        agentSockets.delete(agentName);
      }
      bus.publish(`dashboard:${agentName}`, {
        type: 'agent_status',
        status: 'offline',
        agentName,
        channelKey: `dashboard:${agentName}`,
        ts: Date.now(),
      });
      console.log(`[hive-dashboard ws] agent disconnected ${agentName}`);
    });
  });

  function onUpgrade(req, socket, head) {
    const upgradePath = pathFromUrl(req.url || '');
    const sanitizedUrl = sanitizeUrl(req.url || '');

    if (upgradePath === DASHBOARD_WS_PATH || upgradePath === LEGACY_DASHBOARD_WS_PATH) {
      if (!authenticateDashboardUpgrade(req)) {
        console.error(`[hive-dashboard ws] auth-fail from ${sanitizedUrl}`);
        rejectUpgrade(socket, 401, 'Unauthorized');
        return;
      }

      dashboardWss.handleUpgrade(req, socket, head, (ws) => {
        dashboardWss.emit('connection', ws, req);
      });
      return;
    }

    if (upgradePath.startsWith(AGENT_WS_PREFIX)) {
      const agentName = decodeURIComponent(upgradePath.slice(AGENT_WS_PREFIX.length));
      if (!agentName) {
        rejectUpgrade(socket, 400, 'Bad Request');
        return;
      }

      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }

      agentWss.handleUpgrade(req, socket, head, (ws) => {
        agentWss.emit('connection', ws, req, agentName);
      });
      return;
    }

    rejectUpgrade(socket, 404, 'Not Found');
  }

  httpServer.on('upgrade', onUpgrade);

  function shutdown() {
    httpServer.off('upgrade', onUpgrade);
    ringUnsubscribe();
  }

  dashboardWss.on('close', shutdown);
  agentWss.on('close', shutdown);

  return { wss: dashboardWss, registry, agentSockets, dashboardWss, agentWss };
}

module.exports = { attachWsServer, sanitizeUrl, parseQuery, mintReconnectToken };
