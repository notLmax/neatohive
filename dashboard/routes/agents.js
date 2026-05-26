'use strict';

const express = require('express');
const fs = require('node:fs');
const { deriveActivity } = require('../lib/activity');

const router = express.Router();

router.get('/', async (req, res) => {
  const { pm2, runnerEvents, listAgents } = req.app.locals;

  try {
    const [processes, allEvents] = await Promise.all([
      pm2.listProcesses().catch(() => []),
      runnerEvents.readAll(),
    ]);

    const lastEventByAgent = new Map();
    for (let index = allEvents.length - 1; index >= 0; index -= 1) {
      const event = allEvents[index];
      if (!event.agent || lastEventByAgent.has(event.agent)) {
        continue;
      }
      lastEventByAgent.set(event.agent, event);
    }

    const agents = listAgents().map((name) => {
      const proc = processes.find((candidate) => candidate.name === name);
      const lastEvent = lastEventByAgent.get(name);

      return {
        name,
        pm2_status: proc && proc.pm2_env ? proc.pm2_env.status : 'not_running',
        current_activity: deriveActivity(allEvents, name),
        last_event_ts: lastEvent ? lastEvent.ts : null,
        last_event: lastEvent ? lastEvent.event : null,
      };
    });

    return res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      agents,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/agents error:', err);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

router.get('/:name', async (req, res) => {
  const { name } = req.params;
  const { pm2, runnerEvents, listAgents } = req.app.locals;

  if (!listAgents().includes(name)) {
    return res.status(404).json({ error: 'agent_not_found', name });
  }

  try {
    const [processes, allEvents] = await Promise.all([
      pm2.listProcesses().catch(() => []),
      runnerEvents.readAll(),
    ]);

    const proc = processes.find((candidate) => candidate.name === name);

    return res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      name,
      pm2: proc
        ? {
            status: proc.pm2_env ? proc.pm2_env.status : 'unknown',
            pid: proc.pid,
            cpu_percent: proc.monit ? proc.monit.cpu : null,
            memory_bytes: proc.monit ? proc.monit.memory : null,
            uptime_s: proc.pm2_env && proc.pm2_env.pm_uptime
              ? Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000)
              : null,
            restart_count: proc.pm2_env ? proc.pm2_env.restart_time : null,
          }
        : null,
      current_activity: deriveActivity(allEvents, name),
      recent_events: allEvents.filter((event) => event.agent === name).slice(-20),
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/agents/:name error:', err);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

router.post('/:name/restart', async (req, res) => {
  const { name } = req.params;
  const { pm2, listAgents } = req.app.locals;

  if (!listAgents().includes(name)) {
    return res.status(404).json({ error: 'agent_not_found', name });
  }

  try {
    const processes = await pm2.listProcesses();
    if (!processes.some((proc) => proc.name === name)) {
      return res.status(404).json({ error: 'agent_not_in_pm2', name });
    }
  } catch (err) {
    return res.status(500).json({ error: 'pm2_list_failed', detail: err.message });
  }

  try {
    pm2.restartProcess(name);
    return res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      name,
      restarted: true,
    });
  } catch (err) {
    return res.status(500).json({ error: 'pm2_restart_failed', detail: err.message });
  }
});

router.get('/:name/logs', async (req, res) => {
  const { name } = req.params;
  const { pm2, listAgents } = req.app.locals;
  const lines = Number.parseInt(req.query.lines || '100', 10);

  if (!listAgents().includes(name)) {
    return res.status(404).json({ error: 'agent_not_found', name });
  }

  if (!Number.isFinite(lines) || lines < 1 || lines > 1000) {
    return res.status(400).json({ error: 'bad_lines', detail: 'lines must be 1..1000' });
  }

  try {
    const processes = await pm2.listProcesses();
    const proc = processes.find((candidate) => candidate.name === name);
    if (!proc) {
      return res.status(404).json({ error: 'agent_not_in_pm2', name });
    }

    const stdout = await tailFile(proc.pm2_env && proc.pm2_env.pm_out_log_path, lines);
    const stderr = await tailFile(proc.pm2_env && proc.pm2_env.pm_err_log_path, lines);

    return res.status(200).json({
      version: '1',
      ts: new Date().toISOString(),
      name,
      lines_requested: lines,
      stdout,
      stderr,
    });
  } catch (err) {
    console.error('[hive-dashboard] /api/agents/:name/logs error:', err);
    return res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

async function tailFile(filePath, lines) {
  if (!filePath || !fs.existsSync(filePath)) {
    return [];
  }

  const raw = await fs.promises.readFile(filePath, 'utf8');
  const allLines = raw.split('\n');
  if (allLines.length > 0 && allLines[allLines.length - 1] === '') {
    allLines.pop();
  }
  return allLines.slice(-lines);
}

module.exports = router;
