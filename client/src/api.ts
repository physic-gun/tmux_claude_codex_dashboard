const TOKEN_KEY = 'tmux_dash_token';

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

async function req(path: string, opts: RequestInit = {}) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((opts.headers as Record<string, string>) || {}),
  };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`/api${path}`, { ...opts, headers });
  if (res.status === 401) {
    setToken(null);
    if (location.pathname !== '/login') location.href = '/login';
    throw new Error('未登录');
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  get: (p: string) => req(p),
  post: (p: string, body?: unknown) => req(p, { method: 'POST', body: JSON.stringify(body || {}) }),
  del: (p: string) => req(p, { method: 'DELETE' }),
};

// Redirect to login on a 401 (shared by the blob/raw helpers below, which bypass `req`).
function bounceIfUnauthorized(status: number) {
  if (status !== 401) return false;
  setToken(null);
  if (location.pathname !== '/login') location.href = '/login';
  return true;
}

// Fetch a path as a Blob with the Authorization header attached — needed for file downloads, which
// a plain <a href> can't authenticate. Throws with the server's error message on failure.
export async function fetchBlob(p: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`/api${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (bounceIfUnauthorized(res.status)) throw new Error('未登录');
  if (!res.ok) {
    let msg = `下载失败 (${res.status})`;
    try { const d = await res.json(); if (d?.error) msg = d.error; } catch { /* non-JSON body */ }
    throw new Error(msg);
  }
  return res.blob();
}

// POST raw bytes (a File/Blob) as the request body — used for uploads. Content-Type is forced to
// application/octet-stream so the server's JSON parser skips it and the raw parser owns the body.
export async function postRaw(p: string, body: Blob): Promise<any> {
  const token = getToken();
  const res = await fetch(`/api${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body,
  });
  if (bounceIfUnauthorized(res.status)) throw new Error('未登录');
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : null;
  if (!res.ok) {
    if (data && data.exists) return data; // name clash — return the descriptor so the caller can offer to overwrite
    throw new Error(data?.error || `上传失败 (${res.status})`);
  }
  return data;
}
