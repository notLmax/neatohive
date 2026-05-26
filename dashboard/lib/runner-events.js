'use strict';

const fs = require('node:fs');

function createRunnerEventsReader({ logPath, fs: fsImpl = fs } = {}) {
  async function readLastN(limit = 100) {
    if (!fsImpl.existsSync(logPath)) {
      return [];
    }

    const raw = await fsImpl.promises.readFile(logPath, 'utf8');
    const lines = raw.split('\n').filter((line) => line.length > 0);
    const lastLines = lines.slice(-limit);
    return lastLines.map(parseLine).filter((event) => event !== null);
  }

  async function readAll() {
    return readLastN(Number.MAX_SAFE_INTEGER);
  }

  return {
    readLastN,
    readAll,
  };
}

function parseLine(line) {
  try {
    const parsed = JSON.parse(line);
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    if (typeof parsed.ts !== 'string' || typeof parsed.event !== 'string') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

module.exports = { createRunnerEventsReader, parseLine };
