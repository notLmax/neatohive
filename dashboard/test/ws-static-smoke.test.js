'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { WebSocket } = require('ws');
const { attachWsServer } = require('../lib/ws');
const { createChatBus } = require('../lib/chat-bus');

const TOKEN = 'c'.repeat(64);

test('WS smoke: unauthorized upgrade gets 401 and authorized dashboard client receives bus fanout', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  });
  const bus = createChatBus();
  const previous = process.env.DASHBOARD_REQUIRE_AUTH;
  process.env.DASHBOARD_REQUIRE_AUTH = 'true';
  const handle = attachWsServer(server, { token: TOKEN, bus, ringSize: 10 });
  if (previous === undefined) {
    delete process.env.DASHBOARD_REQUIRE_AUTH;
  } else {
    process.env.DASHBOARD_REQUIRE_AUTH = previous;
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const wsUrl = `ws://127.0.0.1:${port}/ws/dashboard`;

  try {
    const unauthorized = await new Promise((resolve, reject) => {
      const client = new WebSocket(wsUrl);
      client.once('unexpected-response', (_req, response) => {
        const { statusCode } = response;
        response.resume();
        response.destroy();
        resolve(statusCode);
      });
      client.once('open', () => reject(new Error('unexpected open for unauthorized request')));
      client.once('error', () => {
        // expected on rejected handshake
      });
    });
    assert.strictEqual(unauthorized, 401);

    const client = new WebSocket(`${wsUrl}?token=${TOKEN}`);
    const frames = [];
    client.on('message', (buffer) => {
      frames.push(JSON.parse(buffer.toString('utf8')));
    });

    await new Promise((resolve, reject) => {
      client.once('open', resolve);
      client.once('error', reject);
    });
    await waitFor(() => frames.some((frame) => frame.type === 'hello'));

    client.send(JSON.stringify({ kind: 'subscribe', channel: 'dashboard:atlas' }));
    await waitFor(() => frames.some((frame) => frame.type === 'subscribed' && frame.channel === 'dashboard:atlas'));

    bus.publish('dashboard:atlas', {
      type: 'user_message',
      source: 'discord',
      text: 'pong',
      channelKey: 'dashboard:atlas',
      ts: Date.now(),
    });

    await waitFor(() => frames.some((frame) => frame.type === 'message' && frame.text === 'pong'));

    client.close();
    await new Promise((resolve) => client.once('close', resolve));
  } finally {
    for (const client of handle.wss.clients) {
      client.terminate();
    }
    for (const client of handle.agentWss.clients) {
      client.terminate();
    }
    handle.wss.close();
    handle.agentWss.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for condition');
}
