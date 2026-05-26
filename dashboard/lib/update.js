'use strict';

const { spawnSync, spawn: spawnNonSync } = require('node:child_process');

function createUpdateClient({
  ttlMs = 30000,
  spawnSyncFn = spawnSync,
  spawnFn = spawnNonSync,
  stateFile,
  cwd,
  sleep = defaultSleep,
  now = () => Date.now(),
} = {}) {
  let checkCache = null;
  let checkInflight = null;

  async function check() {
    const currentTime = now();
    if (checkCache && currentTime - checkCache.fetchedAt < ttlMs) {
      return checkCache.envelope;
    }

    if (checkInflight) {
      return checkInflight;
    }

    checkInflight = Promise.resolve().then(() => {
      const result = spawnSyncFn('hive', ['update', '--check', '--json'], {
        encoding: 'utf8',
        timeout: 30000,
        cwd,
      });

      if (result.status !== 0 && (!result.stdout || result.stdout.trim() === '')) {
        throw new Error(`hive update --check --json failed: rc=${result.status} stderr=${result.stderr || ''}`);
      }

      let envelope;
      try {
        envelope = JSON.parse(result.stdout);
      } catch (err) {
        throw new Error(`hive update --check --json output not valid JSON: ${err.message}`);
      }

      checkCache = { fetchedAt: now(), envelope };
      return envelope;
    }).finally(() => {
      checkInflight = null;
    });

    return checkInflight;
  }

  function clearCheckCache() {
    checkCache = null;
  }

  async function apply() {
    if (!stateFile) {
      throw new Error('apply: stateFile reader required (DI contract)');
    }

    const startedAtMs = now();
    const child = spawnFn('hive', ['update', '--yes'], {
      detached: true,
      stdio: 'ignore',
      cwd,
    });
    child.unref();

    const deadline = startedAtMs + 5000;
    while (now() < deadline) {
      const updateId = stateFile.findNewerThan(startedAtMs);
      if (updateId) {
        return {
          update_id: updateId,
          started_at: new Date(startedAtMs).toISOString(),
        };
      }
      await sleep(100);
    }

    const err = new Error('hive update did not create a state file within 5s');
    err.code = 'UPDATE_ID_NOT_DISCOVERED';
    throw err;
  }

  return { check, clearCheckCache, apply };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createUpdateClient };
