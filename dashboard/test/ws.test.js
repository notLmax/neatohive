'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { once } = require('node:events');
const { attachWsServer, mintReconnectToken, parseQuery, sanitizeUrl } = require('../lib/ws');
const { createChatBus } = require('../lib/chat-bus');
const { WebSocket } = require('ws');

test('sanitizeUrl redacts token AND reconnect_token query params', () => {
  assert.strictEqual(sanitizeUrl('/api/chat/ws?token=abc123'), '/api/chat/ws?token=<REDACTED>');
  assert.strictEqual(
    sanitizeUrl('/api/chat/ws?token=foo&channel=bar'),
    '/api/chat/ws?token=<REDACTED>&channel=bar'
  );
  assert.strictEqual(sanitizeUrl('/api/chat/ws'), '/api/chat/ws');
  assert.strictEqual(sanitizeUrl(null), '');
  assert.strictEqual(
    sanitizeUrl('/api/chat/ws?reconnect_token=deadbeef'),
    '/api/chat/ws?reconnect_token=<REDACTED>'
  );
  assert.strictEqual(
    sanitizeUrl('/api/chat/ws?token=abc&reconnect_token=def'),
    '/api/chat/ws?token=<REDACTED>&reconnect_token=<REDACTED>'
  );
  assert.strictEqual(
    sanitizeUrl('/api/chat/ws?reconnect_token=def&token=abc'),
    '/api/chat/ws?reconnect_token=<REDACTED>&token=<REDACTED>'
  );
});

test('parseQuery extracts URL query params', () => {
  assert.deepStrictEqual(parseQuery('/api/chat/ws?token=abc&channel=hivemind'), {
    token: 'abc',
    channel: 'hivemind',
  });
  assert.deepStrictEqual(parseQuery('/path-no-query'), {});
  assert.deepStrictEqual(parseQuery('/api/chat/ws?token=&empty='), { token: '', empty: '' });
});

test('mintReconnectToken returns unique 32-char hex tokens', () => {
  const first = mintReconnectToken();
  const second = mintReconnectToken();

  assert.match(first, /^[a-f0-9]{32}$/);
  assert.match(second, /^[a-f0-9]{32}$/);
  assert.notStrictEqual(first, second);
});

test('WS accepts unauthenticated dashboard clients when auth is disabled', async () => {
  const harness = await startHarness('a'.repeat(64), { authRequired: false });

  try {
    const client = new WebSocket(`${harness.wsUrl}`);
    const [message] = await once(client, 'message');
    const hello = JSON.parse(message.toString('utf8'));
    assert.strictEqual(hello.type, 'hello');
    client.close(1000, 'done');
    await once(client, 'close');
  } finally {
    await harness.close();
  }
});

test('WS auth fails without token when auth is enabled', async () => {
  const harness = await startHarness('a'.repeat(64), { authRequired: true });

  try {
    const response = await unexpectedResponse(`${harness.wsUrl}`);
    assert.strictEqual(response.statusCode, 401);
  } finally {
    await harness.close();
  }
});

test('WS auth fails with wrong token when auth is enabled', async () => {
  const harness = await startHarness('a'.repeat(64), { authRequired: true });

  try {
    const response = await unexpectedResponse(`${harness.wsUrl}?token=wrong`);
    assert.strictEqual(response.statusCode, 401);
  } finally {
    await harness.close();
  }
});

test('WS auth passes and sends hello frame when auth is enabled', async () => {
  const token = 'a'.repeat(64);
  const harness = await startHarness(token, { authRequired: true });

  try {
    const client = new WebSocket(`${harness.wsUrl}?token=${token}`);
    const [message] = await once(client, 'message');
    const hello = JSON.parse(message.toString('utf8'));

    assert.strictEqual(hello.type, 'hello');
    assert.match(hello.client_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.match(hello.reconnect_token, /^[a-f0-9]{32}$/);
    assert.strictEqual(harness.registry.has(hello.client_id), true);

    client.close(1000, 'done');
    await once(client, 'close');
  } finally {
    await harness.close();
  }
});

async function startHarness(token, { authRequired = false } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
  });
  const bus = createChatBus();
  const previous = process.env.DASHBOARD_REQUIRE_AUTH;
  process.env.DASHBOARD_REQUIRE_AUTH = authRequired ? 'true' : 'false';
  const { registry, wss } = attachWsServer(server, { token, bus });
  if (previous === undefined) {
    delete process.env.DASHBOARD_REQUIRE_AUTH;
  } else {
    process.env.DASHBOARD_REQUIRE_AUTH = previous;
  }

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  const wsUrl = `ws://127.0.0.1:${address.port}/api/chat/ws`;

  return {
    bus,
    registry,
    wss,
    wsUrl,
    async close() {
      for (const client of wss.clients) {
        client.terminate();
      }

      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function unexpectedResponse(url) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(url);
    client.once('unexpected-response', (_req, response) => resolve(response));
    client.once('open', () => reject(new Error('expected unauthorized handshake failure')));
    client.once('error', () => {
      // expected when the handshake is rejected
    });
  });
}
