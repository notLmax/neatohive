'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createStateFileReader } = require('../lib/state-file');

const ROOT = '/tmp/hive-state-root';

test('readLast returns parsed last event', () => {
  const reader = createReader({
    [`${ROOT}/state/update-abc.jsonl`]: [
      '{"phase":"start"}',
      '{"phase":"done","detail":{"success":true}}',
    ].join('\n'),
  });

  assert.deepStrictEqual(reader.readLast('abc'), {
    phase: 'done',
    detail: { success: true },
  });
});

test('readLast returns null when file missing', () => {
  const reader = createReader({});

  assert.strictEqual(reader.readLast('missing'), null);
});

test('readLast returns null when file empty', () => {
  const reader = createReader({
    [`${ROOT}/state/update-empty.jsonl`]: '',
  });

  assert.strictEqual(reader.readLast('empty'), null);
});

test('readLast returns null when last line is malformed JSON', () => {
  const reader = createReader({
    [`${ROOT}/state/update-bad.jsonl`]: '{"phase":"start"}\nnot-json',
  });

  assert.strictEqual(reader.readLast('bad'), null);
});

test('readAll returns all parsed events, dropping malformed lines', () => {
  const reader = createReader({
    [`${ROOT}/state/update-abc.jsonl`]: '{"phase":"start"}\nnot-json\n{"phase":"done"}\n',
  });

  assert.deepStrictEqual(reader.readAll('abc'), [
    { phase: 'start' },
    { phase: 'done' },
  ]);
});

test('findNewerThan returns the update_id of the newest update file', () => {
  const reader = createReader(
    {},
    {
      files: {
        'update-old.jsonl': 200,
        'update-new.jsonl': 300,
        'notes.txt': 999,
      },
    },
  );

  assert.strictEqual(reader.findNewerThan(100), 'new');
});

test('findNewerThan returns null when no file is newer than beforeTs', () => {
  const reader = createReader(
    {},
    {
      files: {
        'update-old.jsonl': 200,
      },
    },
  );

  assert.strictEqual(reader.findNewerThan(250), null);
});

test('findNewerThan ignores files that do not match the update-<id>.jsonl pattern', () => {
  const reader = createReader(
    {},
    {
      files: {
        'update-good.jsonl': 200,
        'update-bad.log': 999,
        'wrong.jsonl': 998,
      },
    },
  );

  assert.strictEqual(reader.findNewerThan(100), 'good');
});

function createReader(fileContents, options = {}) {
  const dirFiles = options.files || Object.fromEntries(
    Object.keys(fileContents)
      .filter((filePath) => filePath.startsWith(`${ROOT}/state/`))
      .map((filePath) => [path.basename(filePath), 1]),
  );

  return createStateFileReader({
    stateRoot: ROOT,
    fs: {
      existsSync(targetPath) {
        return targetPath === `${ROOT}/state`
          || Object.hasOwn(fileContents, targetPath);
      },
      readFileSync(targetPath) {
        return fileContents[targetPath];
      },
      readdirSync(targetPath) {
        assert.strictEqual(targetPath, `${ROOT}/state`);
        return Object.keys(dirFiles);
      },
      statSync(targetPath) {
        return { mtimeMs: dirFiles[path.basename(targetPath)] };
      },
    },
  });
}
