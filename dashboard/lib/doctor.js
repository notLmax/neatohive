'use strict';

const { spawnSync } = require('node:child_process');

function createDoctorClient({ ttlMs = 5000, spawn = spawnSync, cwd } = {}) {
  let cache = null;
  let inflight = null;

  async function getJson() {
    const now = Date.now();
    if (cache && now - cache.fetchedAt < ttlMs) {
      return cache.envelope;
    }

    if (inflight) {
      return inflight;
    }

    inflight = Promise.resolve().then(() => {
      const result = spawn('hive', ['doctor', '--json'], {
        encoding: 'utf8',
        timeout: 30000,
        cwd,
      });

      if (result.status !== 0 && (!result.stdout || result.stdout.trim() === '')) {
        throw new Error(`hive doctor --json failed: rc=${result.status} stderr=${result.stderr || ''}`);
      }

      let envelope;
      try {
        envelope = JSON.parse(result.stdout);
      } catch (err) {
        throw new Error(`hive doctor --json output not valid JSON: ${err.message}`);
      }

      cache = { fetchedAt: Date.now(), envelope };
      return envelope;
    }).finally(() => {
      inflight = null;
    });

    return inflight;
  }

  function clearCache() {
    cache = null;
  }

  return { getJson, clearCache };
}

module.exports = { createDoctorClient };
