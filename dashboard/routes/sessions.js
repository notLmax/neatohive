'use strict';

const express = require('express');
const { findOpenLifecycles } = require('../lib/sessions');

const router = express.Router();

router.get('/active', async (req, res) => {
  const { runnerEvents } = req.app.locals;

  try {
    const events = await runnerEvents.readAll();
    const openLifecycles = findOpenLifecycles(events);
    const lastByTaskId = new Map();

    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event.taskId || lastByTaskId.has(event.taskId)) {
        continue;
      }
      lastByTaskId.set(event.taskId, event);
    }

    const now = Date.now();
    const sessions = openLifecycles.map((open) => {
      const last = lastByTaskId.get(open.taskId) || open;
      const startedAt = Date.parse(open.ts);

      return {
        task_id: open.taskId,
        agent: open.agent || null,
        kind: open.kind || null,
        cmd_excerpt:
          open.detail && typeof open.detail.cmd === 'string'
            ? open.detail.cmd.slice(0, 200)
            : null,
        started_at: open.ts,
        elapsed_ms: Number.isFinite(startedAt) ? now - startedAt : null,
        last_runner_event: last.event,
        last_event_ts: last.ts,
      };
    });

    sessions.sort((a, b) => {
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

    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      sessions,
      total: sessions.length,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/sessions/active error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

module.exports = router;
