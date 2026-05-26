'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs/promises');
const path = require('node:path');

let doctorUtilsPromise;

async function loadDoctorUtils() {
  if (!doctorUtilsPromise) {
    doctorUtilsPromise = fs.readFile(
      path.join(__dirname, '..', 'public', 'js', 'pages', 'doctor-utils.js'),
      'utf8',
    ).then((source) => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
  }

  return doctorUtilsPromise;
}

test('summarizeStatus returns unavailable failure for null summary', async () => {
  const { summarizeStatus } = await loadDoctorUtils();

  assert.deepStrictEqual(summarizeStatus(null), {
    kind: 'fail',
    label: 'Doctor envelope unavailable',
  });
});

test('summarizeStatus returns pass when all checks pass', async () => {
  const { summarizeStatus } = await loadDoctorUtils();

  assert.deepStrictEqual(summarizeStatus({ total: 5, pass: 5, warn: 0, fail: 0, skip: 0 }), {
    kind: 'pass',
    label: 'All checks passing',
  });
});

test('summarizeStatus returns warning summary when warnings exist', async () => {
  const { summarizeStatus } = await loadDoctorUtils();

  assert.deepStrictEqual(summarizeStatus({ total: 5, pass: 3, warn: 2, fail: 0, skip: 0 }), {
    kind: 'warn',
    label: '2 warnings',
  });
});

test('summarizeStatus returns failing summary when failures exist', async () => {
  const { summarizeStatus } = await loadDoctorUtils();

  assert.deepStrictEqual(summarizeStatus({ total: 5, pass: 3, warn: 0, fail: 1, skip: 1 }), {
    kind: 'fail',
    label: '1 failing check',
  });
});

test('groupChecksByCategory orders known categories and drops agent checks', async () => {
  const { groupChecksByCategory } = await loadDoctorUtils();
  const checks = [
    { id: 'strategic-1', category: 'strategic' },
    { id: 'agent-1', category: 'agent' },
    { id: 'deps-1', category: 'deps' },
    { id: 'core-1', category: 'core' },
    { id: 'deps-2', category: 'deps' },
  ];

  assert.deepStrictEqual(groupChecksByCategory(checks), [
    { category: 'core', checks: [{ id: 'core-1', category: 'core' }] },
    { category: 'deps', checks: [{ id: 'deps-1', category: 'deps' }, { id: 'deps-2', category: 'deps' }] },
    { category: 'strategic', checks: [{ id: 'strategic-1', category: 'strategic' }] },
  ]);
});

test('groupChecksByCategory handles empty and invalid inputs', async () => {
  const { groupChecksByCategory } = await loadDoctorUtils();

  assert.deepStrictEqual(groupChecksByCategory(null), []);
  assert.deepStrictEqual(groupChecksByCategory([]), []);
});

test('doctorStatusClass maps known values and falls back to unknown', async () => {
  const { doctorStatusClass } = await loadDoctorUtils();

  assert.strictEqual(doctorStatusClass('pass'), 'pass');
  assert.strictEqual(doctorStatusClass('warn'), 'warn');
  assert.strictEqual(doctorStatusClass('fail'), 'fail');
  assert.strictEqual(doctorStatusClass('skip'), 'skip');
  assert.strictEqual(doctorStatusClass('mystery'), 'unknown');
});

test('doctorCategoryLabel maps known values and falls back verbatim', async () => {
  const { doctorCategoryLabel } = await loadDoctorUtils();

  assert.strictEqual(doctorCategoryLabel('deps'), 'Dependencies');
  assert.strictEqual(doctorCategoryLabel('mystery'), 'mystery');
  assert.strictEqual(doctorCategoryLabel(null), '');
});

test('prioritizeChecks sorts checks by severity while preserving tier order', async () => {
  const { prioritizeChecks } = await loadDoctorUtils();
  const checks = [
    { id: 'pass-1', status: 'pass' },
    { id: 'fail-1', status: 'fail' },
    { id: 'warn-1', status: 'warn' },
    { id: 'skip-1', status: 'skip' },
    { id: 'pass-2', status: 'pass' },
  ];

  assert.deepStrictEqual(
    prioritizeChecks(checks).map((check) => check.id),
    ['fail-1', 'warn-1', 'pass-1', 'pass-2', 'skip-1'],
  );
});

test('deriveAgentStatus honors top-level status and derives from checks', async () => {
  const { deriveAgentStatus } = await loadDoctorUtils();

  assert.strictEqual(deriveAgentStatus({ status: 'fail', checks: [] }), 'fail');
  assert.strictEqual(deriveAgentStatus({ checks: [{ status: 'pass' }, { status: 'fail' }] }), 'fail');
  assert.strictEqual(deriveAgentStatus(null), 'unknown');
});

test('isErrorEnvelope returns false only for valid envelope shape', async () => {
  const { isErrorEnvelope } = await loadDoctorUtils();

  assert.strictEqual(isErrorEnvelope(null), true);
  assert.strictEqual(isErrorEnvelope({ error: 'foo' }), true);
  assert.strictEqual(isErrorEnvelope({ summary: {}, checks: [] }), false);
});

test('isErrorEnvelope rejects malformed checks arrays', async () => {
  const { isErrorEnvelope } = await loadDoctorUtils();

  assert.strictEqual(isErrorEnvelope({ summary: {}, checks: 'not-array' }), true);
});
