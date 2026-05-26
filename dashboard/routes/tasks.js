'use strict';

const express = require('express');
const { buildTaskHistory } = require('../lib/tasks');

const router = express.Router();

router.get('/', async (req, res) => {
  const { runnerEvents } = req.app.locals;
  const limit = parseIntInRange(req.query.limit, 100, 1, 1000);
  const offset = parseIntInRange(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);

  if (limit === null) {
    return res.status(400).json({ error: 'bad_limit', detail: 'limit must be 1..1000' });
  }
  if (offset === null) {
    return res.status(400).json({ error: 'bad_offset', detail: 'offset must be ≥ 0' });
  }

  try {
    const events = await runnerEvents.readAll();
    const { tasks, total } = buildTaskHistory(events, { limit, offset });
    return res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      tasks,
      total,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/tasks error:', err);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

function parseIntInRange(raw, def, min, max) {
  if (raw === undefined) {
    return def;
  }

  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return null;
  }

  return parsed;
}

module.exports = router;
