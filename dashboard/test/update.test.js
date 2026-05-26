'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createUpdateClient } = require('../lib/update');

test('check returns parsed envelope when update is available', async () => {
  const envelope = { update_available: true, remote_version: '1.5.0' };
  const client = createUpdateClient({
    spawnSyncFn: () => ({ status: 0, stdout: JSON.stringify(envelope), stderr: '' }),
  });

  assert.deepStrictEqual(await client.check(), envelope);
});

test('check returns parsed envelope when already current', async () => {
  const envelope = { update_available: false, local_version: '1.5.0', remote_version: '1.5.0' };
  const client = createUpdateClient({
    spawnSyncFn: () => ({ status: 0, stdout: JSON.stringify(envelope), stderr: '' }),
  });

  assert.deepStrictEqual(await client.check(), envelope);
});

test('check returns parsed envelope for null update_available error state', async () => {
  const envelope = { update_available: null, error: 'offline', local_version: '1.4.9' };
  const client = createUpdateClient({
    spawnSyncFn: () => ({ status: 1, stdout: JSON.stringify(envelope), stderr: 'fetch failed' }),
  });

  assert.deepStrictEqual(await client.check(), envelope);
});

test('check cache hit within ttl avoids re-spawn', async () => {
  let calls = 0;
  const client = createUpdateClient({
    ttlMs: 1000,
    spawnSyncFn: () => {
      calls += 1;
      return { status: 0, stdout: '{"update_available":false}', stderr: '' };
    },
  });

  await client.check();
  await client.check();

  assert.strictEqual(calls, 1);
});

test('check cache miss after ttl re-spawns', async () => {
  let calls = 0;
  const client = createUpdateClient({
    ttlMs: 5,
    spawnSyncFn: () => {
      calls += 1;
      return { status: 0, stdout: JSON.stringify({ update_available: false, call: calls }), stderr: '' };
    },
  });

  const first = await client.check();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await client.check();

  assert.strictEqual(calls, 2);
  assert.notDeepStrictEqual(first, second);
});

test('clearCheckCache invalidates the cache', async () => {
  let calls = 0;
  const client = createUpdateClient({
    ttlMs: 1000,
    spawnSyncFn: () => {
      calls += 1;
      return { status: 0, stdout: JSON.stringify({ update_available: false, call: calls }), stderr: '' };
    },
  });

  const first = await client.check();
  client.clearCheckCache();
  const second = await client.check();

  assert.strictEqual(calls, 2);
  assert.notDeepStrictEqual(first, second);
});

test('apply spawns hive update --yes detached', async () => {
  const calls = [];
  const client = createUpdateClient({
    cwd: '/tmp/framework',
    stateFile: {
      findNewerThan() {
        return 'abc123';
      },
    },
    spawnFn: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { unrefCalled: false, unref() { this.unrefCalled = true; } };
    },
  });

  await client.apply();

  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], {
    cmd: 'hive',
    args: ['update', '--yes'],
    options: {
      detached: true,
      stdio: 'ignore',
      cwd: '/tmp/framework',
    },
  });
});

test('apply returns update_id and started_at when state file is discovered', async () => {
  let checks = 0;
  const clock = { now: 1_700_000_000_000 };
  const child = { unref() {} };
  const client = createUpdateClient({
    stateFile: {
      findNewerThan(beforeTs) {
        checks += 1;
        assert.strictEqual(beforeTs, clock.now);
        return checks === 2 ? 'update-42' : null;
      },
    },
    spawnFn: () => child,
    now: () => clock.now,
    sleep: async () => {},
  });

  const result = await client.apply();

  assert.deepStrictEqual(result, {
    update_id: 'update-42',
    started_at: new Date(clock.now).toISOString(),
  });
});

test('apply polls every 100ms up to 5s', async () => {
  let current = 10_000;
  const sleeps = [];
  let checks = 0;
  const client = createUpdateClient({
    stateFile: {
      findNewerThan() {
        checks += 1;
        return null;
      },
    },
    spawnFn: () => ({ unref() {} }),
    now: () => current,
    sleep: async (ms) => {
      sleeps.push(ms);
      current += ms;
    },
  });

  await assert.rejects(() => client.apply(), (err) => {
    assert.strictEqual(err.code, 'UPDATE_ID_NOT_DISCOVERED');
    return true;
  });

  assert.strictEqual(checks, 50);
  assert.strictEqual(sleeps.length, 50);
  assert.ok(sleeps.every((ms) => ms === 100));
});

test('apply throws UPDATE_ID_NOT_DISCOVERED when no new state file appears within 5s', async () => {
  let current = 20_000;
  const client = createUpdateClient({
    stateFile: {
      findNewerThan() {
        return null;
      },
    },
    spawnFn: () => ({ unref() {} }),
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  });

  await assert.rejects(() => client.apply(), (err) => {
    assert.strictEqual(err.code, 'UPDATE_ID_NOT_DISCOVERED');
    assert.match(err.message, /did not create a state file within 5s/);
    return true;
  });
});
