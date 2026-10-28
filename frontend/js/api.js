// Thin wrapper around fetch for the REST API.

export class ApiError extends Error {
  constructor(status, message, details = []) {
    super(message);
    this.status = status;
    this.details = details; // [{field, message}] for validation errors
  }
}

let token = null;
let onUnauthorized = () => {};

export function setToken(value) { token = value; }
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function call(path, { method = "GET", body, params } = {}) {
  const url = new URL(path, window.location.origin);
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== "" && value != null) url.searchParams.set(key, value);
    });
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the server. Check your connection and try again.");
  }

  if (response.status === 204) return null;
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const err = payload?.error ?? {};
    if (response.status === 401 && token) onUnauthorized();
    throw new ApiError(response.status, err.message ?? "Something went wrong", err.details ?? []);
  }
  return payload;
}

export const api = {
  login: (username, password) => call("/api/auth/login", { method: "POST", body: { username, password } }),
  me: () => call("/api/auth/me"),
  list: (params) => call("/api/requests", { params }),
  stats: () => call("/api/requests/stats"),
  get: (id) => call(`/api/requests/${id}`),
  create: (body) => call("/api/requests", { method: "POST", body }),
  update: (id, body) => call(`/api/requests/${id}`, { method: "PATCH", body }),
  cancel: (id) => call(`/api/requests/${id}/cancel`, { method: "POST" }),
  retry: (id) => call(`/api/requests/${id}/retry`, { method: "POST" }),
};
