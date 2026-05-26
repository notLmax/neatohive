'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../app');

const TEST_TOKEN = 'a'.repeat(64);

async function startTestApp({ authRequired = false, token = TEST_TOKEN } = {}) {
  const previous = process.env.DASHBOARD_REQUIRE_AUTH;
  process.env.DASHBOARD_REQUIRE_AUTH = authRequired ? 'true' : 'false';
  const app = createApp({ token });
  if (previous === undefined) {
    delete process.env.DASHBOARD_REQUIRE_AUTH;
  } else {
    process.env.DASHBOARD_REQUIRE_AUTH = previous;
  }

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('GET /api/health → 200 + json without auth', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(typeof body.uptime_s, 'number');
    assert.ok(typeof body.version === 'string' && body.version.length > 0);
    assert.ok(typeof body.ts === 'string' && body.ts.endsWith('Z'));
  } finally {
    await close(server);
  }
});

test('GET /api/health → 200 even with bogus auth header (auth bypassed)', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.strictEqual(res.status, 200);
  } finally {
    await close(server);
  }
});

test('GET /api/auth-config reports auth disabled by default', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/auth-config`);
    assert.strictEqual(res.status, 200);

    const body = await res.json();
    assert.deepStrictEqual(body, { required: false });
  } finally {
    await close(server);
  }
});

test('GET /api/unknown → 404 when auth is disabled', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/unknown`);
    assert.strictEqual(res.status, 404);

    const body = await res.json();
    assert.strictEqual(body.error, 'not_found');
    assert.strictEqual(body.path, '/api/unknown');
  } finally {
    await close(server);
  }
});

test('GET /api/unknown → 401 when auth is enabled', async () => {
  const { server, baseUrl } = await startTestApp({ authRequired: true });

  try {
    const res = await fetch(`${baseUrl}/api/unknown`);
    assert.strictEqual(res.status, 401);

    const body = await res.json();
    assert.strictEqual(body.error, 'unauthorized');
  } finally {
    await close(server);
  }
});

test('GET /api/unknown with valid token → 404 when auth is enabled', async () => {
  const { server, baseUrl } = await startTestApp({ authRequired: true });

  try {
    const res = await fetch(`${baseUrl}/api/unknown`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.strictEqual(res.status, 404);

    const body = await res.json();
    assert.strictEqual(body.error, 'not_found');
    assert.strictEqual(body.path, '/api/unknown');
  } finally {
    await close(server);
  }
});
