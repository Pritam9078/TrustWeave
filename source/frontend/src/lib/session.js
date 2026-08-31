const SESSION_KEY = "trustweave:session";

export function getSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function isLoggedIn() {
  return !!getSession()?.token;
}

export function login(sessionData) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(sessionData));
  return sessionData;
}

export function logout() {
  localStorage.removeItem(SESSION_KEY);
  window.location.hash = "#/login";
}

export function getToken() {
  return getSession()?.token ?? "";
}

export function getIdentity() {
  return getSession()?.identity ?? null;
}

export function getWorkspace() {
  return getSession()?.workspace ?? "user";
}
