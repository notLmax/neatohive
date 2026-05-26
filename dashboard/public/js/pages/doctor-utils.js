'use strict';

export function summarizeStatus(summary) {
  if (!summary) {
    return { kind: 'fail', label: 'Doctor envelope unavailable' };
  }

  const fail = Number(summary.fail) || 0;
  const warn = Number(summary.warn) || 0;
  const total = Number(summary.total) || 0;
  const pass = Number(summary.pass) || 0;

  if (fail > 0) {
    return { kind: 'fail', label: `${fail} failing check${fail === 1 ? '' : 's'}` };
  }
  if (warn > 0) {
    return { kind: 'warn', label: `${warn} warning${warn === 1 ? '' : 's'}` };
  }
  if (total > 0 && pass === total) {
    return { kind: 'pass', label: 'All checks passing' };
  }

  return { kind: 'pass', label: 'All checks passing' };
}

export function groupChecksByCategory(checks) {
  if (!Array.isArray(checks)) {
    return [];
  }

  const order = ['core', 'deps', 'auth', 'build', 'config', 'strategic'];
  const buckets = new Map();

  for (const check of checks) {
    if (!check || typeof check !== 'object') {
      continue;
    }

    const category = typeof check.category === 'string' ? check.category : 'unknown';
    if (category === 'agent') {
      continue;
    }

    if (!buckets.has(category)) {
      buckets.set(category, []);
    }
    buckets.get(category).push(check);
  }

  const grouped = [];
  for (const category of order) {
    if (!buckets.has(category)) {
      continue;
    }

    grouped.push({ category, checks: buckets.get(category) });
    buckets.delete(category);
  }

  for (const [category, list] of buckets) {
    grouped.push({ category, checks: list });
  }

  return grouped;
}

export function doctorStatusClass(status) {
  if (status === 'pass' || status === 'warn' || status === 'fail' || status === 'skip') {
    return status;
  }

  return 'unknown';
}

export function doctorCategoryLabel(category) {
  const labels = {
    core: 'Core',
    deps: 'Dependencies',
    auth: 'Authentication',
    build: 'Build',
    config: 'Configuration',
    strategic: 'Strategic',
  };

  if (typeof category !== 'string') {
    return '';
  }

  return labels[category] || category;
}

export function prioritizeChecks(checks) {
  if (!Array.isArray(checks)) {
    return [];
  }

  const tiers = { fail: 0, warn: 1, pass: 2, skip: 3 };

  return checks
    .map((check, index) => ({
      check,
      index,
      tier: tiers[check?.status] != null ? tiers[check.status] : 4,
    }))
    .sort((left, right) => (left.tier - right.tier) || (left.index - right.index))
    .map((entry) => entry.check);
}

export function deriveAgentStatus(agent) {
  if (!agent) {
    return 'unknown';
  }

  if (
    typeof agent.status === 'string' &&
    (agent.status === 'pass' || agent.status === 'warn' || agent.status === 'fail' || agent.status === 'skip')
  ) {
    return agent.status;
  }

  const checks = Array.isArray(agent.checks) ? agent.checks : [];
  if (checks.some((check) => check?.status === 'fail')) {
    return 'fail';
  }
  if (checks.some((check) => check?.status === 'warn')) {
    return 'warn';
  }
  if (checks.length > 0 && checks.every((check) => check?.status === 'pass' || check?.status === 'skip')) {
    return 'pass';
  }

  return 'unknown';
}

export function isErrorEnvelope(payload) {
  if (!payload || typeof payload !== 'object') {
    return true;
  }
  if (typeof payload.error === 'string') {
    return true;
  }
  if (!payload.summary || !Array.isArray(payload.checks)) {
    return true;
  }

  return false;
}
