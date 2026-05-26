import { getAuthConfig, getToken, clearToken, redirectToLogin } from './auth.js';

export async function apiFetch(path, opts = {}) {
  const { required } = await getAuthConfig();
  const token = await getToken();
  const headers = new Headers(opts.headers || {});

  if (token) {
    headers.set('Authorization', 'Bearer ' + token);
  }

  if (opts.body && !(opts.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, { ...opts, headers });
  if (response.status === 401 && required) {
    clearToken();
    redirectToLogin({ expired: true });
    throw new Error('unauthorized');
  }

  return response;
}

export async function apiJson(path, opts = {}) {
  const response = await apiFetch(path, opts);
  if (!response.ok) {
    let body = null;

    try {
      body = await response.json();
    } catch {
      body = null;
    }

    const error = new Error('api_error');
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return response.json();
}

export async function apiPing() {
  try {
    const response = await apiFetch('/api/status');
    return response.ok;
  } catch {
    return false;
  }
}
