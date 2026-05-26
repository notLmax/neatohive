'use strict';

export function deriveOverallStatus(status) {
  if (!status) {
    return { kind: 'fail', label: 'Cannot reach dashboard backend' };
  }

  const pm2 = status.pm2 || {};

  if (pm2.errored && pm2.errored > 0) {
    return {
      kind: 'fail',
      label: `${pm2.errored} PM2 process${pm2.errored === 1 ? '' : 'es'} errored`,
    };
  }

  if (typeof pm2.online === 'number' && typeof pm2.total === 'number' && pm2.online < pm2.total) {
    return {
      kind: 'warn',
      label: `${pm2.total - pm2.online} of ${pm2.total} PM2 processes not online`,
    };
  }

  return { kind: 'pass', label: 'All systems nominal' };
}

export function deriveUpdateBanner(check) {
  if (!check) {
    return { kind: 'silent' };
  }

  if (check.update_available === true) {
    return {
      kind: 'available',
      from: check.local_version || 'unknown',
      to: check.remote_version || 'unknown',
    };
  }

  if (check.update_available === null) {
    return {
      kind: 'check_failed',
      error: typeof check.error === 'string' ? check.error : 'unknown',
    };
  }

  return { kind: 'silent' };
}

export function relativeTime(ts, now = Date.now()) {
  if (!ts) {
    return '';
  }

  const value = typeof ts === 'string' ? Date.parse(ts) : ts;
  if (!Number.isFinite(value)) {
    return '';
  }

  const delta = Math.max(0, now - value);
  const seconds = Math.floor(delta / 1000);

  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function truncate(value, len = 12) {
  if (typeof value !== 'string' || value.length <= len) {
    return value || '';
  }

  return value.slice(0, len) + '…';
}

export function pm2StatusClass(status) {
  const value = typeof status === 'string' ? status.toLowerCase() : 'unknown';

  if (value === 'online') {
    return 'online';
  }
  if (value === 'errored') {
    return 'errored';
  }
  if (value === 'stopped') {
    return 'stopped';
  }
  if (value === 'not_running') {
    return 'not_running';
  }

  return 'unknown';
}

export function activityClass(state) {
  if (state === 'idle' || state === 'turn' || state === 'task') {
    return state;
  }

  return 'idle';
}
