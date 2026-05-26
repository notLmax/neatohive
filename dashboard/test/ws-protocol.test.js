'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { attachWsServer } = require('../lib/ws');
const { createChatBus } = require('../lib/chat-bus');

const TOKEN = 'a'.repeat(64);

async function startHarness(opts = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const bus = createChatBus();
  const { registry, wss } = attachWsServer(server, {
    token: TOKEN,
    bus,
    ringSize: opts.ringSize ?? 100,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const wsUrl = `ws://127.0.0.1:${port}/api/chat/ws`;

  return {
    server,
    registry,
    wss,
    bus,
    wsUrl,
    async close() {
      for (const client of wss.clients) {
        try {
          client.terminate();
        } catch {
          // Best-effort test cleanup.
        }
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function connectAndHello(wsUrl, queryAppend = '') {
  const ws = new WebSocket(`${wsUrl}?token=${TOKEN}${queryAppend ? '&' + queryAppend : ''}`);
  const nextFrame = createFrameReader(ws);
  const hello = await nextFrame();
  return { ws, hello, nextFrame };
}

function createFrameReader(ws) {
  const queue = [];
  const waiters = [];

  ws.on('message', (buf) => {
    const frame = JSON.parse(buf.toString('utf8'));
    if (waiters.length > 0) {
      waiters.shift()(frame);
      return;
    }
    queue.push(frame);
  });

  return function nextFrame() {
    if (queue.length > 0) {
      return Promise.resolve(queue.shift());
    }

    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  };
}

function send(ws, frame) {
  ws.send(JSON.stringify(frame));
}

async function closeSocket(ws) {
  if (ws.readyState === WebSocket.CLOSED) {
    return;
  }

  const closed = once(ws, 'close');
  ws.close();
  await closed;
}

test('attachWsServer throws when bus is missing or wrong shape', () => {
  const server = http.createServer();
  assert.throws(() => attachWsServer(server, { token: TOKEN }), /bus is required/);
  assert.throws(() => attachWsServer(server, { token: TOKEN, bus: {} }), /bus is required/);
  assert.throws(
    () => attachWsServer(server, { token: TOKEN, bus: { publish: () => {} } }),
    /bus is required/
  );

  const goodBus = createChatBus();
  assert.doesNotThrow(() => attachWsServer(server, { token: TOKEN, bus: goodBus }));
});

test('subscribe frame attaches bus subscriber and receives subsequent publishes', async () => {
  const h = await startHarness();
  try {
    const { ws, nextFrame } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    const sub = await nextFrame();
    assert.deepStrictEqual(sub, { type: 'subscribed', channel: 'agent-x' });

    h.bus.publish('agent-x', { id: 'msg-1', content: 'hello', source: 'test' });
    const msg = await nextFrame();
    assert.strictEqual(msg.type, 'message');
    assert.strictEqual(msg.channel, 'agent-x');
    assert.strictEqual(msg.sequence, 1);
    assert.strictEqual(msg.id, 'msg-1');
    assert.strictEqual(msg.content, 'hello');

    await closeSocket(ws);
  } finally {
    await h.close();
  }
});

test('send frame publishes a Decision C envelope to the bus', async () => {
  const h = await startHarness();
  try {
    const { ws } = await connectAndHello(h.wsUrl);
    const seen = [];
    h.bus.subscribe('hivemind', (msg) => seen.push(msg));

    send(ws, { type: 'send', channel: 'hivemind', content: 'from dashboard' });
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].channel, 'hivemind');
    assert.strictEqual(seen[0].source, 'dashboard');
    assert.strictEqual(seen[0].author_id, 'hive-owner');
    assert.strictEqual(seen[0].author_kind, 'user');
    assert.strictEqual(seen[0].content, 'from dashboard');
    assert.deepStrictEqual(seen[0].attachments, []);
    assert.deepStrictEqual(seen[0].metadata, {});
    assert.strictEqual(typeof seen[0].id, 'string');
    assert.strictEqual(typeof seen[0].source_message_id, 'string');
    assert.strictEqual(seen[0].sequence, 1);

    await closeSocket(ws);
  } finally {
    await h.close();
  }
});

test('subscribe is channel-isolated - no cross-channel leakage', async () => {
  const h = await startHarness();
  try {
    const { ws, nextFrame } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    await nextFrame();

    h.bus.publish('agent-y', { content: 'y-only' });
    h.bus.publish('agent-x', { content: 'x-only' });

    const msg = await nextFrame();
    assert.strictEqual(msg.channel, 'agent-x');
    assert.strictEqual(msg.content, 'x-only');

    ws.close();
    await once(ws, 'close');
  } finally {
    await h.close();
  }
});

test('multiple clients on same channel all receive the publish', async () => {
    const h = await startHarness();
  try {
    const a = await connectAndHello(h.wsUrl);
    const b = await connectAndHello(h.wsUrl);
    send(a.ws, { type: 'subscribe', channel: 'shared' });
    await a.nextFrame();
    send(b.ws, { type: 'subscribe', channel: 'shared' });
    await b.nextFrame();

    const aMsgPromise = a.nextFrame();
    const bMsgPromise = b.nextFrame();
    h.bus.publish('shared', { content: 'broadcast' });

    const [aMsg, bMsg] = await Promise.all([aMsgPromise, bMsgPromise]);
    assert.strictEqual(aMsg.content, 'broadcast');
    assert.strictEqual(bMsg.content, 'broadcast');
    assert.strictEqual(aMsg.sequence, bMsg.sequence);

    await Promise.all([closeSocket(a.ws), closeSocket(b.ws)]);
  } finally {
    await h.close();
  }
});

test('unsubscribe frame stops subsequent receipt and emits unsubscribed echo', async () => {
  const h = await startHarness();
  try {
    const { ws, nextFrame } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    await nextFrame();

    h.bus.publish('agent-x', { content: 'before' });
    const beforeMsg = await nextFrame();
    assert.strictEqual(beforeMsg.content, 'before');

    send(ws, { type: 'unsubscribe', channel: 'agent-x' });
    const unsub = await nextFrame();
    assert.deepStrictEqual(unsub, { type: 'unsubscribed', channel: 'agent-x' });

    h.bus.publish('agent-x', { content: 'after' });
    const state = [...h.registry.values()][0];
    assert.strictEqual(state.busUnsubscribes.has('agent-x'), false);

    await closeSocket(ws);
  } finally {
    await h.close();
  }
});

test('disconnect cleans up bus subscribers (no leak)', async () => {
  const h = await startHarness();
  try {
    const { ws, nextFrame } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    await nextFrame();

    const stateBefore = [...h.registry.values()][0];
    assert.strictEqual(stateBefore.busUnsubscribes.size, 1);

    await closeSocket(ws);
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.strictEqual(h.registry.size, 0);
    assert.doesNotThrow(() => h.bus.publish('agent-x', { content: 'post-close' }));
  } finally {
    await h.close();
  }
});

test('ack frame updates last_ack_seen for the channel', async () => {
  const h = await startHarness();
  try {
    const { ws, nextFrame } = await connectAndHello(h.wsUrl);
    send(ws, { type: 'subscribe', channel: 'agent-x' });
    await nextFrame();

    h.bus.publish('agent-x', { content: 'm1' });
    await nextFrame();
    h.bus.publish('agent-x', { content: 'm2' });
    await nextFrame();

    send(ws, { type: 'ack', channel: 'agent-x', sequence: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const state = [...h.registry.values()][0];
    assert.strictEqual(state.last_ack_seen.get('agent-x'), 2);

    send(ws, { type: 'ack', channel: 'agent-x', sequence: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(state.last_ack_seen.get('agent-x'), 2);

    await closeSocket(ws);
  } finally {
    await h.close();
  }
});

test('reconnect with valid reconnect_token restores subscriptions and replays unacked messages', async () => {
  const h = await startHarness();
  try {
    const c1 = await connectAndHello(h.wsUrl);
    const reconnectToken = c1.hello.reconnect_token;
    send(c1.ws, { type: 'subscribe', channel: 'agent-x' });
    await c1.nextFrame();

    h.bus.publish('agent-x', { content: 'one' });
    h.bus.publish('agent-x', { content: 'two' });
    h.bus.publish('agent-x', { content: 'three' });
    await c1.nextFrame();
    await c1.nextFrame();
    await c1.nextFrame();

    send(c1.ws, { type: 'ack', channel: 'agent-x', sequence: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    await closeSocket(c1.ws);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const c2 = await connectAndHello(h.wsUrl, `reconnect_token=${reconnectToken}`);
    assert.notStrictEqual(c2.hello.client_id, c1.hello.client_id);
    assert.notStrictEqual(c2.hello.reconnect_token, reconnectToken);

    const replay1 = await c2.nextFrame();
    const replay2 = await c2.nextFrame();
    assert.strictEqual(replay1.sequence, 2);
    assert.strictEqual(replay1.content, 'two');
    assert.strictEqual(replay2.sequence, 3);
    assert.strictEqual(replay2.content, 'three');

    await closeSocket(c2.ws);
  } finally {
    await h.close();
  }
});

test('reconnect with stale reconnect_token is treated as fresh connection (no replay)', async () => {
  const h = await startHarness();
  try {
    const c = await connectAndHello(h.wsUrl, 'reconnect_token=ff'.padEnd('reconnect_token='.length + 32, 'f'));
    assert.strictEqual(typeof c.hello.client_id, 'string');
    assert.strictEqual(typeof c.hello.reconnect_token, 'string');

    await closeSocket(c.ws);
  } finally {
    await h.close();
  }
});

test('malformed frames emit error frame but do not close the socket', async () => {
  const h = await startHarness();
  try {
    const { ws, nextFrame } = await connectAndHello(h.wsUrl);

    ws.send('not-json-at-all');
    const err1 = await nextFrame();
    assert.strictEqual(err1.type, 'error');
    assert.strictEqual(err1.code, 'bad_json');

    send(ws, { channel: 'x' });
    const err2 = await nextFrame();
    assert.strictEqual(err2.type, 'error');
    assert.strictEqual(err2.code, 'bad_frame');

    send(ws, { type: 'no-such-type' });
    const err3 = await nextFrame();
    assert.strictEqual(err3.type, 'error');
    assert.strictEqual(err3.code, 'bad_type');

    send(ws, { type: 'subscribe', channel: '' });
    const err4 = await nextFrame();
    assert.strictEqual(err4.code, 'bad_channel');

    send(ws, { type: 'subscribe', channel: '*' });
    const err5 = await nextFrame();
    assert.strictEqual(err5.code, 'bad_channel');

    send(ws, { type: 'ack', channel: 'x', sequence: 'three' });
    const err6 = await nextFrame();
    assert.strictEqual(err6.code, 'bad_frame');

    assert.strictEqual(ws.readyState, WebSocket.OPEN);
    await closeSocket(ws);
  } finally {
    await h.close();
  }
});
