/**
 * ecosystem.config.cjs
 * PM2 ecosystem config for the Neato Hive.
 *
 * PR 2a (autonomy-v1) registers the new `hive-runner` daemon here.
 *
 * Existing agent processes (atlas, glados, house-md, etc.) are still
 * managed by the legacy `pm2 start dist/index.js --name <agent>` pattern
 * for now — adding them to this file is a v1.3.x migration item, not
 * required for the runner to function.
 *
 * To add the runner to a running Hive:
 *   pnpm build
 *   pm2 start ecosystem.config.cjs --only hive-runner
 *   pm2 save
 *
 * To stop only the runner:
 *   pm2 stop hive-runner
 *
 * Logs:
 *   pm2 logs hive-runner
 *   tail -f data/runner-events.log
 */

module.exports = {
  apps: [
    {
      name: "hive-runner",
      script: "dist/runner/main.js",
      cwd: __dirname,
      // The runner is a single long-running daemon — no clustering.
      instances: 1,
      exec_mode: "fork",
      // Auto-restart on crash, capped to avoid hot loops.
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      // Resource hints: the runner itself is light; child processes (codex
      // sessions etc.) live in their own PIDs and don't count here.
      max_memory_restart: "300M",
      // Don't watch the source tree — pm2 reload after a build is the
      // intended workflow.
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
    // PR D.1 (v1.5.0) registers the new `hive-dashboard` daemon — local
    // Express service binding 0.0.0.0:7777, gated by HIVE_DASHBOARD_TOKEN.
    // C.7 migration handler generates the token in .env on first v1.5.0
    // update. Owner ceremony post-merge applies the ecosystem change.
    {
      name: "hive-dashboard",
      script: "dashboard/index.js",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_restarts: 10,
      min_uptime: "10s",
      max_memory_restart: "300M",
      watch: false,
      env: {
        NODE_ENV: "production",
      },
    },
  ],
};
