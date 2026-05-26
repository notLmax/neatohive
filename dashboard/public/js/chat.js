import { ensureSession, getToken } from '/js/auth.js';
import { apiFetch, apiJson } from '/js/api.js';
import { renderShell, setShellVersion } from '/js/shell.js';
import { relativeTime } from '/js/pages/agents-utils.js';

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000, 30000];
const SLASH_COMMANDS = [
  { name: '/newsession', hint: 'clear dashboard session state' },
  { name: '/status', hint: 'show session stats' },
];

if (await ensureSession()) {
  const token = await getToken();
  const isAuthorized = await apiJson('/api/status').catch(() => null);
  if (isAuthorized) {
    const main = renderShell({ activePage: '/chat.html', title: 'Chat' });
    renderChat(main, token, isAuthorized);
    setShellVersion(isAuthorized.framework_version || 'unknown');
  }
}

function renderChat(main, dashboardToken) {
  main.innerHTML = `
    <div class="chat-page">
      <aside class="chat-sidebar">
        <div class="chat-sidebar-header">
          <h1>Agent Chat</h1>
          <p class="muted">Live bridge across dashboard and Discord.</p>
        </div>
        <ul id="chat-agent-list" class="chat-agent-list"></ul>
      </aside>
      <section class="chat-panel">
        <div class="chat-panel-header">
          <div>
            <h2 id="chat-agent-title">Select an agent</h2>
            <div id="chat-agent-subtitle" class="muted">Choose an agent to open the live transcript.</div>
          </div>
          <div id="chat-connection" class="chat-connection">Connecting…</div>
        </div>
        <div id="chat-transcript" class="chat-transcript">
          <div class="chat-empty">No agent selected yet.</div>
        </div>
        <div class="chat-composer">
          <div id="chat-dropzone" class="chat-dropzone">Drop image files here or use Upload.</div>
          <div id="chat-upload-list" class="chat-upload-list"></div>
          <div id="chat-slash-menu" class="chat-slash-menu" hidden></div>
          <div class="chat-input-row">
            <div>
              <input id="chat-file-input" type="file" accept="image/*" multiple hidden>
              <button type="button" id="chat-upload-button" class="chat-action-button">Upload</button>
            </div>
            <textarea id="chat-input" placeholder="Message an agent or type / for commands"></textarea>
            <button type="button" id="chat-send" class="chat-action-button chat-send-button">Send</button>
          </div>
        </div>
      </section>
    </div>
  `;

  const state = {
    socket: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    reconnectToken: null,
    agents: [],
    selectedAgent: null,
    messagesByAgent: new Map(),
    agentStatuses: new Map(),
    uploadsByAgent: new Map(),
    subscriptions: new Set(),
    slashIndex: 0,
  };

  const elements = {
    agentList: document.getElementById('chat-agent-list'),
    agentTitle: document.getElementById('chat-agent-title'),
    agentSubtitle: document.getElementById('chat-agent-subtitle'),
    connection: document.getElementById('chat-connection'),
    transcript: document.getElementById('chat-transcript'),
    input: document.getElementById('chat-input'),
    send: document.getElementById('chat-send'),
    uploadButton: document.getElementById('chat-upload-button'),
    fileInput: document.getElementById('chat-file-input'),
    uploadList: document.getElementById('chat-upload-list'),
    dropzone: document.getElementById('chat-dropzone'),
    slashMenu: document.getElementById('chat-slash-menu'),
  };

  elements.send.addEventListener('click', () => {
    void sendCurrentMessage();
  });
  elements.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendCurrentMessage();
      return;
    }

    if (!elements.slashMenu.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      moveSlashSelection(delta);
      return;
    }

    if (!elements.slashMenu.hidden && event.key === 'Tab') {
      event.preventDefault();
      applySlashSelection();
    }
  });
  elements.input.addEventListener('input', () => {
    renderSlashMenu();
  });
  elements.uploadButton.addEventListener('click', () => {
    elements.fileInput.click();
  });
  elements.fileInput.addEventListener('change', () => {
    void queueUploads(elements.fileInput.files);
    elements.fileInput.value = '';
  });
  bindDropzone(elements.dropzone, async (files) => {
    await queueUploads(files);
  });

  void loadAgents();
  connect();

  async function loadAgents() {
    const payload = await apiJson('/api/agents').catch(() => null);
    state.agents = Array.isArray(payload && payload.agents) ? payload.agents.map((agent) => agent.name).sort() : [];
    for (const agent of state.agents) {
      if (!state.agentStatuses.has(agent)) {
        const item = payload.agents.find((candidate) => candidate.name === agent);
        state.agentStatuses.set(agent, item && item.pm2_status === 'online' ? 'online' : 'offline');
      }
      if (!state.messagesByAgent.has(agent)) {
        state.messagesByAgent.set(agent, []);
      }
      if (!state.uploadsByAgent.has(agent)) {
        state.uploadsByAgent.set(agent, []);
      }
    }

    if (!state.selectedAgent && state.agents[0]) {
      state.selectedAgent = state.agents[0];
    }

    renderAgentList();
    renderTranscript();
    subscribeAllAgents();
  }

  function connect() {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const query = new URLSearchParams();
    if (dashboardToken) {
      query.set('token', dashboardToken);
    }
    if (state.reconnectToken) {
      query.set('reconnect_token', state.reconnectToken);
    }

    updateConnectionLabel('Connecting…');
    const queryString = query.toString();
    const socket = new WebSocket(`${scheme}//${window.location.host}/ws/dashboard${queryString ? `?${queryString}` : ''}`);
    state.socket = socket;

    socket.addEventListener('open', () => {
      state.reconnectAttempt = 0;
      updateConnectionLabel('Connected');
      subscribeAllAgents();
    });

    socket.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      validateIncomingFrame(frame);
      if (frame.type === 'hello') {
        state.reconnectToken = frame.reconnect_token || null;
        return;
      }
      if (frame.type === 'message') {
        ingestMessage(frame);
      }
    });

    socket.addEventListener('close', () => {
      state.socket = null;
      state.subscriptions.clear();
      updateConnectionLabel('Reconnecting…');
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      updateConnectionLabel('Socket error');
    });
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) {
      return;
    }

    const delay = RECONNECT_DELAYS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    state.reconnectAttempt += 1;
    state.reconnectTimer = window.setTimeout(() => {
      state.reconnectTimer = null;
      connect();
    }, delay);
  }

  function validateIncomingFrame(frame) {
    const allowed = new Set(['subscribe', 'unsubscribe', 'send', 'ack', 'hello', 'message', 'subscribed', 'error', 'unsubscribed']);
    if (!frame || typeof frame !== 'object' || typeof frame.type !== 'string' || !allowed.has(frame.type)) {
      throw new Error('invalid_ws_frame');
    }
  }

  function subscribeAllAgents() {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    for (const agentName of state.agents) {
      const channel = `dashboard:${agentName}`;
      if (state.subscriptions.has(channel)) {
        continue;
      }

      state.socket.send(JSON.stringify({ kind: 'subscribe', channel }));
      state.subscriptions.add(channel);
    }
  }

  function ingestMessage(frame) {
    const event = normalizeEvent(frame);
    if (!event) {
      return;
    }

    const list = state.messagesByAgent.get(event.agentName) || [];
    if (event.type === 'agent_text' && event.final === false && list.length > 0) {
      const previous = list[list.length - 1];
      if (previous.type === 'agent_text' && previous.final === false) {
        previous.text = event.text;
        previous.ts = event.ts;
        renderTranscript();
        return;
      }
    }

    if (event.type === 'agent_status') {
      state.agentStatuses.set(event.agentName, event.status);
      renderAgentList();
      if (state.selectedAgent === event.agentName) {
        renderAgentHeader();
      }
    }

    list.push(event);
    state.messagesByAgent.set(event.agentName, list.slice(-200));
    renderTranscript();
  }

  function normalizeEvent(frame) {
    const channel = typeof frame.channel === 'string' ? frame.channel : frame.channelKey;
    if (typeof channel !== 'string' || !channel.startsWith('dashboard:')) {
      return null;
    }

    const agentName = channel.slice('dashboard:'.length);
    return {
      ...frame,
      type: typeof frame.eventType === 'string' ? frame.eventType : frame.type,
      agentName,
      ts: Number.isFinite(frame.ts) ? frame.ts : Date.now(),
    };
  }

  function renderAgentList() {
    elements.agentList.innerHTML = state.agents.map((agentName) => {
      const status = state.agentStatuses.get(agentName) || 'offline';
      const ariaCurrent = agentName === state.selectedAgent ? 'true' : 'false';
      return `
        <li>
          <button type="button" class="chat-agent-button" data-agent="${escapeHtml(agentName)}" aria-current="${ariaCurrent}">
            <span class="chat-agent-name">${escapeHtml(agentName)}</span>
            <span class="chat-agent-meta">
              <span class="chat-status-dot ${escapeHtml(status)}"></span>
              <span>${escapeHtml(status)}</span>
            </span>
          </button>
        </li>
      `;
    }).join('');

    elements.agentList.querySelectorAll('[data-agent]').forEach((button) => {
      button.addEventListener('click', () => {
        state.selectedAgent = button.getAttribute('data-agent');
        renderAgentList();
        renderTranscript();
      });
    });

    renderAgentHeader();
  }

  function renderAgentHeader() {
    if (!state.selectedAgent) {
      elements.agentTitle.textContent = 'Select an agent';
      elements.agentSubtitle.textContent = 'Choose an agent to open the live transcript.';
      return;
    }

    const status = state.agentStatuses.get(state.selectedAgent) || 'offline';
    elements.agentTitle.textContent = state.selectedAgent;
    elements.agentSubtitle.textContent = `Status: ${status}`;
  }

  function renderTranscript() {
    renderAgentHeader();
    renderUploads();

    if (!state.selectedAgent) {
      elements.transcript.innerHTML = '<div class="chat-empty">No agent selected yet.</div>';
      return;
    }

    const messages = state.messagesByAgent.get(state.selectedAgent) || [];
    if (messages.length === 0) {
      elements.transcript.innerHTML = '<div class="chat-empty">No messages yet for this agent.</div>';
      return;
    }

    const stickToBottom = isNearBottom(elements.transcript);
    elements.transcript.innerHTML = messages.map(renderMessage).join('');
    if (stickToBottom) {
      elements.transcript.scrollTop = elements.transcript.scrollHeight;
    }
  }

  function renderMessage(message) {
    if (message.type === 'user_message') {
      return `
        <article class="chat-message user">
          <div class="chat-message-header">
            <span>User</span>
            <span class="chat-badge">via ${escapeHtml(message.source === 'discord' ? 'Discord' : 'Dashboard')}</span>
          </div>
          <div class="chat-message-body">${escapeHtml(message.text || '')}</div>
        </article>
      `;
    }

    if (message.type === 'agent_text') {
      return `
        <article class="chat-message agent">
          <div class="chat-message-header">
            <span>Agent</span>
            <span>${escapeHtml(relativeTime(message.ts))}</span>
          </div>
          <div class="chat-message-body">${escapeHtml(message.text || '')}</div>
        </article>
      `;
    }

    if (message.type === 'tool_use') {
      return `<div class="chat-inline-event">Tool: ${escapeHtml(message.toolName || 'unknown')} running…</div>`;
    }

    if (message.type === 'tool_result') {
      return `<div class="chat-inline-event">Tool: ${escapeHtml(message.toolName || 'unknown')} ${message.ok ? 'finished' : 'failed'}</div>`;
    }

    if (message.type === 'system') {
      return `<div class="chat-system-line">${escapeHtml(message.text || '')}</div>`;
    }

    if (message.type === 'session_reset') {
      return '<div class="chat-reset-line"><span>Session reset</span></div>';
    }

    return '';
  }

  async function sendCurrentMessage() {
    if (!state.selectedAgent || !state.socket || state.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    const text = elements.input.value.trim();
    const uploads = state.uploadsByAgent.get(state.selectedAgent) || [];
    if (!text && uploads.length === 0) {
      return;
    }

    state.socket.send(JSON.stringify({
      kind: 'send',
      agentName: state.selectedAgent,
      text,
      attachments: uploads.map((upload) => upload.id),
    }));

    elements.input.value = '';
    state.uploadsByAgent.set(state.selectedAgent, []);
    renderUploads();
    renderSlashMenu();
  }

  async function queueUploads(fileList) {
    if (!state.selectedAgent || !fileList || fileList.length === 0) {
      return;
    }

    const uploads = state.uploadsByAgent.get(state.selectedAgent) || [];
    for (const file of Array.from(fileList)) {
      if (!file.type.startsWith('image/')) {
        continue;
      }

      const formData = new FormData();
      formData.set('file', file, file.name);
      const response = await apiFetch('/api/upload', {
        method: 'POST',
        body: formData,
        headers: {},
      });
      const payload = await response.json();
      uploads.push({
        id: payload.id,
        previewUrl: URL.createObjectURL(file),
        name: file.name,
      });
    }

    state.uploadsByAgent.set(state.selectedAgent, uploads);
    renderUploads();
  }

  function renderUploads() {
    const uploads = state.selectedAgent ? (state.uploadsByAgent.get(state.selectedAgent) || []) : [];
    elements.uploadList.innerHTML = uploads.map((upload, index) => `
      <div class="chat-upload-card">
        <img class="chat-upload-thumb" src="${upload.previewUrl}" alt="${escapeHtml(upload.name)}">
        <button type="button" class="chat-upload-remove" data-upload-index="${index}" aria-label="Remove upload">×</button>
      </div>
    `).join('');

    elements.uploadList.querySelectorAll('[data-upload-index]').forEach((button) => {
      button.addEventListener('click', () => {
        const uploadsForAgent = state.uploadsByAgent.get(state.selectedAgent) || [];
        const index = Number.parseInt(button.getAttribute('data-upload-index') || '-1', 10);
        if (index < 0 || index >= uploadsForAgent.length) {
          return;
        }
        URL.revokeObjectURL(uploadsForAgent[index].previewUrl);
        uploadsForAgent.splice(index, 1);
        renderUploads();
      });
    });
  }

  function renderSlashMenu() {
    const value = elements.input.value;
    if (!value.startsWith('/')) {
      elements.slashMenu.hidden = true;
      elements.slashMenu.innerHTML = '';
      return;
    }

    const matches = SLASH_COMMANDS.filter((command) => command.name.startsWith(value.trim()));
    if (matches.length === 0) {
      state.slashIndex = 0;
      elements.slashMenu.hidden = true;
      elements.slashMenu.innerHTML = '';
      return;
    }

    state.slashIndex = Math.min(state.slashIndex, matches.length - 1);
    elements.slashMenu.hidden = false;
    elements.slashMenu.innerHTML = matches.map((command, index) => `
      <div class="chat-slash-item ${index === state.slashIndex ? 'active' : ''}" data-slash-index="${index}">
        <code>${command.name}</code>
        <span class="muted">${command.hint}</span>
      </div>
    `).join('');

    elements.slashMenu.querySelectorAll('[data-slash-index]').forEach((item) => {
      item.addEventListener('mousedown', (event) => {
        event.preventDefault();
        state.slashIndex = Number.parseInt(item.getAttribute('data-slash-index') || '0', 10);
        applySlashSelection();
      });
    });
  }

  function moveSlashSelection(delta) {
    const value = elements.input.value.trim();
    const matches = SLASH_COMMANDS.filter((command) => command.name.startsWith(value));
    if (matches.length === 0) {
      return;
    }

    state.slashIndex = (state.slashIndex + delta + matches.length) % matches.length;
    renderSlashMenu();
  }

  function applySlashSelection() {
    const matches = SLASH_COMMANDS.filter((command) => command.name.startsWith(elements.input.value.trim()));
    if (matches.length === 0) {
      return;
    }

    elements.input.value = matches[state.slashIndex].name;
    elements.slashMenu.hidden = true;
    elements.input.focus();
  }

  function updateConnectionLabel(text) {
    elements.connection.textContent = text;
  }
}

function bindDropzone(element, onFiles) {
  ['dragenter', 'dragover'].forEach((eventName) => {
    element.addEventListener(eventName, (event) => {
      event.preventDefault();
      element.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    element.addEventListener(eventName, (event) => {
      event.preventDefault();
      element.classList.remove('dragover');
    });
  });

  element.addEventListener('drop', (event) => {
    if (event.dataTransfer && event.dataTransfer.files) {
      void onFiles(event.dataTransfer.files);
    }
  });
}

function isNearBottom(element) {
  return element.scrollHeight - element.scrollTop - element.clientHeight < 32;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
