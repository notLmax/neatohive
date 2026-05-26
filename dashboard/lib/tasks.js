'use strict';

const STATUS_BY_CLOSER = {
  exit: 'completed',
  error: 'errored',
  timeout: 'timed_out',
};

function buildTaskHistory(events, { limit = 100, offset = 0 } = {}) {
  const tasks = new Map();

  for (const event of events) {
    if (!event.taskId) {
      continue;
    }

    if (!tasks.has(event.taskId)) {
      tasks.set(event.taskId, {
        taskId: event.taskId,
        agent: event.agent || null,
        kind: event.kind || null,
        cmd_excerpt: null,
        opened_at_ms: null,
        closed_at_ms: null,
        status: 'unknown',
        last_event: null,
      });
    }

    const task = tasks.get(event.taskId);

    if ((event.event === 'discovered' || event.event === 'spawned') && task.opened_at_ms === null) {
      const openedAt = Date.parse(event.ts);
      task.opened_at_ms = Number.isFinite(openedAt) ? openedAt : null;
      if (event.detail && typeof event.detail.cmd === 'string') {
        task.cmd_excerpt = event.detail.cmd.slice(0, 200);
      }
      if (!task.kind && event.kind) {
        task.kind = event.kind;
      }
      if (!task.agent && event.agent) {
        task.agent = event.agent;
      }
      if (task.status === 'unknown') {
        task.status = 'running';
      }
    }

    if (STATUS_BY_CLOSER[event.event] && task.closed_at_ms === null) {
      const closedAt = Date.parse(event.ts);
      task.closed_at_ms = Number.isFinite(closedAt) ? closedAt : null;
      task.status = STATUS_BY_CLOSER[event.event];
    }

    task.last_event = event.event;
  }

  const rows = [];
  const now = Date.now();

  for (const task of tasks.values()) {
    let elapsed_ms = null;

    if (task.closed_at_ms !== null && task.opened_at_ms !== null) {
      elapsed_ms = task.closed_at_ms - task.opened_at_ms;
    } else if (task.opened_at_ms !== null) {
      elapsed_ms = now - task.opened_at_ms;
    }

    rows.push({
      taskId: task.taskId,
      agent: task.agent,
      kind: task.kind,
      cmd_excerpt: task.cmd_excerpt,
      started_at: task.opened_at_ms !== null ? new Date(task.opened_at_ms).toISOString() : null,
      elapsed_ms,
      status: task.status,
      last_runner_event: task.last_event,
    });
  }

  rows.sort((a, b) => {
    if (a.elapsed_ms === null && b.elapsed_ms === null) {
      return 0;
    }
    if (a.elapsed_ms === null) {
      return 1;
    }
    if (b.elapsed_ms === null) {
      return -1;
    }
    return b.elapsed_ms - a.elapsed_ms;
  });

  const total = rows.length;
  const tasksPage = rows.slice(offset, offset + limit);

  return { tasks: tasksPage, total };
}

module.exports = { buildTaskHistory };
