'use strict';

import { apiJson } from '/js/api.js';
import {
  activityClass,
  deriveOverallStatus,
  deriveUpdateBanner,
  pm2StatusClass,
  relativeTime,
  truncate,
} from '/js/pages/overview-utils.js';
import { setShellVersion } from '/js/shell.js';

const POLL_MS = 5000;

export function renderOverview(main) {
  main.innerHTML = `
    <section class="overview-heading">
      <h1>Overview</h1>
      <p class="muted">Hive status, active sessions, agent activity, and recent runner events.</p>
    </section>
    <div class="overview-status" id="overview-status"></div>
    <div class="overview-update" id="overview-update"></div>
    <div class="overview-grid">
      <section class="overview-card overview-sessions" id="overview-sessions" aria-live="polite"></section>
      <section class="overview-card overview-agents">
        <div class="overview-card-header">
          <h2>Agents</h2>
          <a class="overview-card-link" href="/agents.html">View all</a>
        </div>
        <div id="overview-agents-list" class="agents-list" aria-live="polite"></div>
      </section>
      <section class="overview-card overview-events">
        <div class="overview-card-header">
          <h2>Recent runner events</h2>
          <a class="overview-card-link" href="/runner-events">Open log</a>
        </div>
        <ul id="overview-events-list" class="events-list" aria-live="polite"></ul>
      </section>
    </div>
  `;

  const statusEl = document.getElementById('overview-status');
  const updateEl = document.getElementById('overview-update');
  const sessionsEl = document.getElementById('overview-sessions');
  const agentsListEl = document.getElementById('overview-agents-list');
  const eventsListEl = document.getElementById('overview-events-list');

  let pollHandle = null;
  let inFlight = false;

  async function refresh() {
    if (inFlight) {
      return;
    }

    inFlight = true;

    try {
      const [statusResult, agentsResult, updateResult, sessionsResult] = await Promise.allSettled([
        apiJson('/api/status'),
        apiJson('/api/agents'),
        apiJson('/api/update/check'),
        apiJson('/api/sessions/active'),
      ]);

      const status = statusResult.status === 'fulfilled' ? statusResult.value : null;
      const agents = agentsResult.status === 'fulfilled' ? agentsResult.value : null;
      const update = updateResult.status === 'fulfilled'
        ? updateResult.value
        : { update_available: null, error: 'request_failed' };
      const sessions = sessionsResult.status === 'fulfilled' ? sessionsResult.value : null;

      renderStatusBanner(status);
      renderUpdateBanner(update);
      renderSessions(sessions);
      renderAgents(agents);
      renderRecentEvents(status);
      setShellVersion(status && status.framework_version ? status.framework_version : 'unknown');
    } finally {
      inFlight = false;
    }
  }

  function renderStatusBanner(status) {
    const overall = deriveOverallStatus(status);
    statusEl.className = `overview-status banner-${overall.kind}`;
    statusEl.textContent = overall.label;
  }

  function renderUpdateBanner(check) {
    const update = deriveUpdateBanner(check);

    if (update.kind === 'available') {
      updateEl.className = 'overview-update banner-update-available';
      updateEl.innerHTML = `Update available: <strong>${escape(update.from)} → ${escape(update.to)}</strong> · <a href="/updates.html">Review</a>`;
      return;
    }

    if (update.kind === 'check_failed') {
      updateEl.className = 'overview-update update-check-failed';
      updateEl.innerHTML = `Couldn&rsquo;t check for updates <span class="small">(${escape(update.error)})</span>`;
      return;
    }

    updateEl.className = 'overview-update';
    updateEl.innerHTML = '';
  }

  function renderSessions(sessions) {
    const total = sessions && typeof sessions.total === 'number' ? sessions.total : null;

    if (total === null) {
      sessionsEl.innerHTML = `
        <h2>Active sessions</h2>
        <p class="muted">Active sessions unavailable</p>
      `;
      return;
    }

    if (total > 0) {
      sessionsEl.innerHTML = `
        <a class="sessions-card-link" href="/tasks.html">
          <span class="sessions-eyebrow">Active sessions</span>
          <span class="sessions-count">${escape(total)}</span>
          <span class="sessions-label">View all active session${total === 1 ? '' : 's'}</span>
        </a>
      `;
      return;
    }

    sessionsEl.innerHTML = `
      <span class="sessions-eyebrow">Active sessions</span>
      <span class="sessions-count muted">${escape(total)}</span>
      <span class="sessions-label muted">No running sessions</span>
    `;
  }

  function renderAgents(agents) {
    if (!agents || !Array.isArray(agents.agents)) {
      agentsListEl.innerHTML = '<p class="muted">Agent list unavailable</p>';
      return;
    }

    if (agents.agents.length === 0) {
      agentsListEl.innerHTML = '<p class="muted">No agents declared</p>';
      return;
    }

    agentsListEl.innerHTML = agents.agents.map((agent) => {
      const activity = agent.current_activity || { state: 'idle', task_id: null };
      const pm2Class = pm2StatusClass(agent.pm2_status);
      const stateClass = activityClass(activity.state);
      const taskHint = activity.task_id
        ? `<div class="agent-taskid">${escape(truncate(activity.task_id, 24))}</div>`
        : '';
      const lastEvent = agent.last_event_ts
        ? `<div class="agent-last-event">${escape(agent.last_event || 'unknown')} · ${escape(relativeTime(agent.last_event_ts))}</div>`
        : '<div class="agent-last-event muted">No recent agent events</div>';

      return `
        <a class="agent-row" href="/agents.html">
          <div class="agent-name">${escape(agent.name)}</div>
          <div class="agent-pills">
            <span class="pill pill-status-${pm2Class}">${escape(agent.pm2_status || 'unknown')}</span>
            <span class="pill pill-activity-${stateClass}">${escape(activity.state || 'idle')}</span>
          </div>
          ${taskHint}
          ${lastEvent}
        </a>
      `;
    }).join('');
  }

  function renderRecentEvents(status) {
    if (!status || !Array.isArray(status.recent_events)) {
      eventsListEl.innerHTML = '<li class="muted">Recent events unavailable</li>';
      return;
    }

    const events = status.recent_events.slice(0, 10);
    if (events.length === 0) {
      eventsListEl.innerHTML = '<li class="muted">No recent events</li>';
      return;
    }

    eventsListEl.innerHTML = events.map((event) => `
      <li class="event-row">
        <span class="event-time">${escape(relativeTime(event.ts))}</span>
        <span class="event-kind">${escape(event.event || 'unknown')}</span>
        <span class="event-agent">${escape(event.agent || 'system')}</span>
        <span class="event-taskid">${escape(truncate(event.taskId || '', 12))}</span>
      </li>
    `).join('');
  }

  function startPolling() {
    void refresh();
    pollHandle = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
  }

  function stopPolling() {
    if (pollHandle) {
      window.clearInterval(pollHandle);
      pollHandle = null;
    }
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopPolling();
    } else if (!pollHandle) {
      startPolling();
    }
  });

  if (document.visibilityState !== 'hidden') {
    startPolling();
  }
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
