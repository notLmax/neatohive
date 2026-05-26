'use strict';

const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const { createApp } = require('./app');
const { createChatBus } = require('./lib/chat-bus');
const { attachWsServer } = require('./lib/ws');

const PORT = parseInt(process.env.HIVE_DASHBOARD_PORT || '7777', 10);
const HOST = process.env.HIVE_DASHBOARD_HOST || '127.0.0.1';
const AUTH_REQUIRED = process.env.DASHBOARD_REQUIRE_AUTH === 'true';
const DASHBOARD_TOKEN = process.env.HIVE_DASHBOARD_TOKEN;

if (AUTH_REQUIRED && (!DASHBOARD_TOKEN || DASHBOARD_TOKEN.length < 32)) {
  console.error('[hive-dashboard] FATAL: HIVE_DASHBOARD_TOKEN is unset or too short.');
  console.error('[hive-dashboard] Run `hive update` (which triggers v1.5.0 migration) or set the var manually.');
  process.exit(1);
}

if (!AUTH_REQUIRED) {
  console.log('[hive-dashboard] auth disabled (DASHBOARD_REQUIRE_AUTH not set to true)');
}

const bus = createChatBus();
const app = createApp({ token: DASHBOARD_TOKEN, bus });

const server = app.listen(PORT, HOST, () => {
  console.log(`[hive-dashboard] listening on ${HOST}:${PORT}`);
});

attachWsServer(server, {
  token: DASHBOARD_TOKEN,
  bus,
  ringSize: 200,
});

function shutdown(signal) {
  console.log(`[hive-dashboard] received ${signal}, closing server...`);
  server.close((err) => {
    if (err) {
      console.error('[hive-dashboard] error during close:', err);
      process.exit(1);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[hive-dashboard] close timeout — forcing exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
