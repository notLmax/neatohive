'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../app');

const TEST_TOKEN = 'e'.repeat(64);

async function startTestApp(overrides = {}) {
  const app = createApp({
    token: TEST_TOKEN,
    pm2: overrides.client || {
      async listProcesses() {
        return [];
      },
      restartProcess() {},
    },
    runnerEvents: overrides.runnerEvents || {
      async readLastN() {
        return [];
      },
      async readAll() {
        return [];
      },
    },
    listAgents: overrides.listAgents || (() => ['atlas']),
    frameworkRoot: '/Users/glados/neato-hive',
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

function sampleEvents() {
  return [
    { ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', agent: 'atlas', event: 'wake_archived', taskId: 't1' },
    { ts: '2026-05-07T00:02:00.000Z', agent: 'bob-the-builder', event: 'wake_turn_started', taskId: 't2' },
  ];
}

test('GET /api/agents returns current_activity per agent', async () => {
  const { server, baseUrl } = await startTestApp({
    client: {
      async listProcesses() {
        return [
          { name: 'atlas', pm2_env: { status: 'online' } },
          { name: 'bob-the-builder', pm2_env: { status: 'online' } },
        ];
      },
      restartProcess() {},
    },
    runnerEvents: {
      async readAll() {
        return sampleEvents();
      },
    },
    listAgents: () => ['atlas', 'bob-the-builder'],
  });

  try {
    const res = await fetch(`${baseUrl}/api/agents`, { headers: authHeaders() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.agents.length, 2);
    assert.deepStrictEqual(body.agents[0].current_activity, {
      state: 'task',
      task_id: 't1',
      since: '2026-05-07T00:00:00.000Z',
    });
    assert.deepStrictEqual(body.agents[1].current_activity, {
      state: 'turn',
      task_id: 't2',
      since: '2026-05-07T00:02:00.000Z',
    });
  } finally {
    await close(server);
  }
});

test('GET /api/agents/:name returns 404 when agent is not declared', async () => {
  const { server, baseUrl } = await startTestApp({ listAgents: () => ['atlas'] });

  try {
    const res = await fetch(`${baseUrl}/api/agents/missing`, { headers: authHeaders() });
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error, 'agent_not_found');
  } finally {
    await close(server);
  }
});

test('GET /api/agents/:name returns detail payload', async () => {
  const now = Date.now();
  const { server, baseUrl } = await startTestApp({
    client: {
      async listProcesses() {
        return [{
          name: 'atlas',
          pid: 1234,
          monit: { cpu: 0.4, memory: 7890 },
          pm2_env: { status: 'online', pm_uptime: now - 5000, restart_time: 2 },
        }];
      },
      restartProcess() {},
    },
    runnerEvents: {
      async readAll() {
        return sampleEvents();
      },
    },
  });

  try {
    const res = await fetch(`${baseUrl}/api/agents/atlas`, { headers: authHeaders() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.name, 'atlas');
    assert.strictEqual(body.pm2.status, 'online');
    assert.strictEqual(body.pm2.pid, 1234);
    assert.strictEqual(body.pm2.cpu_percent, 0.4);
    assert.strictEqual(body.pm2.memory_bytes, 7890);
    assert.strictEqual(body.pm2.restart_count, 2);
    assert.strictEqual(body.current_activity.state, 'task');
    assert.ok(Array.isArray(body.recent_events));
  } finally {
    await close(server);
  }
});

test('GET /api/agents/:name recent_events are filtered to the requested agent', async () => {
  const { server, baseUrl } = await startTestApp({
    runnerEvents: {
      async readAll() {
        return sampleEvents();
      },
    },
  });

  try {
    const res = await fetch(`${baseUrl}/api/agents/atlas`, { headers: authHeaders() });
    const body = await res.json();
    assert.ok(body.recent_events.every((event) => event.agent === 'atlas'));
  } finally {
    await close(server);
  }
});

test('POST /api/agents/:name/restart returns restarted true on success', async () => {
  const calls = [];
  const { server, baseUrl } = await startTestApp({
    client: {
      async listProcesses() {
        return [{ name: 'atlas', pm2_env: { status: 'online' } }];
      },
      restartProcess(name) {
        calls.push(name);
      },
    },
  });

  try {
    const res = await fetch(`${baseUrl}/api/agents/atlas/restart`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.strictEqual(body.restarted, true);
    assert.deepStrictEqual(calls, ['atlas']);
  } finally {
    await close(server);
  }
});

test('POST /api/agents/:name/restart calls restartProcess exactly once', async () => {
  let calls = 0;
  const { server, baseUrl } = await startTestApp({
    client: {
      async listProcesses() {
        return [{ name: 'atlas', pm2_env: { status: 'online' } }];
      },
      restartProcess() {
        calls += 1;
      },
    },
  });

  try {
    await fetch(`${baseUrl}/api/agents/atlas/restart`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.strictEqual(calls, 1);
  } finally {
    await close(server);
  }
});

test('POST /api/agents/:name/restart returns 404 when agent is not declared', async () => {
  const { server, baseUrl } = await startTestApp({ listAgents: () => ['atlas'] });

  try {
    const res = await fetch(`${baseUrl}/api/agents/missing/restart`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error, 'agent_not_found');
  } finally {
    await close(server);
  }
});

test('POST /api/agents/:name/restart returns 404 when declared but not in process list', async () => {
  const { server, baseUrl } = await startTestApp({
    client: {
      async listProcesses() {
        return [];
      },
      restartProcess() {},
    },
  });

  try {
    const res = await fetch(`${baseUrl}/api/agents/atlas/restart`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.strictEqual(res.status, 404);
    const body = await res.json();
    assert.strictEqual(body.error, 'agent_not_in_pm2');
  } finally {
    await close(server);
  }
});

test('POST /api/agents/:name/restart returns 500 when restart fails', async () => {
  const { server, baseUrl } = await startTestApp({
    client: {
      async listProcesses() {
        return [{ name: 'atlas', pm2_env: { status: 'online' } }];
      },
      restartProcess() {
        throw new Error('restart exploded');
      },
    },
  });

  try {
    const res = await fetch(`${baseUrl}/api/agents/atlas/restart`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert.strictEqual(res.status, 500);
    const body = await res.json();
    assert.strictEqual(body.error, 'pm2_restart_failed');
  } finally {
    await close(server);
  }
});

test('GET /api/agents/:name/logs returns stdout and stderr arrays', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd2-logs-'));
  const outPath = path.join(tmpDir, 'atlas-out.log');
  const errPath = path.join(tmpDir, 'atlas-error.log');
  fs.writeFileSync(outPath, 'line 1\nline 2\n');
  fs.writeFileSync(errPath, 'err 1\n');

  const { server, baseUrl } = await startTestApp({
    client: {
      async listProcesses() {
        return [{
          name: 'atlas',
          pm2_env: {
            status: 'online',
            pm_out_log_path: outPath,
            pm_err_log_path: errPath,
          },
        }];
      },
      restartProcess() {},
    },
  });

  try {
    const res = await fetch(`${baseUrl}/api/agents/atlas/logs`, { headers: authHeaders() });
    assert.strictEqual(res.status, 200);
    const body = await res.json();
    assert.deepStrictEqual(body.stdout, ['line 1', 'line 2']);
    assert.deepStrictEqual(body.stderr, ['err 1']);
  } finally {
    await close(server);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GET /api/agents/:name/logs?lines=0 returns 400', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/agents/atlas/logs?lines=0`, { headers: authHeaders() });
    assert.strictEqual(res.status, 400);
  } finally {
    await close(server);
  }
});

test('GET /api/agents/:name/logs?lines=1001 returns 400', async () => {
  const { server, baseUrl } = await startTestApp();

  try {
    const res = await fetch(`${baseUrl}/api/agents/atlas/logs?lines=1001`, { headers: authHeaders() });
    assert.strictEqual(res.status, 400);
  } finally {
    await close(server);
  }
});
