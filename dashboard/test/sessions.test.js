'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { findOpenLifecycles } = require('../lib/sessions');

test('findOpenLifecycles returns empty array for empty events', () => {
  assert.deepStrictEqual(findOpenLifecycles([]), []);
});

test('findOpenLifecycles returns one open discovered task with detail cmd', () => {
  const events = [
    {
      ts: '2026-05-07T00:00:00.000Z',
      event: 'discovered',
      taskId: 't1',
      agent: 'atlas',
      kind: 'codex',
      detail: { cmd: 'echo hello' },
    },
  ];

  assert.deepStrictEqual(findOpenLifecycles(events), events);
});

test('findOpenLifecycles removes tasks closed by exit', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', event: 'exit', taskId: 't1' },
  ];

  assert.deepStrictEqual(findOpenLifecycles(events), []);
});

test('findOpenLifecycles removes tasks closed by error', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', event: 'error', taskId: 't1' },
  ];

  assert.deepStrictEqual(findOpenLifecycles(events), []);
});

test('findOpenLifecycles removes tasks closed by timeout', () => {
  const events = [
    { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't1' },
    { ts: '2026-05-07T00:01:00.000Z', event: 'timeout', taskId: 't1' },
  ];

  assert.deepStrictEqual(findOpenLifecycles(events), []);
});

test('findOpenLifecycles returns multiple open tasks across agents in event order', () => {
  const openOne = { ts: '2026-05-07T00:00:00.000Z', event: 'discovered', taskId: 't1', agent: 'atlas' };
  const openTwo = { ts: '2026-05-07T00:02:00.000Z', event: 'spawned', taskId: 't2', agent: 'bob-the-builder' };
  const openThenClose = { ts: '2026-05-07T00:01:00.000Z', event: 'discovered', taskId: 't3', agent: 'casey' };
  const closed = { ts: '2026-05-07T00:03:00.000Z', event: 'exit', taskId: 't3', agent: 'casey' };
  const events = [
    openOne,
    openThenClose,
    openTwo,
    closed,
  ];

  assert.deepStrictEqual(findOpenLifecycles(events), [openOne, openTwo]);
});
