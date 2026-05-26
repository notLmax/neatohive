'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createPm2Client } = require('../lib/pm2');

test('listProcesses returns parsed JSON output', async () => {
  const client = createPm2Client({
    spawn: () => ({ status: 0, stdout: '[{"name":"atlas"}]', stderr: '' }),
  });

  const processes = await client.listProcesses();

  assert.deepStrictEqual(processes, [{ name: 'atlas' }]);
});

test('listProcesses caches within ttl', async () => {
  let calls = 0;
  const client = createPm2Client({
    ttlMs: 1000,
    spawn: () => {
      calls += 1;
      return { status: 0, stdout: '[{"name":"atlas"}]', stderr: '' };
    },
  });

  await client.listProcesses();
  await client.listProcesses();

  assert.strictEqual(calls, 1);
});

test('listProcesses refetches after ttl expiry', async () => {
  let calls = 0;
  const client = createPm2Client({
    ttlMs: 5,
    spawn: () => {
      calls += 1;
      return { status: 0, stdout: `[{"call":${calls}}]`, stderr: '' };
    },
  });

  const first = await client.listProcesses();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await client.listProcesses();

  assert.strictEqual(calls, 2);
  assert.notDeepStrictEqual(first, second);
});

test('concurrent listProcesses calls coalesce into one spawn', async () => {
  let calls = 0;
  const client = createPm2Client({
    spawn: () => {
      calls += 1;
      return { status: 0, stdout: '[{"name":"atlas"}]', stderr: '' };
    },
  });

  const [first, second, third] = await Promise.all([
    client.listProcesses(),
    client.listProcesses(),
    client.listProcesses(),
  ]);

  assert.strictEqual(calls, 1);
  assert.deepStrictEqual(first, second);
  assert.deepStrictEqual(second, third);
});

test('listProcesses rejects on non-zero exit', async () => {
  const client = createPm2Client({
    spawn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
  });

  await assert.rejects(() => client.listProcesses(), /pm2 jlist failed: rc=1 stderr=boom/);
});

test('restartProcess invokes restart with the provided name', () => {
  const calls = [];
  const client = createPm2Client({
    spawn: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0, stdout: '', stderr: '' };
    },
  });

  const result = client.restartProcess('atlas');

  assert.deepStrictEqual(result, { name: 'atlas', restarted: true });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], {
    cmd: 'pm2',
    args: ['restart', 'atlas'],
    options: { encoding: 'utf8', timeout: 10000 },
  });
});

test('restartProcess invalidates the cache', async () => {
  let phase = 'list';
  let calls = 0;
  const client = createPm2Client({
    spawn: (cmd, args) => {
      calls += 1;
      if (args[0] === 'restart') {
        phase = 'after-restart';
        return { status: 0, stdout: '', stderr: '' };
      }
      if (phase === 'list') {
        return { status: 0, stdout: '[{"name":"atlas","generation":1}]', stderr: '' };
      }
      return { status: 0, stdout: '[{"name":"atlas","generation":2}]', stderr: '' };
    },
  });

  const first = await client.listProcesses();
  client.restartProcess('atlas');
  const second = await client.listProcesses();

  assert.strictEqual(calls, 3);
  assert.notDeepStrictEqual(first, second);
});

test('restartProcess throws tagged error on non-zero exit', () => {
  const client = createPm2Client({
    spawn: () => ({ status: 2, stdout: '', stderr: 'restart failed' }),
  });

  assert.throws(() => client.restartProcess('atlas'), (err) => {
    assert.strictEqual(err.code, 'PM2_RESTART_FAILED');
    assert.match(err.message, /rc=2/);
    assert.match(err.message, /restart failed/);
    return true;
  });
});
