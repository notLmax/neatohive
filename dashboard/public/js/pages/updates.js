'use strict';

import { apiJson } from '/js/api.js';
import { getToken } from '/js/auth.js';
import {
  updateGateState,
  isCheckErrorPayload,
  formatPhaseLabel,
  deriveStepGroups,
  groupLabel,
  terminalState,
  migrationEvents,
  parseEventLine,
} from '/js/pages/updates-utils.js';

const CHECK_POLL_MS = 60000;
const STATUS_POLL_MS = 1500;
const SSE_RECONNECT_MS = 5000;

export function renderUpdates(main) {
  main.innerHTML = `
    <div class="updates-page-header">
      <h1>Updates</h1>
      <div class="updates-actions">
        <button type="button" id="updates-refresh-btn" class="updates-refresh-btn">Check again</button>
        <span class="updates-refresh-status" id="updates-refresh-status"></span>
      </div>
    </div>
    <section class="overview-card updates-gate-card" id="updates-gate-card"></section>
    <div id="updates-error" class="updates-error"></div>
    <section class="overview-card updates-progress-card" id="updates-progress-card" hidden></section>
    <section class="overview-card updates-migration-card" id="updates-migration-card" hidden></section>
    <section class="overview-card updates-terminal-card" id="updates-terminal-card" hidden></section>
  `;

  let mode = 'IDLE';
  let checkInFlight = false;
  let checkPollHandle = null;

  let updateId = null;
  let observedEvents = [];
  let lastSequenceSeen = -1;

  let eventSource = null;
  let statusPollHandle = null;
  let sseReconnectHandle = null;
  let connectionMode = 'sse';
  let consecutivePollErrors = 0;

  const refreshButton = document.getElementById('updates-refresh-btn');
  const refreshStatus = document.getElementById('updates-refresh-status');

  refreshButton.addEventListener('click', () => {
    if (mode === 'IN_FLIGHT') {
      return;
    }
    if (mode === 'TERMINAL') {
      resetToIdle();
    }
    void refreshCheck(true);
  });

  async function refreshCheck(force = false) {
    if (checkInFlight && !force) {
      return;
    }
    if (checkInFlight) {
      return;
    }

    checkInFlight = true;
    setRefreshPending(true);

    try {
      const payload = await apiJson('/api/update/check').catch((error) => ({
        __fetchError: error && error.message ? error.message : 'fetch failed',
      }));
      renderGate(payload);
    } finally {
      checkInFlight = false;
      setRefreshPending(false);
    }
  }

  function setRefreshPending(pending) {
    refreshButton.disabled = pending || mode === 'IN_FLIGHT';
    refreshButton.textContent = pending ? 'Checking…' : 'Check again';
    refreshStatus.textContent = pending ? 'Checking…' : '';
  }

  function startCheckPolling() {
    if (mode !== 'IDLE' || checkPollHandle) {
      return;
    }

    void refreshCheck();
    checkPollHandle = window.setInterval(() => {
      if (mode === 'IDLE') {
        void refreshCheck(false);
      }
    }, CHECK_POLL_MS);
  }

  function stopCheckPolling() {
    if (checkPollHandle) {
      window.clearInterval(checkPollHandle);
      checkPollHandle = null;
    }
  }

  function renderGate(payload) {
    const card = document.getElementById('updates-gate-card');

    if (payload && payload.__fetchError) {
      card.className = 'overview-card updates-gate-card gate-unknown';
      card.innerHTML = `
        <div class="updates-gate-headline">
          <span class="pill pill-update-unknown">unknown</span>
          <span class="updates-gate-label">Could not load update info</span>
        </div>
        <p class="updates-gate-detail">${escape(payload.__fetchError)}</p>
      `;
      return;
    }

    if (isCheckErrorPayload(payload)) {
      const detail = payload && typeof payload.error === 'string'
        ? (typeof payload.detail === 'string' ? payload.detail : payload.error)
        : 'Update info unavailable.';
      card.className = 'overview-card updates-gate-card gate-unknown';
      card.innerHTML = `
        <div class="updates-gate-headline">
          <span class="pill pill-update-unknown">unknown</span>
          <span class="updates-gate-label">Could not check for updates</span>
        </div>
        <p class="updates-gate-detail">${escape(detail)}</p>
      `;
      return;
    }

    const gate = updateGateState(payload);
    card.className = `overview-card updates-gate-card gate-${gate.kind}`;

    let extra = '';
    if (gate.kind === 'available') {
      const released = typeof payload.released_at === 'string' ? payload.released_at : '';
      const changelog = typeof payload.changelog_url === 'string' ? payload.changelog_url : '';
      extra = `
        <div class="updates-gate-meta">
          ${released ? `<div>Released: <span class="updates-gate-meta-value">${escape(released)}</span></div>` : ''}
          ${changelog ? `<div>Changelog: <a href="${escape(changelog)}" target="_blank" rel="noopener">${escape(changelog)}</a></div>` : ''}
        </div>
        <button type="button" id="updates-apply-btn" class="updates-apply-btn">Update Now</button>
      `;
    } else if (gate.kind === 'current') {
      const released = typeof payload.released_at === 'string' ? payload.released_at : '';
      extra = released ? `<p class="updates-gate-detail">Last released: ${escape(released)}</p>` : '';
    } else {
      extra = '<p class="updates-gate-detail">Try the "Check again" button. If the problem persists, the release server may be unreachable.</p>';
    }

    card.innerHTML = `
      <div class="updates-gate-headline">
        <span class="pill pill-update-${gate.kind}">${escape(gate.kind)}</span>
        <span class="updates-gate-label">${escape(gate.label)}</span>
      </div>
      ${extra}
    `;

    if (gate.show_button) {
      const applyButton = document.getElementById('updates-apply-btn');
      if (applyButton) {
        applyButton.addEventListener('click', () => {
          void onApplyClick(payload);
        });
      }
    }
  }

  async function onApplyClick(checkPayload) {
    if (mode !== 'IDLE') {
      return;
    }

    const local = typeof checkPayload.local_version === 'string' ? checkPayload.local_version : '?';
    const remote = typeof checkPayload.remote_version === 'string' ? checkPayload.remote_version : '?';
    const message = `Apply update v${local} → v${remote}? This will replace your current install.`;

    if (!window.confirm(message)) {
      return;
    }

    const applyButton = document.getElementById('updates-apply-btn');
    if (applyButton) {
      applyButton.disabled = true;
      applyButton.textContent = 'Starting…';
    }

    try {
      const payload = await apiJson('/api/update/apply', { method: 'POST', body: '{}' });
      if (!payload || typeof payload.update_id !== 'string' || payload.update_id.length === 0) {
        renderApplyError('apply_failed', 'Server did not return an update_id.');
        if (applyButton) {
          applyButton.disabled = false;
          applyButton.textContent = 'Update Now';
        }
        return;
      }

      stopCheckPolling();
      setMode('IN_FLIGHT');
      startInFlight(payload.update_id);
    } catch (error) {
      const status = error && error.status ? error.status : null;
      const body = error && error.body ? error.body : null;
      const code = body && typeof body.error === 'string' ? body.error : 'apply_failed';
      const detail = body && typeof body.detail === 'string'
        ? body.detail
        : (error && error.message) || 'Apply failed.';
      renderApplyError(code, detail, status);
      if (applyButton) {
        applyButton.disabled = false;
        applyButton.textContent = 'Update Now';
      }
    }
  }

  function renderApplyError(code, detail, status) {
    const errorEl = document.getElementById('updates-error');
    errorEl.innerHTML = `
      <div class="updates-error-banner">
        <strong>Could not start update.</strong>
        ${status ? `<span class="updates-error-status">${escape(`HTTP ${status}`)}</span>` : ''}
        <div class="updates-error-detail">${escape(code)}: ${escape(detail)}</div>
      </div>
    `;
  }

  function clearApplyError() {
    document.getElementById('updates-error').innerHTML = '';
  }

  function startInFlight(id) {
    updateId = id;
    observedEvents = [];
    lastSequenceSeen = -1;
    consecutivePollErrors = 0;
    clearApplyError();
    showProgress();
    renderProgressEmpty(id);
    void openSse();
  }

  async function openSse() {
    if (!updateId) {
      return;
    }

    closeSse();
    const token = await getToken();
    const query = token ? `?token=${encodeURIComponent(token)}` : '';
    eventSource = new EventSource(`/api/update/progress/${encodeURIComponent(updateId)}${query}`);
    eventSource.addEventListener('open', onSseOpen);
    eventSource.addEventListener('message', onSseMessage);
    eventSource.addEventListener('error', onSseError);
  }

  function closeSse() {
    if (!eventSource) {
      return;
    }

    try {
      eventSource.removeEventListener('open', onSseOpen);
      eventSource.removeEventListener('message', onSseMessage);
      eventSource.removeEventListener('error', onSseError);
      eventSource.close();
    } catch {
      // ignore close errors
    }
    eventSource = null;
  }

  function onSseOpen() {
    connectionMode = 'sse';
    stopStatusPolling();
    stopSseReconnect();
    clearApplyError();
    updateConnectionPill();
  }

  function onSseMessage(event) {
    const parsed = parseEventLine(event && event.data);
    if (!parsed) {
      return;
    }
    if (typeof parsed.sequence === 'number' && parsed.sequence <= lastSequenceSeen) {
      return;
    }
    if (typeof parsed.sequence === 'number') {
      lastSequenceSeen = parsed.sequence;
    }
    observedEvents.push(parsed);
    renderProgress(observedEvents);
    if (parsed.phase === 'done') {
      terminate(parsed);
    }
  }

  function onSseError() {
    closeSse();
    connectionMode = 'polling';
    updateConnectionPill();
    startStatusPolling();
    startSseReconnect();
  }

  function startStatusPolling() {
    if (statusPollHandle) {
      return;
    }
    void pollStatusOnce();
    statusPollHandle = window.setInterval(() => {
      void pollStatusOnce();
    }, STATUS_POLL_MS);
  }

  function stopStatusPolling() {
    if (statusPollHandle) {
      window.clearInterval(statusPollHandle);
      statusPollHandle = null;
    }
  }

  async function pollStatusOnce() {
    if (!updateId || mode !== 'IN_FLIGHT') {
      return;
    }

    try {
      const payload = await apiJson(`/api/update/status/${encodeURIComponent(updateId)}`);
      consecutivePollErrors = 0;
      clearApplyError();
      if (!payload || !payload.current) {
        return;
      }

      const current = payload.current;
      if (typeof current.sequence === 'number' && current.sequence > lastSequenceSeen) {
        observedEvents.push(current);
        lastSequenceSeen = current.sequence;
        renderProgress(observedEvents);
      }

      if (payload.is_done && current.phase === 'done') {
        terminate(current);
      }
    } catch {
      consecutivePollErrors += 1;
      if (consecutivePollErrors > 3) {
        document.getElementById('updates-error').innerHTML = `
          <div class="updates-error-banner">
            <strong>Connection lost.</strong>
            <div class="updates-error-detail">Retrying… (errors: ${escape(String(consecutivePollErrors))})</div>
          </div>
        `;
      }
    }
  }

  function startSseReconnect() {
    if (sseReconnectHandle) {
      return;
    }
    sseReconnectHandle = window.setInterval(() => {
      if (mode === 'IN_FLIGHT') {
        openSse();
      }
    }, SSE_RECONNECT_MS);
  }

  function stopSseReconnect() {
    if (sseReconnectHandle) {
      window.clearInterval(sseReconnectHandle);
      sseReconnectHandle = null;
    }
  }

  function terminate(doneEvent) {
    closeSse();
    stopStatusPolling();
    stopSseReconnect();
    setMode('TERMINAL');
    renderProgress(observedEvents);
    renderTerminal(observedEvents, doneEvent);
  }

  function setMode(next) {
    mode = next;
    refreshButton.disabled = next === 'IN_FLIGHT';
  }

  function resetToIdle() {
    observedEvents = [];
    lastSequenceSeen = -1;
    updateId = null;
    connectionMode = 'sse';
    consecutivePollErrors = 0;
    clearApplyError();
    closeSse();
    stopStatusPolling();
    stopSseReconnect();
    hideProgress();
    hideMigration();
    hideTerminal();
    setMode('IDLE');
  }

  function showProgress() {
    document.getElementById('updates-progress-card').hidden = false;
  }

  function hideProgress() {
    const card = document.getElementById('updates-progress-card');
    card.hidden = true;
    card.innerHTML = '';
  }

  function showMigration() {
    document.getElementById('updates-migration-card').hidden = false;
  }

  function hideMigration() {
    const card = document.getElementById('updates-migration-card');
    card.hidden = true;
    card.innerHTML = '';
  }

  function showTerminal() {
    document.getElementById('updates-terminal-card').hidden = false;
  }

  function hideTerminal() {
    const card = document.getElementById('updates-terminal-card');
    card.hidden = true;
    card.innerHTML = '';
  }

  function renderProgressEmpty(id) {
    const card = document.getElementById('updates-progress-card');
    card.innerHTML = `
      <header class="updates-progress-header">
        <h2>Update in progress</h2>
        <div class="updates-progress-meta">
          <span class="updates-progress-id">id: <code>${escape(id)}</code></span>
          <span id="updates-connection-pill" class="pill pill-update-connection-sse">SSE</span>
          <span class="updates-progress-event-count">0 events</span>
        </div>
      </header>
      <ol id="updates-step-list" class="updates-step-list"></ol>
    `;
    renderStepList([]);
  }

  function renderProgress(events) {
    const card = document.getElementById('updates-progress-card');
    if (card.hidden) {
      showProgress();
      renderProgressEmpty(updateId);
    }

    const count = card.querySelector('.updates-progress-event-count');
    if (count) {
      const total = events.length;
      count.textContent = `${total} event${total === 1 ? '' : 's'}`;
    }

    renderStepList(events);
    updateConnectionPill();

    const migration = migrationEvents(events);
    if (migration.length > 0) {
      renderMigration(migration);
    }
  }

  function renderStepList(events) {
    const list = document.getElementById('updates-step-list');
    if (!list) {
      return;
    }

    const groups = deriveStepGroups(events);
    list.innerHTML = groups.map((group) => {
      const indicator = group.state === 'complete'
        ? '✓'
        : group.state === 'active'
          ? '⟳'
          : group.state === 'failed'
            ? '✗'
            : '·';
      const detail = group.most_recent_phase
        ? formatPhaseLabel(group.most_recent_phase)
        : (group.state === 'pending' ? 'pending' : '');

      return `
        <li class="updates-step-row step-${group.state}">
          <span class="updates-step-indicator">${escape(indicator)}</span>
          <span class="updates-step-group">${escape(groupLabel(group.group))}</span>
          <span class="updates-step-detail">${escape(detail)}</span>
        </li>
      `;
    }).join('');
  }

  function renderMigration(events) {
    const card = document.getElementById('updates-migration-card');
    showMigration();
    card.innerHTML = `
      <header class="updates-migration-header">
        <h2>Post-update setup</h2>
      </header>
      <ul class="updates-migration-list">
        ${events.map((event) => renderMigrationRow(event)).join('')}
      </ul>
    `;
  }

  function renderMigrationRow(event) {
    const phase = typeof event.phase === 'string' ? event.phase : 'unknown';
    const label = formatPhaseLabel(phase);
    const isFailed = phase === 'migration-failed';
    const isPmReload = phase === 'migration-pm2-reload-pending';
    const indicator = isFailed ? '✗' : (phase === 'migration-complete' ? '✓' : '⚠');
    const klass = isFailed ? 'migration-row-failed' : (isPmReload ? 'migration-row-warn' : 'migration-row-ok');

    let extra = '';
    if (isPmReload && event.detail && typeof event.detail.ecosystem_path === 'string') {
      extra = `
        <div class="updates-migration-instructions">
          <p>PM2 reload required. Run the following on your machine to start the new dashboard process. This is a one-time step after upgrading from v1.4.x:</p>
          <pre class="updates-migration-cmd">pm2 startOrReload ${escape(event.detail.ecosystem_path)}
pm2 save</pre>
        </div>
      `;
    } else if (isFailed && event.detail) {
      const step = typeof event.detail.step === 'string' ? event.detail.step : 'unknown';
      const error = typeof event.detail.error === 'string' ? event.detail.error : 'no detail';
      extra = `
        <div class="updates-migration-instructions">
          <p><strong>Step:</strong> <code>${escape(step)}</code></p>
          <p><strong>Error:</strong> ${escape(error)}</p>
          <p class="updates-migration-note">Migration retries on the next <code>hive update</code>.</p>
        </div>
      `;
    }

    return `
      <li class="updates-migration-row ${klass}">
        <span class="updates-migration-indicator">${escape(indicator)}</span>
        <span class="updates-migration-label">${escape(label)}</span>
        ${extra}
      </li>
    `;
  }

  function renderTerminal(events, doneEvent) {
    const card = document.getElementById('updates-terminal-card');
    const terminal = terminalState(events);
    const detail = doneEvent && doneEvent.detail ? doneEvent.detail : { success: terminal.success };
    const success = detail.success === true;
    const finalVersion = typeof detail.final_version === 'string' ? detail.final_version : null;

    showTerminal();

    if (success) {
      card.innerHTML = `
        <div class="updates-terminal-headline">
          <span class="pill pill-update-success">success</span>
          <span class="updates-terminal-label">Update complete${finalVersion ? `: now at v${escape(finalVersion)}` : ''}</span>
        </div>
        <p class="updates-terminal-note">Refresh this page once you have completed any post-update setup steps shown below.</p>
      `;
      return;
    }

    if (terminal.rolled_back) {
      card.innerHTML = `
        <div class="updates-terminal-headline">
          <span class="pill pill-update-failure">rolled back</span>
          <span class="updates-terminal-label">Update was rolled back</span>
        </div>
        ${terminal.last_error ? `<p class="updates-terminal-note"><strong>Cause:</strong> ${escape(terminal.last_error)}</p>` : ''}
        <p class="updates-terminal-note">Your install is unchanged. You can try the update again with the "Check again" button.</p>
      `;
      return;
    }

    card.innerHTML = `
      <div class="updates-terminal-headline">
        <span class="pill pill-update-failure">failed</span>
        <span class="updates-terminal-label">Update failed</span>
      </div>
      ${terminal.last_error ? `<p class="updates-terminal-note"><strong>Cause:</strong> ${escape(terminal.last_error)}</p>` : ''}
      <p class="updates-terminal-note">Check <code>${escape(`~/.neato-hive/state/update-${updateId || ''}.jsonl`)}</code> for the full event log. The "Check again" button returns to the idle state.</p>
    `;
  }

  function updateConnectionPill() {
    const pill = document.getElementById('updates-connection-pill');
    if (!pill) {
      return;
    }

    if (connectionMode === 'sse') {
      pill.className = 'pill pill-update-connection-sse';
      pill.textContent = 'SSE';
      return;
    }

    pill.className = 'pill pill-update-connection-polling';
    pill.textContent = 'polling';
  }

  document.addEventListener('visibilitychange', () => {
    if (mode !== 'IDLE') {
      return;
    }
    if (document.visibilityState === 'hidden') {
      stopCheckPolling();
    } else {
      startCheckPolling();
    }
  });

  if (document.visibilityState !== 'hidden') {
    startCheckPolling();
  }
}

function escape(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}
