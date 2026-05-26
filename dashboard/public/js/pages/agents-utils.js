'use strict';

export function selectRecentTasksForAgent(tasks, name, limit = 20) {
  if (!Array.isArray(tasks) || typeof name !== 'string' || !name) {
    return [];
  }

  return tasks
    .filter((task) => task && task.agent === name)
    .sort((left, right) => {
      const leftStart = left.started_at ? Date.parse(left.started_at) : -Infinity;
      const rightStart = right.started_at ? Date.parse(right.started_at) : -Infinity;
      return rightStart - leftStart;
    })
    .slice(0, limit);
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) {
    return '';
  }

  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds - (minutes * 60);
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes - (hours * 60);
  if (hours < 24) {
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours - (days * 24);
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '';
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
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

export function truncate(value, len = 24) {
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

export function isNearBottom(element, stickyDistance = 24) {
  if (!element || typeof element.scrollHeight !== 'number') {
    return false;
  }

  const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
  return distanceFromBottom <= stickyDistance;
}

export function taskStatusClass(status) {
  const value = typeof status === 'string' ? status : 'unknown';

  if (value === 'running') {
    return 'running';
  }
  if (value === 'completed') {
    return 'completed';
  }
  if (value === 'errored') {
    return 'errored';
  }
  if (value === 'timed_out') {
    return 'timed_out';
  }

  return 'unknown';
}
