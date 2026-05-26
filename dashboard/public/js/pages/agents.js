'use strict';

import { apiFetch, apiJson } from '/js/api.js';
import {
  activityClass,
  formatBytes,
  formatDuration,
  isNearBottom,
  pm2StatusClass,
  relativeTime,
  selectRecentTasksForAgent,
  taskStatusClass,
  truncate,
} from '/js/pages/agents-utils.js';

const POLL_LIST_MS = 5000;
const POLL_FAST_MS = 1000;
const POLL_SLOW_MS = 5000;
const LOGS_TAIL_LINES = 200;
const TASKS_FETCH_LIMIT = 200;
const RESTART_FLASH_MS = 2000;

export function renderAgents(main) {
  const name = parseQueryParam('name');

  if (name) {
    renderAgentDetail(main, name);
    return;
  }

  renderAgentList(main);
}

function parseQueryParam(key) {
  try {
    return new URLSearchParams(window.location.search).get(key);
  } catch {
    return null;
  }
}

function renderAgentList(main) {
  main.innerHTML = `
    <div class="agents-page-header">
      <h1>Agents</h1>
    </div>
    <section class="overview-card agents-list-card">
      <div id="agents-list-body"></div>
    </section>
  `;

  let listHandle = null;
  let inFlight = false;

  async function refresh() {
    if (inFlight) {
      return;
    }

    inFlight = true;

    try {
      const payload = await apiJson('/api/agents').catch(() => null);
      renderListBody(payload);
    } finally {
      inFlight = false;
    }
  }

  function renderListBody(payload) {
    const body = document.getElementById('agents-list-body');

    if (!payload || !Array.isArray(payload.agents)) {
      body.innerHTML = '<p class="muted">Agent list unavailable.</p>';
      return;
    }

    if (payload.agents.length === 0) {
      body.innerHTML = '<p class="muted">No agents declared.</p>';
      return;
    }

    body.innerHTML = `
      <table class="agents-table">
        <thead>
          <tr>
            <th>Agent</th>
            <th>PM2</th>
            <th>Activity</th>
            <th>Last event</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${payload.agents.map((agent) => {
            const activity = agent.current_activity || { state: 'idle' };
            const detailHref = `/agents.html?name=${encodeURIComponent(agent.name)}`;

            return `
              <tr class="agents-row" tabindex="0" data-href="${detailHref}">
                <td class="agents-cell-name">${escape(agent.name)}</td>
                <td><span class="pill pill-status-${pm2StatusClass(agent.pm2_status)}">${escape(agent.pm2_status || 'unknown')}</span></td>
                <td><span class="pill pill-activity-${activityClass(activity.state)}">${escape(activity.state || 'idle')}</span></td>
                <td class="agents-cell-last-event">${renderLastEvent(agent)}</td>
                <td class="agents-cell-link"><a href="${detailHref}">Detail →</a></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;

    bindListRowNavigation(body);
  }

  function startPolling() {
    void refresh();
    listHandle = window.setInterval(() => {
      void refresh();
    }, POLL_LIST_MS);
  }

  function stopPolling() {
    if (listHandle) {
      window.clearInterval(listHandle);
      listHandle = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopPolling();
    } else if (!listHandle) {
      startPolling();
    }
  });

  if (document.visibilityState !== 'hidden') {
    startPolling();
  }
}

function bindListRowNavigation(container) {
  container.querySelectorAll('.agents-row[data-href]').forEach((row) => {
    row.addEventListener('click', (event) => {
      if (event.target && event.target.closest('a')) {
        return;
      }

      const href = row.getAttribute('data-href');
      if (href) {
        window.location.href = href;
      }
    });

    row.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') {
        return;
      }

      event.preventDefault();
      const href = row.getAttribute('data-href');
      if (href) {
        window.location.href = href;
      }
    });
  });
}

