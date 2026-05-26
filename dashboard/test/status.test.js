'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../app');

const TEST_TOKEN = 'd'.repeat(64);

async function startTestApp(overrides = {}) {
  const previous = process.env.DASHBOARD_REQUIRE_AUTH;
  process.env.DASHBOARD_REQUIRE_AUTH = overrides.authRequired ? 'true' : 'false';
  const app = createApp({
    token: TEST_TOKEN,
    pm2: overrides.pm2 || {
      async listProcesses() {
        return [];
      },
    },
    runnerEvents: overrides.runnerEvents || {
      async readLastN() {
        return [];
      },
      async readAll() {
        return [];
      },
    },
    listAgents: overrides.listAgents || (() => []),
    frameworkRoot: overrides.frameworkRoot || '/Users/glados/neato-hive',
  });
  if (previous === undefined) {
    delete process.env.DASHBOARD_REQUIRE_AUTH;
  } else {
    process.env.DASHBOARD_REQUIRE_AUTH = previous;
  }

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function authHeaders() {
  return { Authorization: `Bearer ${TEST_TOKEN}` };
}

test('GET /api/status returns expected envelope shape', async () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', agent: 'bob-the-builder', event: 'wake_turn_started', taskId: 't2' },
  ];
  const { server, baseUrl } = await startTestApp({
    pm2: {
      async listProcesses() {
        return [
          { name: 'atlas', pm2_env: { status: 'online' } },
          { name: 'bob-the-builder', pm2_env: { status: 'errored' } },
        ];
      },
    },
    runnerEvents: {
      async readLastN() {
        return events;
      },
      async readAll() {
        return events;
      },
    },
    listAgents: () => ['atlas', 'bob-the-builder'],
  });

  try {
    const res = await fetch(`${baseUrl}/api/status`, { headers: authHeaders() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.version, '1');
    assert.deepStrictEqual(body.agents.by_state, { idle: 0, turn: 1, task: 1 });
    assert.strictEqual(body.pm2.online, 1);
    assert.strictEqual(body.pm2.errored, 1);
    assert.deepStrictEqual(body.recent_events, events);
  } finally {
    await close(server);
  }
});

test('GET /api/status recent events are limited to 20', async () => {
  const recentEvents = Array.from({ length: 20 }, (_, index) => ({
    ts: `2026-05-07T00:00:${String(index).padStart(2, '0')}.000Z`,
    event: 'discovered',
    agent: 'atlas',
    taskId: `t${index}`,
  }));
  const { server, baseUrl } = await startTestApp({
    runnerEvents: {
      async readLastN(limit) {
        assert.strictEqual(limit, 20);
        return recentEvents;
      },
      async readAll() {
        return [];
      },
    },
  });

  try {
    const res = await fetch(`${baseUrl}/api/status`, { headers: authHeaders() });
    const body = await res.json();
    assert.strictEqual(body.recent_events.length, 20);
  } finally {
    await close(server);
  }
});

test('GET /api/status soft-fails pm2 errors', async () => {
  const { server, baseUrl } = await startTestApp({
    pm2: {
      async listProcesses() {
        throw new Error('pm2 unavailable');
      },
    },
    listAgents: () => ['atlas', 'bob-the-builder'],
  });

  try {
    const res = await fetch(`${baseUrl}/api/status`, { headers: authHeaders() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.pm2.error, 'pm2 unavailable');
    assert.deepStrictEqual(body.agents.by_state, { idle: 2, turn: 0, task: 0 });
  } finally {
    await close(server);
  }
});

test('GET /api/status is reachable without auth when auth is disabled', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(res.status, 200);
  } finally {
    await close(server);
  }
});

test('GET /api/status requires auth when enabled', async () => {
  const { server, baseUrl } = await startTestApp({ authRequired: true });

  try {
    const res = await fetch(`${baseUrl}/api/status`);
    assert.strictEqual(res.status, 401);
  } finally {
    await close(server);
  }
});

test('GET /api/status succeeds with auth when enabled', async () => {
  const { server, baseUrl } = await startTestApp({ authRequired: true });

  try {
    const res = await fetch(`${baseUrl}/api/status`, { headers: authHeaders() });
    assert.strictEqual(res.status, 200);
  } finally {
    await close(server);
  }
});
