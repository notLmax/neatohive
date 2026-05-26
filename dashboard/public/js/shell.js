import { clearToken, getAuthConfig } from './auth.js';

const NAV_LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/chat.html', label: 'Chat' },
  { href: '/agents.html', label: 'Agents' },
  { href: '/tasks.html', label: 'Tasks' },
  { href: '/doctor.html', label: 'Doctor' },
  { href: '/updates.html', label: 'Updates' },
  { href: '/backups.html', label: 'Backups' },
];

export function renderShell({ activePage = '/', title = 'Hive Dashboard' } = {}) {
  document.title = title + ' - Hive Dashboard';
  const root = document.body;
  root.innerHTML = '';

  const header = document.createElement('header');
  header.className = 'shell-header';
  header.innerHTML = `
    <div class="shell-header-inner">
      <a href="/" class="shell-brand">Hive Dashboard</a>
      <nav class="shell-nav" role="navigation" aria-label="Primary">
        ${NAV_LINKS.map((link) => `
          <a href="${link.href}" ${link.href === activePage ? 'aria-current="page"' : ''}>${link.label}</a>
        `).join('')}
      </nav>
      <button type="button" class="shell-signout" id="shell-signout-btn">Sign out</button>
    </div>
  `;
  root.appendChild(header);

  const main = document.createElement('main');
  main.id = 'page-content';
  main.className = 'shell-main';
  root.appendChild(main);

  const footer = document.createElement('footer');
  footer.className = 'shell-footer';
  footer.innerHTML = '<small>Hive v<span id="shell-version">...</span></small>';
  root.appendChild(footer);

  const signoutButton = document.getElementById('shell-signout-btn');
  void configureSignoutButton(signoutButton);

  return main;
}

export function setShellVersion(version) {
  const element = document.getElementById('shell-version');
  if (element) {
    element.textContent = version || 'unknown';
  }
}

async function configureSignoutButton(button) {
  const { required } = await getAuthConfig();
  if (!required) {
    button.hidden = true;
    return;
  }

  button.addEventListener('click', () => {
    clearToken();
    window.location.href = '/login.html';
  });
}
