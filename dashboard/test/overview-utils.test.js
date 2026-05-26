'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');

let overviewUtilsPromise;

async function loadOverviewUtils() {
  if (!overviewUtilsPromise) {
    overviewUtilsPromise = fs.readFile(
      path.join(__dirname, '..', 'public', 'js', 'pages', 'overview-utils.js'),
      'utf8',
    ).then((source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  }

  return overviewUtilsPromise;
}

test('deriveOverallStatus returns fail when status is unavailable', async () => {
  const { deriveOverallStatus } = await loadOverviewUtils();

  assert.deepStrictEqual(deriveOverallStatus(null), {
    kind: 'fail',
    label: 'Cannot reach dashboard backend',
  });
});

test('deriveOverallStatus returns fail when any PM2 process is errored', async () => {
  const { deriveOverallStatus } = await loadOverviewUtils();

  assert.deepStrictEqual(deriveOverallStatus({ pm2: { errored: 2, online: 3, total: 5 } }), {
    kind: 'fail',
    label: '2 PM2 processes errored',
  });
});

test('deriveOverallStatus returns warn when some PM2 processes are offline', async () => {
  const { deriveOverallStatus } = await loadOverviewUtils();

  assert.deepStrictEqual(deriveOverallStatus({ pm2: { errored: 0, online: 2, total: 3 } }), {
    kind: 'warn',
    label: '1 of 3 PM2 processes not online',
  });
});

test('deriveOverallStatus returns pass when all PM2 processes are online', async () => {
  const { deriveOverallStatus } = await loadOverviewUtils();

  assert.deepStrictEqual(deriveOverallStatus({ pm2: { errored: 0, online: 5, total: 5 } }), {
    kind: 'pass',
    label: 'All systems nominal',
  });
});

test('deriveUpdateBanner returns available metadata when an update exists', async () => {
  const { deriveUpdateBanner } = await loadOverviewUtils();

  assert.deepStrictEqual(
    deriveUpdateBanner({ update_available: true, local_version: '1.5.0', remote_version: '1.5.1' }),
    { kind: 'available', from: '1.5.0', to: '1.5.1' },
  );
});

test('deriveUpdateBanner returns silent when no update exists', async () => {
  const { deriveUpdateBanner } = await loadOverviewUtils();

  assert.deepStrictEqual(deriveUpdateBanner({ update_available: false }), { kind: 'silent' });
});

test('deriveUpdateBanner returns check_failed when the update check failed', async () => {
  const { deriveUpdateBanner } = await loadOverviewUtils();

  assert.deepStrictEqual(deriveUpdateBanner({ update_available: null, error: 'unreachable' }), {
    kind: 'check_failed',
    error: 'unreachable',
  });
});

test('relativeTime formats each supported time bucket', async () => {
  const { relativeTime } = await loadOverviewUtils();
  const now = Date.parse('2026-05-07T12:00:00.000Z');

  assert.strictEqual(relativeTime(now, now), 'just now');
  assert.strictEqual(relativeTime(now - 30_000, now), '30s ago');
  assert.strictEqual(relativeTime(now - 5 * 60_000, now), '5m ago');
  assert.strictEqual(relativeTime(now - 3 * 60 * 60_000, now), '3h ago');
  assert.strictEqual(relativeTime(now - 2 * 24 * 60 * 60_000, now), '2d ago');
});

test('truncate shortens long values and leaves short values intact', async () => {
  const { truncate } = await loadOverviewUtils();

  assert.strictEqual(truncate('long-string-value', 5), 'long-…');
  assert.strictEqual(truncate('short', 12), 'short');
});

test('pm2StatusClass and activityClass map known and fallback values defensively', async () => {
  const { pm2StatusClass, activityClass } = await loadOverviewUtils();

  assert.strictEqual(pm2StatusClass('online'), 'online');
  assert.strictEqual(pm2StatusClass('UNKNOWN_VAL'), 'unknown');
  assert.strictEqual(activityClass('weird'), 'idle');
});
