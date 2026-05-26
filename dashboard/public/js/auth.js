const STORAGE_KEY = 'hive_dashboard_token';
let authConfigPromise = null;

export function getAuthConfig() {
  if (!authConfigPromise) {
    authConfigPromise = fetch('/api/auth-config', {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`auth_config_${response.status}`);
        }

        const payload = await response.json();
        return { required: payload && payload.required === true };
      })
      .catch((error) => {
        authConfigPromise = null;
        throw error;
      });
  }

  return authConfigPromise;
}

export async function getToken() {
  const { required } = await getAuthConfig();
  if (!required) {
    return null;
  }

  return window.localStorage.getItem(STORAGE_KEY);
}

export function setToken(token) {
  window.localStorage.setItem(STORAGE_KEY, token);
}

export function clearToken() {
  window.localStorage.removeItem(STORAGE_KEY);
}

export async function ensureSession() {
  const { required } = await getAuthConfig();
  if (!required) {
    return true;
  }

  if (!window.localStorage.getItem(STORAGE_KEY)) {
    redirectToLogin();
    return false;
  }

  return true;
}

export async function requireToken() {
  if (!(await ensureSession())) {
    return null;
  }

  return getToken();
}

export function redirectToLogin({ expired = false } = {}) {
  const params = new URLSearchParams();
  params.set('return', window.location.pathname + window.location.search);
  if (expired) {
    params.set('expired', '1');
  }
  window.location.href = '/login.html?' + params.toString();
}

export function isValidTokenFormat(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
