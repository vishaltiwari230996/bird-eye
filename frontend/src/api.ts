/** Centralised API base URL — set VITE_API_URL in frontend/.env */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8000';

export const api = {
  get: (path: string) => fetch(`${API_URL}${path}`),
  post: (path: string, body?: unknown) =>
    fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
  put: (path: string, body?: unknown) =>
    fetch(`${API_URL}${path}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  patch: (path: string, body?: unknown) =>
    fetch(`${API_URL}${path}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  delete: (path: string) => fetch(`${API_URL}${path}`, { method: 'DELETE' }),
  /** Returns a native Response — caller reads .body as SSE stream */
  postStream: (path: string, body?: unknown) =>
    fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    }),
};
