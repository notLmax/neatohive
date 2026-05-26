'use strict';

import { apiJson } from '/js/api.js';
import {
  summarizeStatus,
  groupChecksByCategory,
  doctorStatusClass,
  doctorCategoryLabel,
  prioritizeChecks,
  deriveAgentStatus,
  isErrorEnvelope,
} from '/js/pages/doctor-utils.js';

const POLL_MS = 30000;

export function renderDoctor(main) {
  main.innerHTML = `
    <div class="doctor-page-header">
      <h1>Doctor</h1>
      <div class="doctor-actions">
        <button type="button" id="doctor-refresh-btn" class="doctor-refresh-btn">Refresh</button>
        <span class="doctor-refresh-status" id="doctor-refresh-status"></span>
      </div>
    </div>
    <section class="overview-card doctor-summary-card" id="doctor-summary-card"></section>
    <div id="doctor-error" class="doctor-error"></div>
    <div id="doctor-categories" class="doctor-categories"></div>
    <div id="doctor-agents" class="doctor-agents"></div>
  `;

  let pollHandle = null;
  let inFlight = false;

  const refreshButton = document.getElementById('doctor-refresh-btn');
  const refreshStatus = document.getElementById('doctor-refresh-status');

  refreshButton.addEventListener('click', () => {
    void refresh(true);
  });

  async function refresh(force = false) {
    if (inFlight && !force) {
      return;
    }
    if (inFlight) {
      return;
    }

    inFlight = true;
    setRefreshPending(true);

    try {
      const payload = await apiJson('/api/doctor').catch((error) => ({
        __fetchError: error && error.message ? error.message : 'fetch failed',
      }));

      renderEnvelope(payload);
    } finally {
      inFlight = false;
      setRefreshPending(false);
    }
  }

  function setRefreshPending(pending) {
    refreshButton.disabled = pending;
    refreshButton.textContent = pending ? 'Refreshing…' : 'Refresh';
    refreshStatus.textContent = pending ? 'Refreshing…' : '';
  }

  function renderEnvelope(payload) {
    if (payload && payload.__fetchError) {
      renderError(`Failed to fetch /api/doctor: ${payload.__fetchError}`);
      return;
    }

    if (isErrorEnvelope(payload)) {
      const detail = payload && typeof payload.detail === 'string'
        ? payload.detail
        : 'Doctor envelope unavailable.';
      renderError(detail);
      return;
    }

    clearError();
    renderSummary(payload.summary);
    renderCategories(payload.checks);
    renderAgents(payload.agents);
  }

  function renderError(message) {
    document.getElementById('doctor-error').innerHTML = `
      <div class="doctor-error-banner">
        <strong>Doctor unavailable.</strong> ${escape(message)}
      </div>
    `;
    document.getElementById('doctor-summary-card').innerHTML = '';
    document.getElementById('doctor-categories').innerHTML = '';
    document.getElementById('doctor-agents').innerHTML = '';
  }

  function clearError() {
    document.getElementById('doctor-error').innerHTML = '';
  }

  function renderSummary(summary) {
    const overall = summarizeStatus(summary);
    const counts = summary || {};
    const card = document.getElementById('doctor-summary-card');

    card.className = `overview-card doctor-summary-card banner-${overall.kind}`;
    card.innerHTML = `
      <div class="doctor-summary-headline">
        <span class="pill pill-doctor-${overall.kind}">${escape(overall.kind)}</span>
        <span class="doctor-summary-label">${escape(overall.label)}</span>
      </div>
      <div class="doctor-summary-counts">
        <span class="doctor-count-item">Total: <strong>${escape(String(counts.total ?? 0))}</strong></span>
        <span class="doctor-count-item doctor-count-pass">Pass: <strong>${escape(String(counts.pass ?? 0))}</strong></span>
        <span class="doctor-count-item doctor-count-warn">Warn: <strong>${escape(String(counts.warn ?? 0))}</strong></span>
        <span class="doctor-count-item doctor-count-fail">Fail: <strong>${escape(String(counts.fail ?? 0))}</strong></span>
        <span class="doctor-count-item doctor-count-skip">Skip: <strong>${escape(String(counts.skip ?? 0))}</strong></span>
      </div>
    `;
  }

  function renderCategories(checks) {
    const container = document.getElementById('doctor-categories');
    const grouped = groupChecksByCategory(checks);

    if (grouped.length === 0) {
      container.innerHTML = '<p class="muted">No top-level checks.</p>';
      return;
    }

    container.innerHTML = grouped.map((bucket) => {
      const sortedChecks = prioritizeChecks(bucket.checks);

      return `
        <section class="overview-card doctor-category-card">
          <h2>${escape(doctorCategoryLabel(bucket.category))}</h2>
          <ul class="doctor-check-list">
            ${sortedChecks.map((check) => renderCheckRow(check)).join('')}
          </ul>
        </section>
      `;
    }).join('');
  }

  function renderAgents(agents) {
    const container = document.getElementById('doctor-agents');

    if (!Array.isArray(agents) || agents.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = `
      <h2 class="doctor-section-heading">Per-agent</h2>
      <div class="doctor-agent-grid">
        ${agents.map((agent) => renderAgentCard(agent)).join('')}
      </div>
    `;
  }

  function renderAgentCard(agent) {
    const safeAgent = agent && typeof agent === 'object' ? agent : {};
    const status = deriveAgentStatus(safeAgent);
    const statusClass = doctorStatusClass(status);
    const sortedChecks = prioritizeChecks(Array.isArray(safeAgent.checks) ? safeAgent.checks : []);
    const detailHref = `/agents.html?name=${encodeURIComponent(safeAgent.name || '')}`;

    return `
      <section class="overview-card doctor-agent-card">
        <header class="doctor-agent-header">
          <a class="doctor-agent-name" href="${detailHref}">${escape(safeAgent.name || '')}</a>
          <span class="pill pill-doctor-${statusClass}">${escape(status)}</span>
        </header>
        <ul class="doctor-check-list doctor-check-list-compact">
          ${sortedChecks.map((check) => renderCheckRow(check)).join('') || '<li class="muted">No checks reported.</li>'}
        </ul>
      </section>
    `;
  }

  function renderCheckRow(check) {
    if (!check || typeof check !== 'object') {
      return '';
    }

    const statusClass = doctorStatusClass(check.status);
    const detail = typeof check.detail === 'string' && check.detail
      ? `<div class="doctor-check-detail">${escape(check.detail)}</div>`
      : '';
    const fixHint = typeof check.fix_hint === 'string' && check.fix_hint
      ? `<div class="doctor-check-fix">Fix: <code>${escape(check.fix_hint)}</code></div>`
      : '';

    return `
      <li class="doctor-check-row doctor-check-${statusClass}">
        <span class="pill pill-doctor-${statusClass}">${escape(check.status || 'unknown')}</span>
        <div class="doctor-check-body">
          <div class="doctor-check-label">${escape(check.label || check.id || '')}</div>
          ${detail}
          ${fixHint}
        </div>
      </li>
    `;
  }

  function startPolling() {
    void refresh();
    pollHandle = window.setInterval(() => {
      void refresh(false);
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
  return String(value == null ? '' : value).replace(/[&<>"']/g, (char) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]
  ));
}
