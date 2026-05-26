'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createApp } = require('../app');

const TEST_TOKEN = 'd'.repeat(64);

async function startTestApp(overrides = {}) {
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
    backups: overrides.backups || {
      listBackups() {
        return { backups: [], total: 0 };
      },
    },
    listAgents: overrides.listAgents || (() => []),
    frameworkRoot: overrides.frameworkRoot || '/Users/glados/neato-hive',
  });

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

test('GET /api/runner-events returns the expected envelope shape', async () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', event: 'exit', taskId: 't1' },
  ];
  const { server, baseUrl } = await startTestApp({
    runnerEvents: {
      async readLastN() {
        return [];
      },
      async readAll() {
        return events;
      },
    },
  });

  try {
    const res = await fetch(`${baseUrl}/api/runner-events`, { headers: authHeaders() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.version, '1');
    assert.strictEqual(body.total, 2);
    assert.strictEqual(body.limit, 100);
    assert.strictEqual(body.offset, 0);
    assert.deepStrictEqual(body.events, events.slice().reverse());
  } finally {
    await close(server);
  }
});

test('GET /api/runner-events returns events most-recent-first', async () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', event: 'one', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', event: 'two', taskId: 't1' },
    { ts: '2026-05-07T00:02:00.000Z', event: 'three', taskId: 't1' },
  ];
  const { server, baseUrl } = await startTestApp({
    runnerEvents: {
      async readLastN() {
        return [];
      },
      async readAll() {
        return events;
      },
    },
  });

  try {
    const res = await fetch(`${baseUrl}/api/runner-events`, { headers: authHeaders() });
    const body = await res.json();
    assert.deepStrictEqual(body.events.map((event) => event.event), ['three', 'two', 'one']);
  } finally {
    await close(server);
  }
});

test('GET /api/runner-events uses default limit and offset', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/runner-events`, { headers: authHeaders() });
    const body = await res.json();
    assert.strictEqual(body.limit, 100);
    assert.strictEqual(body.offset, 0);
  } finally {
    await close(server);
  }
});

test('GET /api/runner-events rejects limit=0', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/runner-events?limit=0`, { headers: authHeaders() });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(await res.json(), { error: 'bad_limit', detail: 'limit must be 1..1000' });
  } finally {
    await close(server);
  }
});

test('GET /api/runner-events rejects limit=1001', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/runner-events?limit=1001`, { headers: authHeaders() });
    assert.strictEqual(res.status, 400);
    assert.deepStrictEqual(await res.json(), { error: 'bad_limit', detail: 'limit must be 1..1000' });
  } finally {
    await close(server);
  }
});
