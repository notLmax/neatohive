'use strict';

const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAuthMiddleware } = require('./middleware/auth');
const { createPm2Client } = require('./lib/pm2');
const { createRunnerEventsReader } = require('./lib/runner-events');
const { createDoctorClient } = require('./lib/doctor');
const { createUpdateClient } = require('./lib/update');
const { createStateFileReader } = require('./lib/state-file');
const { createBackupsClient } = require('./lib/backups');
const healthRouter = require('./routes/health');
const statusRouter = require('./routes/status');
const agentsRouter = require('./routes/agents');
const doctorRouter = require('./routes/doctor');
const updateRouter = require('./routes/update');
const sessionsRouter = require('./routes/sessions');
const tasksRouter = require('./routes/tasks');
const runnerEventsRouter = require('./routes/runner-events');
const backupsRouter = require('./routes/backups');
const { createAuthConfigRouter } = require('./routes/auth-config');

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

function createApp({ token, bus, pm2, runnerEvents, frameworkRoot, listAgents, doctor, update, stateFile, sessions, tasks, backups } = {}) {
  const authRequired = process.env.DASHBOARD_REQUIRE_AUTH === 'true';
  if (authRequired && !token) {
    throw new Error('createApp: token is required');
  }

  const root = frameworkRoot || process.cwd();
  const stateRoot = process.env.HIVE_STATE_ROOT || path.join(os.homedir(), '.neato-hive');
  const pm2Client = pm2 || createPm2Client();
  const runnerEventsReader = runnerEvents || createRunnerEventsReader({
    logPath: path.join(root, 'data', 'runner-events.log'),
  });
  const agentsLister = listAgents || (() => listDeclaredAgents(root));
  const stateFileReader = stateFile || createStateFileReader({ stateRoot });
  const doctorClient = doctor || createDoctorClient({ cwd: root });
  const updateClient = update || createUpdateClient({ stateFile: stateFileReader, cwd: root });
  const backupsClient = backups || createBackupsClient({ installRoot: root });

  const app = express();
  app.locals.pm2 = pm2Client;
  app.locals.runnerEvents = runnerEventsReader;
  app.locals.frameworkRoot = root;
  app.locals.listAgents = agentsLister;
  app.locals.stateFile = stateFileReader;
  app.locals.doctor = doctorClient;
  app.locals.update = updateClient;
  app.locals.sessions = sessions || null;
  app.locals.tasks = tasks || null;
  app.locals.backups = backupsClient;
  app.locals.bus = bus || null;
  app.locals.uploadRoot = path.join(root, 'data', 'dashboard-uploads');

  app.use(express.json({ limit: '1mb' }));
  // E.1 — serve frontend static assets BEFORE the auth gate.
  app.use(express.static(path.join(__dirname, 'public')));
  app.use('/api/health', healthRouter);
  app.use('/api/auth-config', createAuthConfigRouter({ required: authRequired }));
  if (authRequired) {
    const auth = createAuthMiddleware(token);
    app.use(auth);
  }
  app.use('/api/status', statusRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/doctor', doctorRouter);
  app.use('/api/update', updateRouter);
  app.use('/api/sessions', sessionsRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/runner-events', runnerEventsRouter);
  app.use('/api/backups', backupsRouter);
  app.post('/api/upload', async (req, res) => {
    try {
      const upload = await parseMultipartImage(req);
      await fs.promises.mkdir(req.app.locals.uploadRoot, { recursive: true });
      const extension = IMAGE_EXTENSIONS.get(upload.mediaType) || extensionFromFilename(upload.filename) || '.bin';
      const id = `${crypto.randomUUID()}${extension}`;
      const filePath = path.join(req.app.locals.uploadRoot, id);
      await fs.promises.writeFile(filePath, upload.buffer);

      return res.status(200).json({
        id,
        url: `/uploads/${encodeURIComponent(id)}`,
        mediaType: upload.mediaType,
      });
    } catch (err) {
      if (err && err.statusCode) {
        return res.status(err.statusCode).json({ error: err.code || 'upload_error', detail: err.message });
      }

      console.error('[hive-dashboard] /api/upload error:', err);
      return res.status(500).json({ error: 'internal_error' });
    }
  });

  app.get('/uploads/:file', async (req, res) => {
    const fileName = sanitizeUploadName(req.params.file);
    if (!fileName) {
      return res.status(400).json({ error: 'bad_upload_name' });
    }

    const filePath = path.join(req.app.locals.uploadRoot, fileName);
    if (!filePath.startsWith(req.app.locals.uploadRoot + path.sep) && filePath !== path.join(req.app.locals.uploadRoot, fileName)) {
      return res.status(400).json({ error: 'bad_upload_name' });
    }

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'upload_not_found' });
    }

    const mediaType = mediaTypeFromFilename(fileName) || 'application/octet-stream';
    res.type(mediaType);
    return res.sendFile(filePath);
  });

  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  app.use((err, req, res, next) => {
    console.error('[hive-dashboard] error:', err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

function sanitizeUploadName(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const decoded = decodeURIComponent(value);
  if (!/^[a-f0-9-]+\.(jpg|jpeg|png|gif|webp)$/i.test(decoded)) {
    return null;
  }

  return decoded;
}

function extensionFromFilename(filename) {
  if (typeof filename !== 'string') {
    return '';
  }

  const ext = path.extname(filename).toLowerCase();
  if (ext === '.jpeg') {
    return '.jpg';
  }
  return ext;
}

function mediaTypeFromFilename(filename) {
  const ext = extensionFromFilename(filename);
  if (ext === '.jpg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return null;
}

function createHttpError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

async function parseMultipartImage(req) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) {
    throw createHttpError(400, 'bad_content_type', 'expected multipart/form-data');
  }

  const boundary = match[1] || match[2];
  const body = await readRequestBody(req, MAX_UPLOAD_BYTES);
  const parts = splitMultipartBody(body, boundary);

  for (const part of parts) {
    const parsed = parseMultipartPart(part);
    if (!parsed) {
      continue;
    }

    const disposition = parsed.headers['content-disposition'] || '';
    if (!/form-data/i.test(disposition) || !/name="file"/i.test(disposition)) {
      continue;
    }

    const filenameMatch = disposition.match(/filename="([^"]+)"/i);
    if (!filenameMatch || !filenameMatch[1]) {
      throw createHttpError(400, 'missing_filename', 'upload is missing a filename');
    }

    const mediaType = (parsed.headers['content-type'] || '').toLowerCase();
    if (!mediaType.startsWith('image/')) {
      throw createHttpError(400, 'bad_media_type', 'only image uploads are allowed');
    }

    if (!IMAGE_EXTENSIONS.has(mediaType)) {
      throw createHttpError(400, 'unsupported_media_type', `unsupported image type: ${mediaType}`);
    }

    return {
      filename: path.basename(filenameMatch[1]),
      mediaType,
      buffer: parsed.body,
    };
  }

  throw createHttpError(400, 'missing_file', 'multipart body did not contain a file field');
}

function splitMultipartBody(body, boundary) {
  const marker = Buffer.from(`--${boundary}`);
  const parts = [];
  let cursor = body.indexOf(marker);

  while (cursor !== -1) {
    cursor += marker.length;
    if (body.slice(cursor, cursor + 2).equals(Buffer.from('--'))) {
      break;
    }
    if (body[cursor] === 13 && body[cursor + 1] === 10) {
      cursor += 2;
    }

    const nextMarker = body.indexOf(marker, cursor);
    if (nextMarker === -1) {
      break;
    }

    let end = nextMarker;
    if (body[end - 2] === 13 && body[end - 1] === 10) {
      end -= 2;
    }
    parts.push(body.slice(cursor, end));
    cursor = nextMarker;
  }

  return parts;
}

function parseMultipartPart(part) {
  const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
  if (headerEnd === -1) {
    return null;
  }

  const rawHeaders = part.slice(0, headerEnd).toString('utf8');
  const body = part.slice(headerEnd + 4);
  const headers = {};

  for (const line of rawHeaders.split('\r\n')) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex === -1) {
      continue;
    }
    const key = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    headers[key] = value;
  }

  return { headers, body };
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(createHttpError(413, 'upload_too_large', `upload exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });

    req.on('error', (err) => {
      reject(err);
    });
  });
}

function listDeclaredAgents(frameworkRoot) {
  const agentsDir = path.join(frameworkRoot, 'agents');
  if (!fs.existsSync(agentsDir)) {
    return [];
  }

  return fs.readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'));
}

module.exports = { createApp };
