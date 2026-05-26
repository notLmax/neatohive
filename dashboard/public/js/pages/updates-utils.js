'use strict';

const PHASE_GROUP = {
  start: 'acquire',
  'lock-acquired': 'acquire',
  'staging-setup-complete': 'acquire',
  'fetch-start': 'check',
  'fetch-complete': 'check',
  'compare-complete': 'check',
  'download-start': 'download',
  'download-complete': 'download',
  'verify-complete': 'verify',
  'extract-complete': 'install',
  'overlay-applied': 'install',
  'finalize-start': 'finalize',
  'finalize-complete': 'finalize',
  'finalize-failed': 'finalize',
  'rollback-start': 'rollback',
  'rollback-complete': 'rollback',
  error: 'error',
  done: 'terminal',
};

const PHASE_LABEL = {
  start: 'Starting update',
  'lock-acquired': 'Acquired update lock',
  'staging-setup-complete': 'Prepared staging directory',
  'fetch-start': 'Fetching release metadata',
  'fetch-complete': 'Fetched release metadata',
  'compare-complete': 'Compared versions',
  'download-start': 'Downloading release tarball',
  'download-complete': 'Downloaded release tarball',
  'verify-complete': 'Verified checksum',
  'extract-complete': 'Extracted release tarball',
  'overlay-applied': 'Applied overlay',
  'finalize-start': 'Finalizing install',
  'finalize-complete': 'Finalized install',
  'finalize-failed': 'Finalize failed',
  'rollback-start': 'Rolling back',
  'rollback-complete': 'Rollback complete',
  error: 'Update error',
  done: 'Update complete',
};

const MIGRATION_LABEL = {
  'migration-start': 'Starting post-update setup',
  'migration-token-generated': 'Generated dashboard token',
  'migration-token-already-present': 'Dashboard token already present (skipped)',
  'migration-pm2-reload-pending': 'PM2 reload required (manual step)',
  'migration-complete': 'Post-update setup complete',
  'migration-failed': 'Post-update setup failed',
};

const GROUP_ORDER = ['acquire', 'check', 'download', 'verify', 'install', 'finalize'];

export function updateGateState(payload) {
  if (!payload || typeof payload !== 'object') {
    return { kind: 'unknown', label: 'Could not load update info', show_button: false };
  }

  if (typeof payload.error === 'string' && typeof payload.update_available === 'undefined') {
    const detail = typeof payload.detail === 'string' ? payload.detail : payload.error;
    return { kind: 'unknown', label: detail, show_button: false };
  }

  if (payload.update_available === true) {
    const local = typeof payload.local_version === 'string' ? payload.local_version : '?';
    const remote = typeof payload.remote_version === 'string' ? payload.remote_version : '?';
    return {
      kind: 'available',
      label: `Update available: v${local} → v${remote}`,
      show_button: true,
    };
  }

  if (payload.update_available === false) {
    const local = typeof payload.local_version === 'string' ? payload.local_version : '?';
    return { kind: 'current', label: `Up to date (v${local})`, show_button: false };
  }

  const detail = typeof payload.error === 'string'
    ? payload.error
    : 'Could not contact the release server.';
  return { kind: 'unknown', label: detail, show_button: false };
}

export function isCheckErrorPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return true;
  }

  return typeof payload.update_available === 'undefined';
}

export function isMigrationPhase(phase) {
  return typeof phase === 'string' && phase.startsWith('migration-');
}

export function phaseGroup(phase) {
  if (typeof phase !== 'string') {
    return 'unknown';
  }
  if (PHASE_GROUP[phase]) {
    return PHASE_GROUP[phase];
  }
  if (isMigrationPhase(phase)) {
    return 'migration';
  }
  return 'unknown';
}

export function formatPhaseLabel(phase) {
  if (typeof phase !== 'string') {
    return '';
  }
  if (PHASE_LABEL[phase]) {
    return PHASE_LABEL[phase];
  }
  if (MIGRATION_LABEL[phase]) {
    return MIGRATION_LABEL[phase];
  }
  return phase;
}

export function deriveStepGroups(events) {
  if (!Array.isArray(events)) {
    return GROUP_ORDER.map((group) => ({ group, state: 'pending', most_recent_phase: null }));
  }

  const updateEvents = events.filter((event) => event && typeof event.phase === 'string' && !isMigrationPhase(event.phase));
  const seenGroups = new Set();
  const groupLastPhase = {};
  let mostRecentGroup = null;
  let failedGroup = null;
  let rolledBack = false;

  for (const event of updateEvents) {
    if (event.phase === 'error') {
      if (mostRecentGroup) {
        failedGroup = mostRecentGroup;
      }
      continue;
    }

    const group = phaseGroup(event.phase);
    if (group === 'unknown' || group === 'terminal' || group === 'error') {
      continue;
    }

    if (group === 'rollback') {
      rolledBack = true;
    }
    if (event.phase === 'finalize-failed') {
      failedGroup = 'finalize';
    }

    seenGroups.add(group);
    groupLastPhase[group] = event.phase;
    mostRecentGroup = group;
  }

  const result = GROUP_ORDER.map((group) => {
    if (!seenGroups.has(group)) {
      return { group, state: 'pending', most_recent_phase: null };
    }
    if (failedGroup === group) {
      return { group, state: 'failed', most_recent_phase: groupLastPhase[group] || null };
    }
    if (group === mostRecentGroup) {
      return { group, state: 'active', most_recent_phase: groupLastPhase[group] || null };
    }
    return { group, state: 'complete', most_recent_phase: groupLastPhase[group] || null };
  });

  if (rolledBack) {
    result.push({
      group: 'rollback',
      state: updateEvents.some((event) => event.phase === 'rollback-complete') ? 'complete' : 'active',
      most_recent_phase: groupLastPhase.rollback || null,
    });
  }

  return result;
}

export function groupLabel(group) {
  const map = {
    acquire: 'Acquire',
    check: 'Check',
    download: 'Download',
    verify: 'Verify',
    install: 'Install',
    finalize: 'Finalize',
    rollback: 'Rollback',
    migration: 'Post-update setup',
  };

  if (typeof group !== 'string') {
    return '';
  }

  return map[group] || group;
}

export function terminalState(events) {
  if (!Array.isArray(events)) {
    return { is_done: false, success: null, last_error: null, rolled_back: false };
  }

  let isDone = false;
  let success = null;
  let lastError = null;
  let rolledBack = false;

  for (const event of events) {
    if (!event || typeof event !== 'object') {
      continue;
    }
    if (event.phase === 'rollback-start' || event.phase === 'rollback-complete') {
      rolledBack = true;
    }
    if ((event.phase === 'error' || event.phase === 'finalize-failed') && event.detail) {
      const error = typeof event.detail.error === 'string' ? event.detail.error : null;
      if (error) {
        lastError = error;
      }
    }
    if (event.phase === 'done') {
      isDone = true;
      success = typeof event.detail?.success === 'boolean' ? event.detail.success : null;
    }
  }

  return { is_done: isDone, success, last_error: lastError, rolled_back: rolledBack };
}

export function migrationEvents(events) {
  if (!Array.isArray(events)) {
    return [];
  }

  return events.filter((event) => event && typeof event.phase === 'string' && isMigrationPhase(event.phase));
}

export function parseEventLine(line) {
  if (typeof line !== 'string' || line.length === 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.phase !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
