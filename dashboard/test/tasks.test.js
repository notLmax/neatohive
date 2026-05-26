'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildTaskHistory } = require('../lib/tasks');

test('buildTaskHistory returns empty tasks for empty events', () => {
  assert.deepStrictEqual(buildTaskHistory([]), { tasks: [], total: 0 });
});

test('buildTaskHistory marks single open task as running', () => {
  const now = Date.now();
  const openTs = new Date(now - 5_000).toISOString();
  const result = buildTaskHistory([
    {
      ts: openTs,
      event: 'discovered',
      taskId: 't1',
      agent: 'atlas',
      kind: 'codex',
      detail: { cmd: 'echo hello' },
    },
  ]);

  assert.strictEqual(result.total, 1);
  assert.strictEqual(result.tasks[0].status, 'running');
  assert.strictEqual(result.tasks[0].started_at, openTs);
  assert.strictEqual(result.tasks[0].cmd_excerpt, 'echo hello');
  assert.strictEqual(result.tasks[0].last_runner_event, 'discovered');
  assert.ok(result.tasks[0].elapsed_ms >= 4_000);
});

test('buildTaskHistory maps exit closer to completed', () => {
  const result = buildTaskHistory([
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:00:10.000Z', event: 'exit', taskId: 't1' },
  ]);

  assert.strictEqual(result.tasks[0].status, 'completed');
  assert.strictEqual(result.tasks[0].elapsed_ms, 10_000);
});

test('buildTaskHistory maps error closer to errored', () => {
  const result = buildTaskHistory([
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:00:10.000Z', event: 'error', taskId: 't1' },
  ]);

  assert.strictEqual(result.tasks[0].status, 'errored');
});

test('buildTaskHistory maps timeout closer to timed_out', () => {
  const result = buildTaskHistory([
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:00:10.000Z', event: 'timeout', taskId: 't1' },
  ]);

  assert.strictEqual(result.tasks[0].status, 'timed_out');
});

test('buildTaskHistory truncates cmd_excerpt at 200 chars', () => {
  const cmd = 'x'.repeat(220);
  const result = buildTaskHistory([
    { ts: '2026-05-07T00:00:00.000Z', event: 'spawned', taskId: 't1', detail: { cmd } },
  ]);

  assert.strictEqual(result.tasks[0].cmd_excerpt.length, 200);
  assert.strictEqual(result.tasks[0].cmd_excerpt, cmd.slice(0, 200));
});

test('buildTaskHistory sorts by elapsed_ms desc and sinks unknown tasks', () => {
  const result = buildTaskHistory([
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 'short' },
    { ts: '2026-05-07T00:00:05.000Z', event: 'exit', taskId: 'short' },
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 'long' },
    { ts: '2026-05-07T00:00:10.000Z', event: 'exit', taskId: 'long' },
    { ts: '2026-05-07T00:00:03.000Z', event: 'wake_turn_started', taskId: 'unknown' },
  ]);

  assert.deepStrictEqual(result.tasks.map((task) => task.taskId), ['long', 'short', 'unknown']);
  assert.strictEqual(result.tasks[2].elapsed_ms, null);
  assert.strictEqual(result.tasks[2].status, 'unknown');
});

test('buildTaskHistory applies limit and offset slicing', () => {
  const result = buildTaskHistory([
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:00:05.000Z', event: 'exit', taskId: 't1' },
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't2' },
    { ts: '2026-05-07T00:00:06.000Z', event: 'exit', taskId: 't2' },
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't3' },
    { ts: '2026-05-07T00:00:07.000Z', event: 'exit', taskId: 't3' },
  ], { limit: 1, offset: 1 });

  assert.strictEqual(result.total, 3);
  assert.deepStrictEqual(result.tasks.map((task) => task.taskId), ['t2']);
});
