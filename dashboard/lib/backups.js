'use strict';

const fs = require('node:fs');
const path = require('node:path');

function createBackupsClient({ installRoot, fs: fsStub = fs } = {}) {
  function listBackups() {
    if (!fsStub.existsSync(installRoot)) {
      return { backups: [], total: 0 };
    }

    const entries = fsStub.readdirSync(installRoot, { withFileTypes: true });
    const groups = new Map();
    const pattern = /^\.(.+)\.old\.(\d{8}-\d{6})$/;

    for (const entry of entries) {
      const match = entry.name.match(pattern);
      if (!match) {
        continue;
      }

      const [, item, ts] = match;
      if (!groups.has(ts)) {
        groups.set(ts, { items: [], total_size_bytes: 0 });
      }

      const group = groups.get(ts);
      const fullPath = path.join(installRoot, entry.name);
      let size = 0;

      try {
        size = fsStub.statSync(fullPath).size;
      } catch {
        size = 0;
      }

      group.items.push({ name: entry.name, item, size });
      group.total_size_bytes += size;
    }

    const tsOrder = Array.from(groups.keys()).sort().reverse();
    const backups = tsOrder.map((ts, index) => ({
      id: ts,
      created_at: parseTsToIso(ts),
      items_count: groups.get(ts).items.length,
      total_size_bytes: groups.get(ts).total_size_bytes,
      is_latest: index === 0,
    }));

    return { backups, total: backups.length };
  }

  return { listBackups };
}

function parseTsToIso(ts) {
  const match = ts.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/);
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
}

module.exports = { createBackupsClient };
