'use strict';

function findOpenLifecycles(events) {
  const open = new Map();

  for (const event of events) {
    if (!event.taskId) {
      continue;
    }

    switch (event.event) {
      case 'discovered':
      case 'spawned':
        open.set(event.taskId, event);
        break;
      case 'exit':
      case 'error':
      case 'timeout':
        open.delete(event.taskId);
        break;
      default:
        break;
    }
  }

  return Array.from(open.values());
}

module.exports = { findOpenLifecycles };
