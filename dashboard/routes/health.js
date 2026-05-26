'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');

const router = express.Router();

let cachedFrameworkVersion = null;

function getFrameworkVersion() {
  if (cachedFrameworkVersion) {
    return cachedFrameworkVersion;
  }

  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    cachedFrameworkVersion = pkg.version || 'unknown';
  } catch (err) {
    cachedFrameworkVersion = 'unknown';
  }

  return cachedFrameworkVersion;
}

router.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime_s: Math.floor(process.uptime()),
    version: getFrameworkVersion(),
    ts: new Date().toISOString(),
  });
});

module.exports = router;
