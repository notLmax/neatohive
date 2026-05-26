'use strict';

const fs = require('node:fs');

function createSseStream(req, res, opts) {
  const {
    filePath,
    doneEventName = 'done',
    intervalMs = 250,
    heartbeatMs = 15000,
    fs: fsStub = fs,
  } = opts;

  res.set('Content-Type', 'text/event-stream');
  res.set('Cache-Control', 'no-cache, no-transform');
  res.set('Connection', 'keep-alive');
  res.set('X-Accel-Buffering', 'no');
  res.flushHeaders();

  let pos = 0;
  let closed = false;
  let autoCloseTimer = null;

  try {
    const stat = fsStub.statSync(filePath);
    const raw = fsStub.readFileSync(filePath, 'utf8');
    for (const line of raw.split('\n').filter((entry) => entry.length > 0)) {
      res.write(`data: ${line}\n\n`);
      maybeAutoClose(line);
    }
    pos = stat.size;
  } catch {
    cleanup();
    return;
  }

  const tailInterval = setInterval(() => {
    if (closed) {
      return;
    }

    try {
      const stat = fsStub.statSync(filePath);
      if (stat.size <= pos) {
        return;
      }

      const fd = fsStub.openSync(filePath, 'r');
      try {
        const buf = Buffer.alloc(stat.size - pos);
        fsStub.readSync(fd, buf, 0, buf.length, pos);
        pos = stat.size;
        for (const line of buf.toString('utf8').split('\n').filter((entry) => entry.length > 0)) {
          res.write(`data: ${line}\n\n`);
          maybeAutoClose(line);
        }
      } finally {
        fsStub.closeSync(fd);
      }
    } catch {
      // File may be temporarily unavailable mid-update; continue polling.
    }
  }, intervalMs);

  const heartbeatInterval = setInterval(() => {
    if (!closed) {
      res.write(': heartbeat\n\n');
    }
  }, heartbeatMs);

  function maybeAutoClose(line) {
    try {
      const event = JSON.parse(line);
      if (event && event.phase === doneEventName && !autoCloseTimer) {
        autoCloseTimer = setTimeout(() => {
          autoCloseTimer = null;
          cleanup();
        }, 500);
      }
    } catch {
      // Ignore malformed lines in the SSE relay; they are dropped elsewhere too.
    }
  }

  function cleanup() {
    if (closed) {
      return;
    }

    closed = true;
    clearInterval(tailInterval);
    clearInterval(heartbeatInterval);
    if (autoCloseTimer) {
      clearTimeout(autoCloseTimer);
      autoCloseTimer = null;
    }

    try {
      res.end();
    } catch {
      // Ignore double-close errors.
    }
  }

  req.on('close', cleanup);
  res.on('error', cleanup);
}

module.exports = { createSseStream };
