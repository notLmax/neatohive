'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createApp } = require('../app');

const TEST_TOKEN = 'f'.repeat(64);

async function startTestApp() {
  const previous = process.env.DASHBOARD_REQUIRE_AUTH;
  process.env.DASHBOARD_REQUIRE_AUTH = 'false';
  const app = createApp({
    token: TEST_TOKEN,
    frameworkRoot: path.resolve(__dirname, '..', '..'),
    pm2: {
      async listProcesses() {
        return [];
      },
    },
    runnerEvents: {
      async readLastN() {
        return [];
      },
      async readAll() {
        return [];
      },
    },
    listAgents: () => [],
  });
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

function authHeaders() {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

test('GET / returns static overview html without auth', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const response = await fetch(baseUrl + '/');
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    assert.match(await response.text(), /<title>Overview/i);
  } finally {
    await close(server);
  }
});

test('GET /login.html returns static login html without auth', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const response = await fetch(baseUrl + '/login.html');
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
  } finally {
    await close(server);
  }
});

test('GET /css/dashboard.css returns static css', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const response = await fetch(baseUrl + '/css/dashboard.css');
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/css/);
  } finally {
    await close(server);
  }
});

test('GET /js/auth.js returns static javascript', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const response = await fetch(baseUrl + '/js/auth.js');
    assert.strictEqual(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /(application|text)\/javascript/);
  } finally {
    await close(server);
  }
});

test('GET /api/status with valid token still returns 200', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const response = await fetch(baseUrl + '/api/status', { headers: authHeaders() });
    assert.strictEqual(response.status, 200);
  } finally {
    await close(server);
  }
});

test('GET /api/auth-config returns auth-disabled config without auth', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const response = await fetch(baseUrl + '/api/auth-config');
    assert.strictEqual(response.status, 200);
    assert.deepStrictEqual(await response.json(), { required: false });
  } finally {
    await close(server);
  }
});

test('GET /api/health still returns 200 without auth', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const response = await fetch(baseUrl + '/api/health');
    assert.strictEqual(response.status, 200);
  } finally {
    await close(server);
  }
});
