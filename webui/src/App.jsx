import { useEffect, useRef, useState } from "react";
import { api, postSSE, getToken, setToken, clearToken } from "./api.js";
import { IconChat, IconDatabase, IconReport, IconSettings } from "./components/Icons.jsx";
import { LogoMark } from "./components/Logo.jsx";
import { mdToHtml } from "./md.js";
import { Chat } from "./views/Chat.jsx";
import { Datasets } from "./views/Datasets.jsx";
import { Reports } from "./views/Reports.jsx";

const BASE_TABS = [
  ["chat", "对话分析", IconChat],
  ["datasets", "数据集", IconDatabase],
  ["reports", "报告", IconReport],
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
    window.addEventListener("datatide-unauthorized", onUnauthorized);
    return () => window.removeEventListener("datatide-unauthorized", onUnauthorized);
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
          <LogoMark />
          datatide <small>数据分析控制台</small>
        </div>
        <nav className="nav">
          {(user.role === "admin" ? [...BASE_TABS, ["settings", "设置", IconSettings]] : BASE_TABS).map(([id, label, Icon]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => switchTab(id)}>
              <Icon /> {label}
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
        {tab === "settings" && <Settings user={user} notify={notify} wrap={wrap} />}
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
        <div className="logo-row">
          <LogoMark size={34} />
          <h1>datatide</h1>
        </div>
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

function Settings({ user, wrap }) {
  const [data, setData] = useState(undefined);
  useEffect(() => {
    api.get("/api/settings").then(setData).catch((e) => setData({ error: e.message }));
  }, []);
  if (data?.error) {
    return (
      <div className="page">
        <div className="page-inner">
          <h2>设置</h2>
          <div className="panel ds-form error-text">无法加载：{data.error}（该页面仅管理员可见）</div>
        </div>
      </div>
    );
  }
  if (!data) return <div className="page"><div className="page-inner"><div className="skeleton" style={{ height: 200 }} /></div></div>;
  return (
    <div className="page">
      <div className="page-inner">
        <h2>设置</h2>
        <div className="panel ds-form" style={{ marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>分析技能（{data.skills.length}）</h3>
          <div className="muted" style={{ fontSize: 13 }}>
            内置技能随版本分发；管理员可通过 DATATIDE_SKILLS_DIR 挂载外部技能目录（标准 SKILL.md 格式），重启生效。
          </div>
          <table className="schema-table" style={{ marginTop: 10 }}>
            <thead>
              <tr><th>技能</th><th>描述</th><th>来源</th></tr>
            </thead>
            <tbody>
              {data.skills.map((s) => (
                <tr key={s.name}>
                  <td style={{ color: "var(--primary)" }}>{s.name}</td>
                  <td style={{ fontFamily: "var(--sans)" }}>{s.description}</td>
                  <td>{s.source === "builtin" ? "内置" : "外部"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel ds-form">
          <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>MCP 外部工具（{data.mcp.servers.length} 个 server）</h3>
          <div className="muted" style={{ fontSize: 13 }}>
            配置文件：{data.mcp.configPath} · 标准 mcpServers JSON 格式，修改后重启生效。
            {" "}agent 通过 mcp 网关工具（list / call）使用这些服务器提供的工具。
          </div>
          {data.mcp.servers.length > 0 && (
            <table className="schema-table" style={{ marginTop: 10 }}>
              <thead>
                <tr><th>Server</th><th>说明</th><th>已索引工具数</th></tr>
              </thead>
              <tbody>
                {data.mcp.servers.map((m) => (
                  <tr key={m.name}>
                    <td style={{ color: "var(--primary)" }}>{m.name}</td>
                    <td style={{ fontFamily: "var(--sans)" }}>{m.description || "—"}</td>
                    <td>{m.toolCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
