'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createRunnerEventsReader, parseLine } = require('../lib/runner-events');

test('parseLine returns parsed event for valid json', () => {
  const event = parseLine('{"ts":"2026-05-07T00:00:00.000Z","event":"discovered","agent":"atlas"}');

  assert.deepStrictEqual(event, {
    ts: '2026-05-07T00:00:00.000Z',
    event: 'discovered',
    agent: 'atlas',
  });
});

test('parseLine returns null for malformed json', () => {
  assert.strictEqual(parseLine('{'), null);
});

test('parseLine returns null when ts or event is missing', () => {
  assert.strictEqual(parseLine('{"event":"discovered"}'), null);
  assert.strictEqual(parseLine('{"ts":"2026-05-07T00:00:00.000Z"}'), null);
});

test('readLastN returns the last n events', async () => {
  const lines = Array.from({ length: 10 }, (_, index) =>
    JSON.stringify({ ts: `2026-05-07T00:00:0${index}.000Z`, event: 'discovered', idx: index }),
  ).join('\n');

  const reader = createRunnerEventsReader({
    logPath: '/tmp/runner-events.log',
    fs: {
      existsSync: () => true,
      promises: {
        readFile: async () => lines,
      },
    },
  });

  const events = await reader.readLastN(5);

  assert.deepStrictEqual(events.map((event) => event.idx), [5, 6, 7, 8, 9]);
});

test('readLastN returns empty array when file does not exist', async () => {
  const reader = createRunnerEventsReader({
    logPath: '/tmp/missing.log',
    fs: {
      existsSync: () => false,
      promises: {
        readFile: async () => {
          throw new Error('should not be called');
        },
      },
    },
  });

  assert.deepStrictEqual(await reader.readLastN(5), []);
});

test('readLastN skips malformed lines', async () => {
  const reader = createRunnerEventsReader({
    logPath: '/tmp/runner-events.log',
    fs: {
      existsSync: () => true,
      promises: {
        readFile: async () => [
          '{"ts":"2026-05-07T00:00:00.000Z","event":"discovered","idx":1}',
          '{',
          '{"ts":"2026-05-07T00:00:02.000Z","event":"exit","idx":2}',
        ].join('\n'),
      },
    },
  });

  const events = await reader.readLastN(10);

  assert.deepStrictEqual(events.map((event) => event.idx), [1, 2]);
});
