'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const { deriveActivity } = require('../lib/activity');

const router = express.Router();
const frameworkVersionCache = new Map();

router.get('/', async (req, res) => {
  const { pm2, runnerEvents, frameworkRoot, listAgents } = req.app.locals;

  try {
    const [processes, recentEvents, allEvents, agents] = await Promise.all([
      pm2.listProcesses().catch((err) => ({ __error: err.message })),
      runnerEvents.readLastN(20),
      runnerEvents.readAll(),
      Promise.resolve(listAgents()),
    ]);

    if (processes && processes.__error) {
      return res.status(200).json({
        version: '1',
        ts: new Date().toISOString(),
        framework_version: getFrameworkVersion(frameworkRoot),
        dashboard: {
          uptime_s: Math.floor(process.uptime()),
          node_version: process.version,
        },
        agents: {
          total: agents.length,
          by_state: { idle: agents.length, turn: 0, task: 0 },
        },
        pm2: {
          total: 0,
          online: 0,
          errored: 0,
          error: processes.__error,
        },
        recent_events: recentEvents,
      });
    }

    const byState = { idle: 0, turn: 0, task: 0 };
    for (const agentName of agents) {
      const activity = deriveActivity(allEvents, agentName);
      byState[activity.state] += 1;
    }

    const online = processes.filter((proc) => proc.pm2_env && proc.pm2_env.status === 'online').length;
    const errored = processes.filter((proc) => proc.pm2_env && proc.pm2_env.status === 'errored').length;

    return res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      framework_version: getFrameworkVersion(frameworkRoot),
      dashboard: {
        uptime_s: Math.floor(process.uptime()),
        node_version: process.version,
      },
      agents: {
        total: agents.length,
        by_state: byState,
      },
      pm2: {
        total: processes.length,
        online,
        errored,
      },
      recent_events: recentEvents,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/status error:', err);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

function getFrameworkVersion(frameworkRoot) {
  if (frameworkVersionCache.has(frameworkRoot)) {
    return frameworkVersionCache.get(frameworkRoot);
  }

  let version = 'unknown';

  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(frameworkRoot, 'package.json'), 'utf8'));
    version = pkg.version || 'unknown';
  } catch {
    version = 'unknown';
  }

  frameworkVersionCache.set(frameworkRoot, version);
  return version;
}

module.exports = router;
