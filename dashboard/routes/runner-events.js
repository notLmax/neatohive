'use strict';

const express = require('express');

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
    const reversed = (await runnerEvents.readAll()).slice().reverse();
    const total = reversed.length;

    return res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      events: reversed.slice(offset, offset + limit),
      total,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/runner-events error:', err);
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
