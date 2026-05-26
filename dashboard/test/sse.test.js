'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createSseStream } = require('../lib/sse');

test('SSE response has the locked headers', async () => {
  const state = await makeStateFile(['{"phase":"start"}']);
  const harness = await startSseApp(state.filePath);

  try {
    const response = await fetch(`${harness.baseUrl}/stream`);
    assert.strictEqual(response.status, 200);
    assert.strictEqual(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assert.strictEqual(response.headers.get('cache-control'), 'no-cache, no-transform');
    assert.strictEqual(response.headers.get('connection'), 'keep-alive');
    assert.strictEqual(response.headers.get('x-accel-buffering'), 'no');
    response.body.cancel();
  } finally {
    await harness.close();
    cleanupDir(state.dir);
  }
});

test('initial replay emits existing lines as data events', async () => {
  const state = await makeStateFile(['{"phase":"start"}', '{"phase":"download-start"}']);
  const harness = await startSseApp(state.filePath);

  try {
    const chunks = await readStream(harness.baseUrl, { maxDataEvents: 2 });
    const payload = chunks.join('');
    assert.match(payload, /data: {"phase":"start"}/);
    assert.match(payload, /data: {"phase":"download-start"}/);
  } finally {
    await harness.close();
    cleanupDir(state.dir);
  }
});

test('new appended lines are emitted within tail polling window', async () => {
  const state = await makeStateFile(['{"phase":"start"}']);
  const harness = await startSseApp(state.filePath, { intervalMs: 100, heartbeatMs: 1000 });

  try {
    const readerPromise = readStream(harness.baseUrl, { maxDataEvents: 2, timeoutMs: 1500 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    fs.appendFileSync(state.filePath, '\n{"phase":"download-complete"}');
    const chunks = await readerPromise;
    assert.match(chunks.join(''), /data: {"phase":"download-complete"}/);
  } finally {
    await harness.close();
    cleanupDir(state.dir);
  }
});

test('heartbeat is emitted within heartbeatMs', async () => {
  const state = await makeStateFile(['{"phase":"start"}']);
  const harness = await startSseApp(state.filePath, { intervalMs: 500, heartbeatMs: 100 });

  try {
    const chunks = await readStream(harness.baseUrl, { wantHeartbeat: true, timeoutMs: 1000 });
    assert.match(chunks.join(''), /: heartbeat/);
  } finally {
    await harness.close();
    cleanupDir(state.dir);
  }
});

test('done event triggers stream auto-close after 500ms grace', async () => {
  const state = await makeStateFile(['{"phase":"done","detail":{"success":true}}']);
  const harness = await startSseApp(state.filePath, { intervalMs: 100, heartbeatMs: 1000 });

  const startedAt = Date.now();
  try {
    const chunks = await readStream(harness.baseUrl, { untilClosed: true, timeoutMs: 2000 });
    const elapsed = Date.now() - startedAt;
    assert.match(chunks.join(''), /data: {"phase":"done"/);
    assert.ok(elapsed >= 450, `expected auto-close grace, got ${elapsed}ms`);
  } finally {
    await harness.close();
    cleanupDir(state.dir);
  }
});

test('client disconnect clears polling and heartbeat intervals', async () => {
  const state = await makeStateFile(['{"phase":"start"}']);
  const activeIntervals = new Set();
  const originalSetInterval = global.setInterval;
  const originalClearInterval = global.clearInterval;

  global.setInterval = (fn, ms, ...args) => {
    const handle = originalSetInterval(fn, ms, ...args);
    activeIntervals.add(handle);
    return handle;
  };
  global.clearInterval = (handle) => {
    activeIntervals.delete(handle);
    return originalClearInterval(handle);
  };

  try {
    const harness = await startSseApp(state.filePath, { intervalMs: 100, heartbeatMs: 1000 });
    const response = await fetch(`${harness.baseUrl}/stream`);
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.strictEqual(activeIntervals.size, 0);
    await harness.close();
  } finally {
    global.setInterval = originalSetInterval;
    global.clearInterval = originalClearInterval;
    cleanupDir(state.dir);
  }
});

async function startSseApp(filePath, options = {}) {
  const app = express();
  app.get('/stream', (req, res) => {
    createSseStream(req, res, {
      filePath,
      intervalMs: options.intervalMs,
      heartbeatMs: options.heartbeatMs,
    });
  });

  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

async function makeStateFile(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd3-sse-'));
  const filePath = path.join(dir, 'update-test123.jsonl');
  fs.writeFileSync(filePath, lines.join('\n'));
  return { dir, filePath };
}

async function readStream(baseUrl, options = {}) {
  const { maxDataEvents, wantHeartbeat, untilClosed, timeoutMs = 1000 } = options;
  const response = await fetch(`${baseUrl}/stream`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let dataEvents = 0;

  const timeout = setTimeout(async () => {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      const chunk = decoder.decode(value, { stream: true });
      chunks.push(chunk);
      dataEvents += (chunk.match(/data: /g) || []).length;

      if (wantHeartbeat && chunk.includes(': heartbeat')) {
        await reader.cancel();
        break;
      }
      if (typeof maxDataEvents === 'number' && dataEvents >= maxDataEvents) {
        await reader.cancel();
        break;
      }
      if (!untilClosed && !wantHeartbeat && typeof maxDataEvents !== 'number' && chunks.length > 0) {
        await reader.cancel();
        break;
      }
    }
  } finally {
    clearTimeout(timeout);
  }

  return chunks;
}

function cleanupDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}
