'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createDoctorClient } = require('../lib/doctor');

test('getJson returns parsed envelope when spawn returns valid JSON', async () => {
  const expected = { version: '1', summary: { pass: 1 } };
  const client = createDoctorClient({
    spawn: () => ({ status: 0, stdout: JSON.stringify(expected), stderr: '' }),
  });

  const actual = await client.getJson();

  assert.deepStrictEqual(actual, expected);
});

test('cache hit within ttl avoids re-spawn', async () => {
  let calls = 0;
  const client = createDoctorClient({
    ttlMs: 1000,
    spawn: () => {
      calls += 1;
      return { status: 0, stdout: '{"version":"1"}', stderr: '' };
    },
  });

  await client.getJson();
  await client.getJson();

  assert.strictEqual(calls, 1);
});

test('cache miss after ttl re-spawns', async () => {
  let calls = 0;
  const client = createDoctorClient({
    ttlMs: 5,
    spawn: () => {
      calls += 1;
      return { status: 0, stdout: JSON.stringify({ version: '1', call: calls }), stderr: '' };
    },
  });

  const first = await client.getJson();
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await client.getJson();

  assert.strictEqual(calls, 2);
  assert.notDeepStrictEqual(first, second);
});

test('spawn returning empty stdout and non-zero exit rejects', async () => {
  const client = createDoctorClient({
    spawn: () => ({ status: 1, stdout: '', stderr: 'boom' }),
  });

  await assert.rejects(() => client.getJson(), /hive doctor --json failed: rc=1 stderr=boom/);
});

test('non-zero exit but valid stdout envelope resolves', async () => {
  const expected = { version: '1', summary: { exit_code: 1 } };
  const client = createDoctorClient({
    spawn: () => ({ status: 1, stdout: JSON.stringify(expected), stderr: 'warnings' }),
  });

  const actual = await client.getJson();

  assert.deepStrictEqual(actual, expected);
});
