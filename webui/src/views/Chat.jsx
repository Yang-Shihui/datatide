import { useEffect, useRef, useState } from "react";
import { api, postSSE } from "../api.js";
import { ChartBox } from "../components/ChartBox.jsx";
import { mdToHtml } from "../md.js";

export function Chat({ user, notify }) {
  const [sessions, setSessions] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveBlocks, setLiveBlocks] = useState([]); // [{text, toolTrace[], charts[]}] for the in-flight answer
  const bottomRef = useRef(null);

  useEffect(() => {
    api.get("/api/sessions").then(setSessions).catch(() => {});
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, liveBlocks]);

  const openSession = async (id) => {
    if (busy) return;
    setSessionId(id);
    try {
      const msgs = await api.get(`/api/sessions/${id}/messages`);
      setMessages(
        msgs.map((m) => ({
          role: m.role,
          text: m.content,
          charts: m.role === "assistant" ? JSON.parse(m.extras_json || "{}").charts || [] : [],
        })),
      );
    } catch (err) {
      notify(err.message, true);
    }
  };

  const newSession = () => {
    if (busy) return;
    setSessionId(null);
    setMessages([]);
  };

  const send = async () => {
    const question = input.trim();
    if (!question || busy) return;
    setInput("");
    setBusy(true);
    setMessages((m) => [...m, { role: "user", text: question }]);
    const blocks = [{ text: "", trace: [], charts: [] }];
    const touch = () => setLiveBlocks([...blocks]);
    touch();

    const controller = new AbortController();
    try {
      await postSSE(
        "/api/chat",
        { session_id: sessionId, message: question },
        (event, data) => {
          const cur = blocks[blocks.length - 1];
          if (event === "text") cur.text += data.delta;
          else if (event === "thinking") {
            if (!cur.thinking) cur.thinking = "";
            cur.thinking += data.delta;
          } else if (event === "tool_start") cur.trace.push(`▸ ${data.toolName}(${JSON.stringify(data.args ?? {}).slice(0, 90)})`);
          else if (event === "tool_end") cur.trace.push(`${data.isError ? "✗" : "✓"} ${data.toolName}`);
          else if (event === "chart") cur.charts.push(data);
          else if (event === "error") cur.text += `\n\n⚠ ${data.message}`;
          touch();
        },
        controller.signal,
      );
    } catch (err) {
      notify(err.message, true);
      if (String(err).includes("Failed to fetch")) controller.abort();
    }

    // finalize: merge live blocks into messages
    setLiveBlocks([]);
    setMessages((m) => [
      ...m,
      ...blocks
        .filter((b) => b.text || b.charts.length)
        .map((b) => ({ role: "assistant", text: b.text, charts: b.charts, thinking: b.thinking, trace: b.trace })),
    ]);
    setBusy(false);
    if (sessionId == null) {
      api.get("/api/sessions").then((s) => {
        setSessions(s);
        if (s.length > 0) setSessionId(s[0].id);
      }).catch(() => {});
    } else {
      api.get("/api/sessions").then(setSessions).catch(() => {});
    }
  };

  const blocks = [
    ...messages.map((m) => ({ ...m, live: false })),
    ...liveBlocks.map((b) => ({ ...b, role: "assistant", live: true })),
  ];

  return (
    <div className="chat-layout">
      <aside className="session-list">
        <button className="ghost new" onClick={newSession}>
          ＋ 新对话
        </button>
        {sessions.map((s) => (
          <div key={s.id} className={`session-item${s.id === sessionId ? " active" : ""}`} onClick={() => openSession(s.id)}>
            {s.title}
          </div>
        ))}
      </aside>
      <div className="chat-pane">
        <div className="messages">
          {blocks.length === 0 && (
            <div className="empty-center">
              <div style={{ fontSize: 15, color: "var(--text)" }}>问点数据问题</div>
              <div>例如：华东区 2026 年 7-8 月销售额同比如何？可能是什么原因？</div>
            </div>
          )}
          {blocks.map((b, i) => (
            <MessageBlock key={i} block={b} />
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="chat-input">
          <textarea
            value={input}
            placeholder={`向数据分析助手提问…（${user.datasets.length > 0 ? user.datasets.join("、") : "无授权数据集"}）`}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !busy) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button className="primary" onClick={send} disabled={busy || !input.trim()}>
            {busy ? "分析中…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBlock({ block }) {
  return (
    <>
      {block.trace?.length > 0 && (
        <div className="tool-trace">
          {block.trace.map((t, i) => (
            <div key={i} className={t.endsWith("✗") ? "err" : ""}>
              ▸ {t}
            </div>
          ))}
        </div>
      )}
      <div className={`msg ${block.role}`}>
        <div className="bubble">
          <div className="role">{block.role === "user" ? "你" : "分析助手"}</div>
          {block.live && !block.text ? (
            <span className="muted">思考与查询中…</span>
          ) : (
            <div dangerouslySetInnerHTML={{ __html: mdToHtml(block.text || "") }} />
          )}
        </div>
      </div>
      {block.charts?.map((c) => (
        <ChartBox key={c.id} spec={c.spec} title={c.title} />
      ))}
    </>
  );
}
