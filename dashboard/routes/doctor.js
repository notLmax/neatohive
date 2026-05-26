'use strict';

const express = require('express');

const router = express.Router();

router.get('/', async (req, res) => {
  const { doctor } = req.app.locals;

  try {
    const envelope = await doctor.getJson();
    res.status(200).json(envelope);
  } catch (err) {
    console.error('[hive-dashboard] /api/doctor error:', err);
    res.status(500).json({ error: 'doctor_failed', detail: err.message });
  }
});

module.exports = router;
