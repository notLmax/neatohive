'use strict';

const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { backups } = req.app.locals;

  try {
    const result = backups.listBackups();
    res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      backups: result.backups,
      total: result.total,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/backups error:', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

module.exports = router;
