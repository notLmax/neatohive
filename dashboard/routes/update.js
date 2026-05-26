'use strict';

const express = require('express');
const fs = require('node:fs');
const { createSseStream } = require('../lib/sse');

const router = express.Router();

router.get('/check', async (req, res) => {
  const { update } = req.app.locals;

  try {
    const envelope = await update.check();
    res.status(200).json(envelope);
  } catch (err) {
    console.error('[hive-dashboard] /api/update/check error:', err);
    res.status(500).json({ error: 'check_failed', detail: err.message });
  }
});

router.post('/apply', async (req, res) => {
  const { doctor, update } = req.app.locals;

  try {
    const result = await update.apply();
    if (doctor && typeof doctor.clearCache === 'function') {
      doctor.clearCache();
    }
    if (typeof update.clearCheckCache === 'function') {
      update.clearCheckCache();
    }

    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      update_id: result.update_id,
      started_at: result.started_at,
    });
  } catch (err) {
    if (err.code === 'UPDATE_ID_NOT_DISCOVERED') {
      return res.status(502).json({
        error: 'update_id_not_discovered',
        detail: err.message,
      });
    }

    console.error('[hive-dashboard] /api/update/apply error:', err);
    res.status(500).json({ error: 'apply_failed', detail: err.message });
  }
});

router.get('/status/:id', (req, res) => {
  const { stateFile } = req.app.locals;
  const { id } = req.params;

  if (!isValidUpdateId(id)) {
    return res.status(400).json({ error: 'bad_update_id' });
  }

  try {
    const last = stateFile.readLast(id);
    if (last === null) {
      return res.status(404).json({ error: 'update_not_found', update_id: id });
    }

    const isDone = last.phase === 'done';
    const success = isDone && last.detail ? Boolean(last.detail.success) : null;

    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      update_id: id,
      current: last,
      is_done: isDone,
      success,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/update/status/:id error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

router.get('/progress/:id', (req, res) => {
  const { stateFile } = req.app.locals;
  const { id } = req.params;

  if (!isValidUpdateId(id)) {
    return res.status(400).json({ error: 'bad_update_id' });
  }

  const filePath = stateFile.pathFor(id);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'update_not_found', update_id: id });
  }

  createSseStream(req, res, { filePath });
});

function isValidUpdateId(id) {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]+$/.test(id) && id.length >= 1 && id.length <= 200;
}

module.exports = router;
