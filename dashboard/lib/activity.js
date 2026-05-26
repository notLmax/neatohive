'use strict';

function deriveActivity(events, agentName) {
  const openTasks = new Map();
  const openTurns = new Map();

  for (const event of events) {
    if (event.agent !== agentName) {
      continue;
    }

    switch (event.event) {
      case 'discovered':
      case 'spawned':
        if (event.taskId) {
          openTasks.set(event.taskId, event);
        }
        break;
      case 'exit':
      case 'error':
      case 'timeout':
        if (event.taskId) {
          openTasks.delete(event.taskId);
        }
        break;
      case 'wake_turn_started':
        if (event.taskId) {
          openTurns.set(event.taskId, event);
        }
        break;
      case 'wake_turn_complete':
        if (event.taskId) {
          openTurns.delete(event.taskId);
        }
        break;
      default:
        break;
    }
  }

  for (const [taskId, openEvent] of openTasks) {
    return { state: 'task', task_id: taskId, since: openEvent.ts };
  }

  for (const [taskId, openEvent] of openTurns) {
    return { state: 'turn', task_id: taskId, since: openEvent.ts };
  }

  return { state: 'idle', task_id: null, since: null };
}

module.exports = { deriveActivity };
