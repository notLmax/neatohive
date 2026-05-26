'use strict';

const express = require('express');

function createAuthConfigRouter({ required = false } = {}) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.set('cache-control', 'no-store');
    res.status(200).json({ required: required === true });
  });

  return router;
}

module.exports = { createAuthConfigRouter };
