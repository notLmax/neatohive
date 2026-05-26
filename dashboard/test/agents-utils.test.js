'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');

let agentsUtilsPromise;

async function loadAgentsUtils() {
  if (!agentsUtilsPromise) {
    agentsUtilsPromise = fs.readFile(
      path.join(__dirname, '..', 'public', 'js', 'pages', 'agents-utils.js'),
      'utf8',
    ).then((source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  }

  return agentsUtilsPromise;
}

test('selectRecentTasksForAgent returns [] for an empty task list', async () => {
  const { selectRecentTasksForAgent } = await loadAgentsUtils();

  assert.deepStrictEqual(selectRecentTasksForAgent([], 'atlas'), []);
});

test('selectRecentTasksForAgent returns [] for invalid task input', async () => {
  const { selectRecentTasksForAgent } = await loadAgentsUtils();

  assert.deepStrictEqual(selectRecentTasksForAgent(null, 'atlas'), []);
});

test('selectRecentTasksForAgent filters by agent and sorts by started_at descending', async () => {
  const { selectRecentTasksForAgent } = await loadAgentsUtils();
  const tasks = [
    { taskId: 'b1', agent: 'bob', started_at: '2026-05-07T11:00:00.000Z' },
    { taskId: 'a2', agent: 'atlas', started_at: '2026-05-07T12:10:00.000Z' },
    { taskId: 'b2', agent: 'bob', started_at: '2026-05-07T12:20:00.000Z' },
    { taskId: 'a1', agent: 'atlas', started_at: '2026-05-07T12:00:00.000Z' },
    { taskId: 'b3', agent: 'bob', started_at: '2026-05-07T12:30:00.000Z' },
    { taskId: 'b4', agent: 'bob', started_at: '2026-05-07T12:40:00.000Z' },
    { taskId: 'a3', agent: 'atlas', started_at: '2026-05-07T12:50:00.000Z' },
    { taskId: 'b5', agent: 'bob', started_at: '2026-05-07T13:00:00.000Z' },
  ];

  assert.deepStrictEqual(
    selectRecentTasksForAgent(tasks, 'atlas', 5).map((task) => task.taskId),
    ['a3', 'a2', 'a1'],
  );
});

test('selectRecentTasksForAgent sinks null started_at values', async () => {
  const { selectRecentTasksForAgent } = await loadAgentsUtils();
  const tasks = [
    { taskId: 'a1', agent: 'atlas', started_at: null },
    { taskId: 'a2', agent: 'atlas', started_at: '2026-05-07T12:10:00.000Z' },
    { taskId: 'a3', agent: 'atlas', started_at: '2026-05-07T12:00:00.000Z' },
  ];

  assert.deepStrictEqual(
    selectRecentTasksForAgent(tasks, 'atlas').map((task) => task.taskId),
    ['a2', 'a3', 'a1'],
  );
});

test('formatDuration formats supported buckets and invalid values', async () => {
  const { formatDuration } = await loadAgentsUtils();

  assert.strictEqual(formatDuration(45_000), '45s');
  assert.strictEqual(formatDuration(125_000), '2m 5s');
  assert.strictEqual(formatDuration(3_725_000), '1h 2m');
  assert.strictEqual(formatDuration(86_400_000), '1d');
  assert.strictEqual(formatDuration(Number.NaN), '');
  assert.strictEqual(formatDuration(-1), '');
});

test('formatBytes formats supported units and invalid values', async () => {
  const { formatBytes } = await loadAgentsUtils();

  assert.strictEqual(formatBytes(0), '0 B');
  assert.strictEqual(formatBytes(2_048), '2.0 KB');
  assert.strictEqual(formatBytes(78_901_234), '75.2 MB');
  assert.strictEqual(formatBytes(Number.NaN), '');
});

test('relativeTime formats supported buckets', async () => {
  const { relativeTime } = await loadAgentsUtils();
  const now = Date.parse('2026-05-07T12:00:00.000Z');

  assert.strictEqual(relativeTime(now - 30_000, now), '30s ago');
  assert.strictEqual(relativeTime(now - 5 * 60_000, now), '5m ago');
  assert.strictEqual(relativeTime(now - 3 * 60 * 60_000, now), '3h ago');
  assert.strictEqual(relativeTime(now - 2 * 24 * 60 * 60_000, now), '2d ago');
});

test('truncate shortens long values and normalizes null', async () => {
  const { truncate } = await loadAgentsUtils();

  assert.strictEqual(truncate('long-string-value', 5), 'long-…');
  assert.strictEqual(truncate('short', 12), 'short');
  assert.strictEqual(truncate(null, 5), '');
});

test('pm2StatusClass maps known and unknown values', async () => {
  const { pm2StatusClass } = await loadAgentsUtils();

  assert.strictEqual(pm2StatusClass('online'), 'online');
  assert.strictEqual(pm2StatusClass('UNKNOWN'), 'unknown');
});

test('activityClass maps known and fallback values', async () => {
  const { activityClass } = await loadAgentsUtils();

  assert.strictEqual(activityClass('weird'), 'idle');
  assert.strictEqual(activityClass('task'), 'task');
});

test('isNearBottom detects sticky scroll state defensively', async () => {
  const { isNearBottom } = await loadAgentsUtils();

  assert.strictEqual(isNearBottom({ scrollHeight: 1000, scrollTop: 970, clientHeight: 24 }), true);
  assert.strictEqual(isNearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 200 }), false);
  assert.strictEqual(isNearBottom(null), false);
});

test('taskStatusClass maps known values and falls back to unknown', async () => {
  const { taskStatusClass } = await loadAgentsUtils();

  assert.strictEqual(taskStatusClass('running'), 'running');
  assert.strictEqual(taskStatusClass('errored'), 'errored');
  assert.strictEqual(taskStatusClass('timed_out'), 'timed_out');
  assert.strictEqual(taskStatusClass('mystery'), 'unknown');
  assert.strictEqual(taskStatusClass(null), 'unknown');
});
