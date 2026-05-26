'use strict';

const { spawnSync } = require('node:child_process');

function createPm2Client({ ttlMs = 1500, spawn = spawnSync } = {}) {
  let cache = null;
  let inflight = null;

  async function listProcesses() {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < ttlMs) {
      return cache.processes;
    }

    if (inflight) {
      return inflight;
    }

    inflight = Promise.resolve().then(() => {
      const result = spawn('pm2', ['jlist'], {
        encoding: 'utf8',
        timeout: 5000,
      });

      if (result.status !== 0) {
        throw new Error(`pm2 jlist failed: rc=${result.status} stderr=${result.stderr || ''}`);
      }

      const processes = JSON.parse(result.stdout || '[]');
      cache = { fetchedAt: Date.now(), processes };
      return processes;
    }).finally(() => {
      inflight = null;
    });

    return inflight;
  }

  function restartProcess(name) {
    const result = spawn('pm2', ['restart', name], {
      encoding: 'utf8',
      timeout: 10000,
    });

    cache = null;

    if (result.status !== 0) {
      const err = new Error(`pm2 restart failed: rc=${result.status} stderr=${result.stderr || ''}`);
      err.code = 'PM2_RESTART_FAILED';
      throw err;
    }

    return { name, restarted: true };
  }

  function clearCache() {
    cache = null;
  }

  return {
    listProcesses,
    restartProcess,
    clearCache,
  };
}

module.exports = { createPm2Client };
