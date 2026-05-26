'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createStateFileReader({ stateRoot, fs: fsStub = fs } = {}) {
  if (!stateRoot) {
    throw new Error('createStateFileReader: stateRoot is required');
  }

  function pathFor(updateId) {
    return path.join(stateRoot, 'state', `update-${updateId}.jsonl`);
  }

  function readLast(updateId) {
    const filePath = pathFor(updateId);
    if (!fsStub.existsSync(filePath)) {
      return null;
    }

    const raw = fsStub.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) {
      return null;
    }

    try {
      return JSON.parse(lines[lines.length - 1]);
    } catch {
      return null;
    }
  }

  function readAll(updateId) {
    const filePath = pathFor(updateId);
    if (!fsStub.existsSync(filePath)) {
      return [];
    }

    const raw = fsStub.readFileSync(filePath, 'utf8');
    return raw
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter((event) => event !== null);
  }

  function findNewerThan(beforeTs) {
    const dir = path.join(stateRoot, 'state');
    if (!fsStub.existsSync(dir)) {
      return null;
    }

    const entries = fsStub.readdirSync(dir);
    let candidate = null;
    let candidateMtime = 0;
    for (const name of entries) {
      const match = name.match(/^update-(.+)\.jsonl$/);
      if (!match) {
        continue;
      }

      const stat = fsStub.statSync(path.join(dir, name));
      const mtime = stat.mtimeMs;
      if (mtime > beforeTs && mtime > candidateMtime) {
        candidate = match[1];
        candidateMtime = mtime;
      }
    }

    return candidate;
  }

  return { readLast, readAll, findNewerThan, pathFor };
}

module.exports = { createStateFileReader };
