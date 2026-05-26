'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { deriveActivity } = require('../lib/activity');

test('empty events returns idle', () => {
  assert.deepStrictEqual(deriveActivity([], 'atlas'), {
    state: 'idle',
    task_id: null,
    since: null,
  });
});

test('discovered without exit returns task', () => {
  const events = [{ ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'discovered', taskId: 't1' }];

  assert.deepStrictEqual(deriveActivity(events, 'atlas'), {
    state: 'task',
    task_id: 't1',
    since: '2026-05-07T00:00:00.000Z',
  });
});

test('discovered then exit returns idle', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', agent: 'atlas', event: 'exit', taskId: 't1' },
  ];

  assert.deepStrictEqual(deriveActivity(events, 'atlas'), {
    state: 'idle',
    task_id: null,
    since: null,
  });
});

test('wake_turn_started without wake_turn_complete returns turn', () => {
  const events = [{ ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'wake_turn_started', taskId: 't1' }];

  assert.deepStrictEqual(deriveActivity(events, 'atlas'), {
    state: 'turn',
    task_id: 't1',
    since: '2026-05-07T00:00:00.000Z',
  });
});

test('wake_turn_started then wake_turn_complete returns idle', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'wake_turn_started', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', agent: 'atlas', event: 'wake_turn_complete', taskId: 't1' },
  ];

  assert.deepStrictEqual(deriveActivity(events, 'atlas'), {
    state: 'idle',
    task_id: null,
    since: null,
  });
});

test('open task wins over open turn', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'discovered', taskId: 'task-1' },
    { ts: '2026-05-07T00:01:00.000Z', agent: 'atlas', event: 'wake_turn_started', taskId: 'turn-1' },
  ];

  assert.deepStrictEqual(deriveActivity(events, 'atlas'), {
    state: 'task',
    task_id: 'task-1',
    since: '2026-05-07T00:00:00.000Z',
  });
});

test('different agents are isolated', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:00:00.000Z', agent: 'bob-the-builder', event: 'discovered', taskId: 't2' },
  ];

  assert.deepStrictEqual(deriveActivity(events, 'bob-the-builder'), {
    state: 'task',
    task_id: 't2',
    since: '2026-05-07T00:00:00.000Z',
  });
});

test('exit for unknown task id is ignored', () => {
  const events = [{ ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'exit', taskId: 'missing' }];

  assert.deepStrictEqual(deriveActivity(events, 'atlas'), {
    state: 'idle',
    task_id: null,
    since: null,
  });
});

test('spawned opens a task lifecycle', () => {
  const events = [{ ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'spawned', taskId: 't1' }];

  assert.deepStrictEqual(deriveActivity(events, 'atlas'), {
    state: 'task',
    task_id: 't1',
    since: '2026-05-07T00:00:00.000Z',
  });
});

test('since is the opening event timestamp', () => {
  const events = [{ ts: '2026-05-07T12:34:56.000Z', agent: 'atlas', event: 'discovered', taskId: 't1' }];

  assert.strictEqual(deriveActivity(events, 'atlas').since, '2026-05-07T12:34:56.000Z');
});

test('error closes an open task lifecycle', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', agent: 'atlas', event: 'error', taskId: 't1' },
  ];

  assert.deepStrictEqual(deriveActivity(events, 'atlas'), {
    state: 'idle',
    task_id: null,
    since: null,
  });
});

test('timeout closes an open task lifecycle', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', agent: 'atlas', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', agent: 'atlas', event: 'timeout', taskId: 't1' },
  ];

  assert.deepStrictEqual(deriveActivity(events, 'atlas'), {
    state: 'idle',
    task_id: null,
    since: null,
  });
});