function renderAgentDetail(main, name) {
  main.innerHTML = `
    <div class="agents-page-header">
      <a class="agents-back-link" href="/agents.html">← Back to agents</a>
    </div>
    <header class="agent-detail-header">
      <div class="agent-detail-title">
        <h1>${escape(name)}</h1>
        <div class="agent-detail-pills" id="agent-detail-pills"></div>
      </div>
      <div class="agent-detail-actions">
        <button type="button" id="agent-restart-btn" class="agent-restart-btn">Restart</button>
        <span id="agent-restart-status" class="agent-restart-status"></span>
      </div>
    </header>
    <div id="agent-detail-error" class="agent-detail-error"></div>
    <div class="overview-grid agent-detail-grid">
      <section class="overview-card agent-activity-card">
        <h2>Current activity</h2>
        <dl id="agent-activity-body" class="agent-kv"></dl>
      </section>
      <section class="overview-card agent-pm2-card">
        <h2>PM2 stats</h2>
        <dl id="agent-pm2-body" class="agent-kv"></dl>
      </section>
    </div>
    <section class="overview-card agent-logs-card">
      <h2>Logs <span class="muted agent-logs-hint">tail ${LOGS_TAIL_LINES} lines</span></h2>
      <div class="agent-logs-grid">
        <div class="agent-log-pane">
          <h3>stdout</h3>
          <pre id="agent-log-stdout" class="agent-log-pre"></pre>
        </div>
        <div class="agent-log-pane">
          <h3>stderr</h3>
          <pre id="agent-log-stderr" class="agent-log-pre"></pre>
        </div>
      </div>
    </section>
    <section class="overview-card agent-tasks-card">
      <h2>Recent tasks <span class="muted">(this agent)</span></h2>
      <div id="agent-tasks-body"></div>
    </section>
    <section class="overview-card agent-events-card">
      <h2>Recent runner events <span class="muted">(this agent, last 20)</span></h2>
      <ul id="agent-events-body" class="events-list"></ul>
    </section>
  `;

  let fastHandle = null;
  let slowHandle = null;
  let fastInFlight = false;
  let slowInFlight = false;
  let restartFlashTimer = null;
  let notFound = false;

  const restartButton = document.getElementById('agent-restart-btn');
  restartButton.addEventListener('click', async () => {
    const confirmed = window.confirm(`Restart "${name}"? PM2 will kill the process and respawn it.`);
    if (!confirmed) {
      return;
    }

    restartButton.disabled = true;
    restartButton.classList.add('restart-pending');
    setRestartStatus('Restarting…', 'pending');

    try {
      const response = await apiFetch(`/api/agents/${encodeURIComponent(name)}/restart`, { method: 'POST' });
      if (!response.ok) {
        const errorBody = await response.json().catch(() => ({}));
        setRestartStatus(errorBody.error || `Restart failed (HTTP ${response.status})`, 'fail');
        restartButton.disabled = false;
        restartButton.classList.remove('restart-pending');
        return;
      }

      setRestartStatus('Restarted', 'ok');
      await fastTick();

      if (restartFlashTimer) {
        window.clearTimeout(restartFlashTimer);
      }

      restartFlashTimer = window.setTimeout(() => {
        setRestartStatus('', '');
        restartButton.disabled = false;
        restartButton.classList.remove('restart-pending');
      }, RESTART_FLASH_MS);
    } catch (error) {
      setRestartStatus(error.message || 'Restart failed', 'fail');
      restartButton.disabled = false;
      restartButton.classList.remove('restart-pending');
    }
  });

  function setRestartStatus(text, kind) {
    const element = document.getElementById('agent-restart-status');
    element.textContent = text || '';
    element.className = `agent-restart-status ${kind ? `restart-status-${kind}` : ''}`.trim();
  }

  async function fastTick() {
    if (fastInFlight || notFound) {
      return;
    }

    fastInFlight = true;

    try {
      const response = await apiFetch(`/api/agents/${encodeURIComponent(name)}`);
      if (response.status === 404) {
        notFound = true;
        renderNotFound();
        stopPolling();
        return;
      }
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const payload = await response.json();
      clearError();
      renderHeaderPills(payload);
      renderActivity(payload);
      renderPm2(payload);
      renderRecentEvents(payload);
    } catch (error) {
      renderError(error.message || 'Agent unavailable');
    } finally {
      fastInFlight = false;
    }
  }

  async function slowTick() {
    if (slowInFlight || notFound) {
      return;
    }

    slowInFlight = true;

    try {
      const [logsResult, tasksResult] = await Promise.allSettled([
        apiJson(`/api/agents/${encodeURIComponent(name)}/logs?lines=${LOGS_TAIL_LINES}`),
        apiJson(`/api/tasks?limit=${TASKS_FETCH_LIMIT}`),
      ]);

      renderLogs(logsResult.status === 'fulfilled' ? logsResult.value : null);
      renderRecentTasks(tasksResult.status === 'fulfilled' ? tasksResult.value : null);
    } finally {
      slowInFlight = false;
    }
  }

  function renderHeaderPills(payload) {
    const element = document.getElementById('agent-detail-pills');
    const pm2 = payload.pm2 || {};
    const activity = payload.current_activity || { state: 'idle' };

    element.innerHTML = `
      <span class="pill pill-status-${pm2StatusClass(pm2.status)}">${escape(pm2.status || 'unknown')}</span>
      <span class="pill pill-activity-${activityClass(activity.state)}">${escape(activity.state || 'idle')}</span>
    `;
  }

  function renderActivity(payload) {
    const body = document.getElementById('agent-activity-body');
    const activity = payload.current_activity || { state: 'idle', task_id: null, since: null };
    const taskLabel = activity.task_id
      ? `<a href="/tasks.html">${escape(truncate(activity.task_id, 32))}</a>`
      : '—';

    body.innerHTML = `
      <dt>State</dt><dd><span class="pill pill-activity-${activityClass(activity.state)}">${escape(activity.state || 'idle')}</span></dd>
      <dt>Task ID</dt><dd>${taskLabel}</dd>
      <dt>Since</dt><dd>${escape(activity.since ? relativeTime(activity.since) : '—')}</dd>
    `;
  }

  function renderPm2(payload) {
    const body = document.getElementById('agent-pm2-body');
    const pm2 = payload.pm2;

    if (!pm2) {
      body.innerHTML = '<dt>Status</dt><dd class="muted">Not in PM2</dd>';
      return;
    }

    body.innerHTML = `
      <dt>Status</dt><dd><span class="pill pill-status-${pm2StatusClass(pm2.status)}">${escape(pm2.status || 'unknown')}</span></dd>
      <dt>PID</dt><dd>${escape(pm2.pid != null ? String(pm2.pid) : '—')}</dd>
      <dt>Uptime</dt><dd>${escape(pm2.uptime_s != null ? formatDuration(pm2.uptime_s * 1000) : '—')}</dd>
      <dt>CPU</dt><dd>${escape(pm2.cpu_percent != null ? `${pm2.cpu_percent.toFixed(1)} %` : '—')}</dd>
      <dt>Memory</dt><dd>${escape(pm2.memory_bytes != null ? formatBytes(pm2.memory_bytes) : '—')}</dd>
      <dt>Restart count</dt><dd>${escape(pm2.restart_count != null ? String(pm2.restart_count) : '—')}</dd>
    `;
  }

  function renderRecentEvents(payload) {
    const list = document.getElementById('agent-events-body');

    if (!payload || !Array.isArray(payload.recent_events)) {
      list.innerHTML = '<li class="muted">Recent events unavailable</li>';
      return;
    }

    const events = payload.recent_events.slice().reverse();
    if (events.length === 0) {
      list.innerHTML = '<li class="muted">No recent events</li>';
      return;
    }

    list.innerHTML = events.map((event) => `
      <li class="event-row">
        <span class="event-time">${escape(relativeTime(event.ts))}</span>
        <span class="event-kind">${escape(event.event || 'unknown')}</span>
        <span class="event-agent">${escape(event.agent || '')}</span>
        <span class="event-taskid">${escape(truncate(event.taskId || '', 12))}</span>
      </li>
    `).join('');
  }

  function renderLogs(logsPayload) {
    const stdout = document.getElementById('agent-log-stdout');
    const stderr = document.getElementById('agent-log-stderr');

    if (!logsPayload) {
      stdout.textContent = '(unavailable)';
      stderr.textContent = '(unavailable)';
      return;
    }

    renderLogStream(stdout, logsPayload.stdout);
    renderLogStream(stderr, logsPayload.stderr);
  }

  function renderLogStream(element, lines) {
    const wasNearBottom = isNearBottom(element);
    element.textContent = (Array.isArray(lines) ? lines : []).join('\n');
    if (wasNearBottom) {
      element.scrollTop = element.scrollHeight;
    }
  }

  function renderRecentTasks(tasksPayload) {
    const body = document.getElementById('agent-tasks-body');

    if (!tasksPayload || !Array.isArray(tasksPayload.tasks)) {
      body.innerHTML = '<p class="muted">Tasks unavailable.</p>';
      return;
    }

    const tasks = selectRecentTasksForAgent(tasksPayload.tasks, name, 20);
    if (tasks.length === 0) {
      body.innerHTML = '<p class="muted">No recent tasks for this agent.</p>';
      return;
    }

    body.innerHTML = `
      <table class="agent-tasks-table">
        <thead>
          <tr>
            <th>Task ID</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Started</th>
            <th>Elapsed</th>
            <th>Last event</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map((task) => `
            <tr>
              <td class="task-cell-id"><code>${escape(truncate(task.taskId || '', 28))}</code></td>
              <td>${escape(task.kind || '—')}</td>
              <td><span class="pill pill-task-${taskStatusClass(task.status)}">${escape(task.status || 'unknown')}</span></td>
              <td>${escape(task.started_at ? relativeTime(task.started_at) : '—')}</td>
              <td>${escape(task.elapsed_ms != null ? formatDuration(task.elapsed_ms) : '—')}</td>
              <td class="muted">${escape(task.last_runner_event || '—')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderNotFound() {
    document.getElementById('agent-detail-error').innerHTML = `
      <p class="agent-detail-error-msg">Agent not found: <code>${escape(name)}</code></p>
      <p><a href="/agents.html">← Back to agents</a></p>
    `;

    const header = document.querySelector('.agent-detail-header');
    if (header) {
      header.style.display = 'none';
    }

    document.querySelectorAll('.overview-card').forEach((card) => {
      card.style.display = 'none';
    });
  }

  function renderError(message) {
    const element = document.getElementById('agent-detail-error');
    element.textContent = message;
    element.classList.add('agent-detail-error-active');
  }

  function clearError() {
    const element = document.getElementById('agent-detail-error');
    element.textContent = '';
    element.classList.remove('agent-detail-error-active');
  }

  function startPolling() {
    void fastTick();
    void slowTick();
    fastHandle = window.setInterval(() => {
      void fastTick();
    }, POLL_FAST_MS);
    slowHandle = window.setInterval(() => {
      void slowTick();
    }, POLL_SLOW_MS);
  }

  function stopPolling() {
    if (fastHandle) {
      window.clearInterval(fastHandle);
      fastHandle = null;
    }

    if (slowHandle) {
      window.clearInterval(slowHandle);
      slowHandle = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopPolling();
    } else if (!fastHandle && !slowHandle && !notFound) {
      startPolling();
    }
  });

  if (document.visibilityState !== 'hidden') {
    startPolling();
  }
}

function renderLastEvent(agent) {
  if (!agent.last_event_ts) {
    return '—';
  }

  return `${escape(agent.last_event || '')} · ${escape(relativeTime(agent.last_event_ts))}`;
}

function escape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => {
    return {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      '\'': '&#39;',
    }[char];
  });
}
