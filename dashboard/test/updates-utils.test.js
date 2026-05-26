'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');

let updatesUtilsPromise;

async function loadUpdatesUtils() {
  if (!updatesUtilsPromise) {
    updatesUtilsPromise = fs.readFile(
      path.join(__dirname, '..', 'public', 'js', 'pages', 'updates-utils.js'),
      'utf8',
    ).then((source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  }

  return updatesUtilsPromise;
}

test('updateGateState returns unknown for null payload', async () => {
  const { updateGateState } = await loadUpdatesUtils();

  assert.deepStrictEqual(updateGateState(null), {
    kind: 'unknown',
    label: 'Could not load update info',
    show_button: false,
  });
});

test('updateGateState returns available state for update_available=true', async () => {
  const { updateGateState } = await loadUpdatesUtils();

  assert.deepStrictEqual(updateGateState({
    update_available: true,
    local_version: '1.5.0',
    remote_version: '1.5.1',
  }), {
    kind: 'available',
    label: 'Update available: v1.5.0 → v1.5.1',
    show_button: true,
  });
});

test('updateGateState returns current state for update_available=false', async () => {
  const { updateGateState } = await loadUpdatesUtils();

  assert.deepStrictEqual(updateGateState({
    update_available: false,
    local_version: '1.5.0',
  }), {
    kind: 'current',
    label: 'Up to date (v1.5.0)',
    show_button: false,
  });
});

test('updateGateState returns unknown state with error when update_available=null', async () => {
  const { updateGateState } = await loadUpdatesUtils();

  assert.deepStrictEqual(updateGateState({
    update_available: null,
    error: 'unreachable',
    local_version: '1.5.0',
  }), {
    kind: 'unknown',
    label: 'unreachable',
    show_button: false,
  });
});

test('updateGateState falls back to default unknown message for null state without error', async () => {
  const { updateGateState } = await loadUpdatesUtils();

  assert.deepStrictEqual(updateGateState({ update_available: null }), {
    kind: 'unknown',
    label: 'Could not contact the release server.',
    show_button: false,
  });
});

test('updateGateState handles 5xx-style error envelope', async () => {
  const { updateGateState } = await loadUpdatesUtils();

  assert.deepStrictEqual(updateGateState({ error: 'check_failed', detail: 'spawn failed' }), {
    kind: 'unknown',
    label: 'spawn failed',
    show_button: false,
  });
});

test('isCheckErrorPayload distinguishes update check envelopes from error payloads', async () => {
  const { isCheckErrorPayload } = await loadUpdatesUtils();

  assert.strictEqual(isCheckErrorPayload({ update_available: false }), false);
  assert.strictEqual(isCheckErrorPayload({ error: 'foo' }), true);
  assert.strictEqual(isCheckErrorPayload(null), true);
});

test('isMigrationPhase detects locked migration phases only', async () => {
  const { isMigrationPhase } = await loadUpdatesUtils();

  assert.strictEqual(isMigrationPhase('migration-start'), true);
  assert.strictEqual(isMigrationPhase('start'), false);
  assert.strictEqual(isMigrationPhase(null), false);
});

test('phaseGroup maps locked phases and falls back to unknown', async () => {
  const { phaseGroup } = await loadUpdatesUtils();

  assert.strictEqual(phaseGroup('overlay-applied'), 'install');
  assert.strictEqual(phaseGroup('rollback-start'), 'rollback');
  assert.strictEqual(phaseGroup('done'), 'terminal');
  assert.strictEqual(phaseGroup('mystery'), 'unknown');
});

test('formatPhaseLabel maps locked labels and preserves unknown phases verbatim', async () => {
  const { formatPhaseLabel } = await loadUpdatesUtils();

  assert.strictEqual(formatPhaseLabel('overlay-applied'), 'Applied overlay');
  assert.strictEqual(formatPhaseLabel('migration-pm2-reload-pending'), 'PM2 reload required (manual step)');
  assert.strictEqual(formatPhaseLabel('mystery'), 'mystery');
});

test('deriveStepGroups returns the six locked pending groups for an empty stream', async () => {
  const { deriveStepGroups } = await loadUpdatesUtils();

  assert.deepStrictEqual(deriveStepGroups([]), [
    { group: 'acquire', state: 'pending', most_recent_phase: null },
    { group: 'check', state: 'pending', most_recent_phase: null },
    { group: 'download', state: 'pending', most_recent_phase: null },
    { group: 'verify', state: 'pending', most_recent_phase: null },
    { group: 'install', state: 'pending', most_recent_phase: null },
    { group: 'finalize', state: 'pending', most_recent_phase: null },
  ]);
});

test('deriveStepGroups tolerates sparse streams and marks install active when overlay-applied is first', async () => {
  const { deriveStepGroups } = await loadUpdatesUtils();

  assert.deepStrictEqual(deriveStepGroups([{ phase: 'overlay-applied' }]), [
    { group: 'acquire', state: 'pending', most_recent_phase: null },
    { group: 'check', state: 'pending', most_recent_phase: null },
    { group: 'download', state: 'pending', most_recent_phase: null },
    { group: 'verify', state: 'pending', most_recent_phase: null },
    { group: 'install', state: 'active', most_recent_phase: 'overlay-applied' },
    { group: 'finalize', state: 'pending', most_recent_phase: null },
  ]);
});

test('deriveStepGroups marks finalize failed while earlier observed groups stay complete', async () => {
  const { deriveStepGroups } = await loadUpdatesUtils();

  assert.deepStrictEqual(deriveStepGroups([
    { phase: 'lock-acquired', sequence: 1 },
    { phase: 'compare-complete', sequence: 5 },
    { phase: 'finalize-failed', sequence: 11 },
  ]), [
    { group: 'acquire', state: 'complete', most_recent_phase: 'lock-acquired' },
    { group: 'check', state: 'complete', most_recent_phase: 'compare-complete' },
    { group: 'download', state: 'pending', most_recent_phase: null },
    { group: 'verify', state: 'pending', most_recent_phase: null },
    { group: 'install', state: 'pending', most_recent_phase: null },
    { group: 'finalize', state: 'failed', most_recent_phase: 'finalize-failed' },
  ]);
});

test('deriveStepGroups appends rollback group and marks its terminal state', async () => {
  const { deriveStepGroups } = await loadUpdatesUtils();

  assert.deepStrictEqual(deriveStepGroups([
    { phase: 'rollback-start', sequence: 1 },
  ]).at(-1), {
    group: 'rollback',
    state: 'active',
    most_recent_phase: 'rollback-start',
  });

  assert.deepStrictEqual(deriveStepGroups([
    { phase: 'rollback-start', sequence: 1 },
    { phase: 'rollback-complete', sequence: 2 },
  ]).at(-1), {
    group: 'rollback',
    state: 'complete',
    most_recent_phase: 'rollback-complete',
  });
});

test('terminalState reports success and rollback-aware failure states', async () => {
  const { terminalState } = await loadUpdatesUtils();

  assert.deepStrictEqual(terminalState([
    { phase: 'done', detail: { success: true, final_version: '1.5.1' } },
  ]), {
    is_done: true,
    success: true,
    last_error: null,
    rolled_back: false,
  });

  assert.deepStrictEqual(terminalState([
    { phase: 'finalize-failed', detail: { step: 'doctor', error: 'sweep failed' } },
    { phase: 'rollback-start' },
    { phase: 'rollback-complete' },
    { phase: 'done', detail: { success: false } },
  ]), {
    is_done: true,
    success: false,
    last_error: 'sweep failed',
    rolled_back: true,
  });
});

test('migrationEvents returns only migration phases', async () => {
  const { migrationEvents } = await loadUpdatesUtils();

  assert.deepStrictEqual(migrationEvents([
    { phase: 'start' },
    { phase: 'migration-start' },
    { phase: 'migration-complete' },
  ]), [
    { phase: 'migration-start' },
    { phase: 'migration-complete' },
  ]);
});

test('parseEventLine parses valid JSON lines and rejects invalid payloads', async () => {
  const { parseEventLine } = await loadUpdatesUtils();

  assert.deepStrictEqual(parseEventLine('{"phase":"start","ts":"...","sequence":0,"detail":{}}'), {
    phase: 'start',
    ts: '...',
    sequence: 0,
    detail: {},
  });
  assert.strictEqual(parseEventLine('not-json'), null);
  assert.strictEqual(parseEventLine('{}'), null);
  assert.strictEqual(parseEventLine(''), null);
});
