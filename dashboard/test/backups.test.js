'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createBackupsClient } = require('../lib/backups');

function dirent(name) {
  return { name };
}

test('createBackupsClient returns empty backups when install root is absent', () => {
  const client = createBackupsClient({
    installRoot: '/tmp/missing',
    fs: {
      existsSync: () => false,
    },
  });

  assert.deepStrictEqual(client.listBackups(), { backups: [], total: 0 });
});

test('createBackupsClient groups multiple items for one timestamp', () => {
  const client = createBackupsClient({
    installRoot: '/tmp/hive',
    fs: {
      existsSync: () => true,
      readdirSync: () => [
        dirent('.env.old.20260507-200000'),
        dirent('.package.json.old.20260507-200000'),
      ],
      statSync: (fullPath) => ({ size: fullPath.includes('.env.') ? 3 : 7 }),
    },
  });

  assert.deepStrictEqual(client.listBackups(), {
    backups: [
      {
        id: '20260507-200000',
        created_at: '2026-05-07T20:00:00Z',
        items_count: 2,
        total_size_bytes: 10,
        is_latest: true,
      },
    ],
    total: 1,
  });
});

test('createBackupsClient sorts groups desc and marks latest', () => {
  const client = createBackupsClient({
    installRoot: '/tmp/hive',
    fs: {
      existsSync: () => true,
      readdirSync: () => [
        dirent('.env.old.20260507-200000'),
        dirent('.env.old.20260506-200000'),
      ],
      statSync: () => ({ size: 1 }),
    },
  });

  const result = client.listBackups();
  assert.deepStrictEqual(result.backups.map((backup) => backup.id), ['20260507-200000', '20260506-200000']);
  assert.strictEqual(result.backups[0].is_latest, true);
  assert.strictEqual(result.backups[1].is_latest, false);
});

test('createBackupsClient ignores files outside the shadow naming pattern', () => {
  const client = createBackupsClient({
    installRoot: '/tmp/hive',
    fs: {
      existsSync: () => true,
      readdirSync: () => [
        dirent('.env.old.20260507-200000'),
        dirent('.env.old.bad'),
        dirent('plain.txt'),
      ],
      statSync: () => ({ size: 1 }),
    },
  });

  assert.strictEqual(client.listBackups().total, 1);
});

test('createBackupsClient parses created_at from the shadow timestamp', () => {
  const client = createBackupsClient({
    installRoot: '/tmp/hive',
    fs: {
      existsSync: () => true,
      readdirSync: () => [dirent('.env.old.20261231-235959')],
      statSync: () => ({ size: 1 }),
    },
  });

  assert.strictEqual(client.listBackups().backups[0].created_at, '2026-12-31T23:59:59Z');
});

test('createBackupsClient tolerates stat failures with zero-byte fallback', () => {
  const client = createBackupsClient({
    installRoot: '/tmp/hive',
    fs: {
      existsSync: () => true,
      readdirSync: () => [dirent('.env.old.20260507-200000')],
      statSync: () => {
        throw new Error('boom');
      },
    },
  });

  assert.strictEqual(client.listBackups().backups[0].total_size_bytes, 0);
});
