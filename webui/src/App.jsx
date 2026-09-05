import { useEffect, useRef, useState } from "react";
import { api, postSSE, getToken, setToken, clearToken } from "./api.js";
import { ChartBox } from "./components/ChartBox.jsx";
import { mdToHtml } from "./md.js";
import { Chat } from "./views/Chat.jsx";
import { Datasets } from "./views/Datasets.jsx";
import { Reports } from "./views/Reports.jsx";

const TABS = [
  ["chat", "对话分析"],
  ["datasets", "数据集"],
  ["reports", "报告"],
];

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = loading, null = logged out
  const [tab, setTab] = useState(location.hash.slice(1) || "chat");
  const [toast, setToast] = useState(null);
  const toastTimer = useRef(null);

  const notify = (msg, error = false) => {
    setToast({ msg, error });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  };
  const wrap = (fn) => (...args) => fn(...args).catch((e) => notify(e.message, true));

  useEffect(() => {
    const onHash = () => setTab(location.hash.slice(1) || "chat");
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    if (!getToken()) return setUser(null);
    api.get("/api/me").then(setUser).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    const onUnauthorized = () => setUser(null);
    window.addEventListener("bi-agent-unauthorized", onUnauthorized);
    return () => window.removeEventListener("bi-agent-unauthorized", onUnauthorized);
  }, []);

  const switchTab = (id) => {
    history.replaceState(null, "", `#${id}`);
    setTab(id);
  };

  if (user === undefined) return <div className="login-wrap muted">加载中…</div>;
  if (user === null) return <Login onLogin={setUser} notify={notify} />;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          bi<span className="dot">·</span>agent <small>数据分析控制台</small>
        </div>
        <nav className="nav">
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => switchTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="who">
          <span>
            <b>{user.username}</b> · {user.role}
          </span>
          <button className="ghost" onClick={() => { clearToken(); setUser(null); }}>
            退出
          </button>
        </div>
      </header>
      <main className="main">
        {tab === "chat" && <Chat user={user} notify={notify} wrap={wrap} />}
        {tab === "datasets" && <Datasets user={user} notify={notify} wrap={wrap} refreshMe={() => api.get("/api/me").then(setUser)} />}
        {tab === "reports" && <Reports user={user} notify={notify} wrap={wrap} />}
      </main>
      {toast && <div className={`toast${toast.error ? " error" : ""}`}>{toast.msg}</div>}
    </div>
  );
}

function Login({ onLogin, notify }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      if (mode === "register") await api.post("/auth/register", { username, password });
      const { token } = await api.post("/auth/login", { username, password });
      setToken(token);
      onLogin(await api.get("/api/me"));
    } catch (err) {
      notify(err.message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="panel login-card" onSubmit={submit}>
        <h1>
          bi<span style={{ color: "var(--accent)" }}>·</span>agent
        </h1>
        <div className="sub">自托管对话式 BI · 数据不出内网</div>
        <label>用户名</label>
        <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <label>密码</label>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="primary" disabled={busy || !username || !password}>
          {mode === "login" ? "登录" : "注册并登录"}
        </button>
        <div className="hint">
          {mode === "login" ? "还没有账号？" : "已有账号？"}
          <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === "login" ? "register" : "login"); }}>
            {mode === "login" ? "注册（首个用户成为管理员）" : "去登录"}
          </a>
        </div>
      </form>
    </div>
  );
}
