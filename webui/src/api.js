const TOKEN_KEY = "datatide-token";

export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function handle(res) {
  if (res.status === 401) {
    clearToken();
    window.dispatchEvent(new CustomEvent("datatide-unauthorized"));
    throw new Error("未登录或会话已过期");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  get: (path) => fetch(path, { headers: authHeader() }).then(handle),
  post: (path, body) =>
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(body),
    }).then(handle),
  patch: (path, body) =>
    fetch(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...authHeader() },
      body: JSON.stringify(body),
    }).then(handle),
  delete: (path) => fetch(path, { method: "DELETE", headers: authHeader() }).then(handle),
};

const authHeader = () => (getToken() ? { Authorization: `Bearer ${getToken()}` } : {});

/**
 * POST an SSE endpoint and dispatch {event, data} objects as they arrive.
 * The chat route streams OpenAI-style SSE over a POST body, so EventSource
 * is not an option — parse the ReadableStream manually.
 */
export async function postSSE(path, body, onEvent, signal) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
    signal,
  });
  if (res.status === 401) {
    unauthorized();
    throw new Error("未登录或会话已过期");
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop();
    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
      const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
  // 流结尾的最后一段可能没有空行终止（代理截断/中间件）——补一次冲刷
  if (buffer.trim()) {
    const lines = buffer.split("\n");
    const event = lines.find((l) => l.startsWith("event: "))?.slice(7);
    const data = lines.find((l) => l.startsWith("data: "))?.slice(6);
    if (event && data) onEvent(event, JSON.parse(data));
  }
}
