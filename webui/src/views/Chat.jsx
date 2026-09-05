import { useEffect, useRef, useState } from "react";
import { api, postSSE } from "../api.js";
import { ChartBox } from "../components/ChartBox.jsx";
import { TableExports } from "../components/TableExports.jsx";
import { Markdown } from "../components/Markdown.jsx";
import { ThinkingBlock } from "../components/ThinkingBlock.jsx";

const SKILL_RE = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/;

export function Chat({ user, notify }) {
  const [sessions, setSessions] = useState([]);
  const [skills, setSkills] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveBlocks, setLiveBlocks] = useState([]);
  const [pickerIdx, setPickerIdx] = useState(-1); // -1 = 关闭
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const bottomRef = useRef(null);

  useEffect(() => {
    api.get("/api/sessions").then(setSessions).catch(() => {});
    api.get("/api/skills").then(setSkills).catch(() => {});
  }, []);

  // 智能滚动：仅当用户贴底时跟随，向上翻历史不打扰
  useEffect(() => {
    if (stickToBottomRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, liveBlocks]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  const openSession = async (id) => {
    if (busy) return;
    setSessionId(id);
    try {
      const msgs = await api.get(`/api/sessions/${id}/messages`);
      setMessages(
        msgs.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.content,
          charts: m.role === "assistant" ? JSON.parse(m.extras_json || "{}").charts || [] : [],
          thinking: m.role === "assistant" ? JSON.parse(m.extras_json || "{}").thinking || "" : "",
        })),
      );
      stickToBottomRef.current = true;
    } catch (err) {
      notify(err.message, true);
    }
  };

  const newSession = () => {
    if (busy) return;
    setSessionId(null);
    setMessages([]);
    stickToBottomRef.current = true;
  };

  const refreshSessions = () => api.get("/api/sessions").then(setSessions).catch(() => {});

  const send = async (textArg) => {
    const raw = (textArg ?? input).trim();
    if (!raw || busy) return;
    setInput("");
    setPickerIdx(-1);
    stickToBottomRef.current = true;

    // /技能名 问题 → 显式调用技能
    let skill;
    let question = raw;
    const m = SKILL_RE.exec(raw);
    if (m && skills.some((s) => s.name === m[1])) {
      skill = m[1];
      question = m[2]?.trim() || "请按该技能的方法论对当前数据集进行分析";
    }

    setBusy(true);
    setMessages((prev) => [...prev, { role: "user", text: raw }]);
    const blocks = [{ text: "", trace: [], charts: [] }];
    const touch = () => setLiveBlocks([...blocks]);
    touch();

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      await postSSE(
        "/api/chat",
        { session_id: sessionId, message: question, ...(skill ? { skill } : {}) },
        (event, data) => {
          const cur = blocks[blocks.length - 1];
          if (event === "text") cur.text += data.delta;
          else if (event === "thinking") {
            if (!cur.thinking) cur.thinking = "";
            cur.thinking += data.delta;
          } else if (event === "tool_start") cur.trace.push(`${data.toolName}(${JSON.stringify(data.args ?? {}).slice(0, 90)})`);
          else if (event === "tool_end") cur.trace.push(`${data.isError ? "✗ " : "✓ "}${data.toolName}`);
          else if (event === "chart") cur.charts.push(data);
          else if (event === "error") cur.text += `\n\n⚠ ${data.message}`;
          touch();
        },
        controller.signal,
      );
    } catch (err) {
      if (!String(err).includes("abort")) notify(err.message, true);
    }
    abortRef.current = null;

    setLiveBlocks([]);
    setBusy(false);

    // 回合结束后以服务端持久化消息为准（本地追加的消息没有 id，编辑重发/截断需要 id）
    const finalize = async () => {
      const toLocal = (m) => {
        const extras = m.role === "assistant" ? JSON.parse(m.extras_json || "{}") : {};
        return {
          id: m.id,
          role: m.role,
          text: m.content,
          charts: extras.charts || [],
          thinking: extras.thinking || "",
        };
      };
      try {
        let sid = sessionId;
        if (sid == null) {
          const s = await api.get("/api/sessions");
          setSessions(s);
          sid = s[0]?.id;
          if (sid != null) setSessionId(sid);
        }
        if (sid != null) {
          setMessages((await api.get(`/api/sessions/${sid}/messages`)).map(toLocal));
          return;
        }
      } catch {
        // 回退到本地合并（无 id，仅展示）
      }
      setMessages((prev) => [
        ...prev,
        ...blocks
          .filter((b) => b.text || b.charts.length)
          .map((b) => ({ role: "assistant", text: b.text, charts: b.charts, thinking: b.thinking, trace: b.trace })),
      ]);
    };
    void finalize();
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  const copyMessage = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      notify("已复制");
    } catch {
      notify("复制失败（浏览器不允许访问剪贴板）", true);
    }
  };

  /** 编辑重发：回退到该消息（服务端截断 + 销毁内存 agent），原文回填输入框 */
  const editResend = async (msg) => {
    if (busy) return;
    if (sessionId == null) {
      setInput(msg.text);
      inputRef.current?.focus();
      return;
    }
    try {
      await api.post(`/api/sessions/${sessionId}/truncate`, { message_id: msg.id });
      const idx = messages.findIndex((x) => x.id === msg.id);
      setMessages(messages.slice(0, idx));
      setInput(msg.text.replace(/^\/skill:([a-z0-9-]+)\s*/, "/$1 "));
      stickToBottomRef.current = true;
      inputRef.current?.focus();
      notify(`已回退，编辑后重新发送（其后的 ${messages.length - idx} 条消息已移除）`);
      refreshSessions();
    } catch (err) {
      notify(err.message, true);
    }
  };

  // "/" 技能面板：输入是以 / 开头的纯命令 token（还没打空格）时弹出
  const pickerQuery = /^\/([a-z0-9-]*)$/.exec(input) ? input.slice(1) : null;
  const pickerSkills =
    pickerQuery === null
      ? []
      : skills.filter((s) => s.name.startsWith(pickerQuery) || s.description.includes(pickerQuery));
  const pickerOpen = pickerSkills.length > 0;

  const applySkill = (name) => {
    setInput(`/${name} `);
    setPickerIdx(-1);
    inputRef.current?.focus();
  };

  const onInputChange = (e) => {
    setInput(e.target.value);
    setPickerIdx(-1);
  };

  const onKeyDown = (e) => {
    if (pickerOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPickerIdx((i) => (i + 1) % pickerSkills.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPickerIdx((i) => (i <= 0 ? pickerSkills.length - 1 : i - 1));
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applySkill(pickerSkills[pickerIdx >= 0 ? pickerIdx : 0].name);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setPickerIdx(-1);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey && !busy) {
      e.preventDefault();
      send();
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
        <div className="messages" onScroll={onScroll}>
          {blocks.length === 0 && (
            <div className="empty-center">
              <div className="title">问点数据问题</div>
              <div className="suggestions">
                {[
                  "华东区2026年7-8月销售额同比如何？可能是什么原因？",
                  "2026年各区域销售额占比",
                  "对比线上和线下渠道的月度趋势",
                ].map((q) => (
                  <button key={q} className="suggestion-chip" onClick={() => send(q)}>
                    {q}
                  </button>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                输入 / 可唤起分析技能
              </div>
            </div>
          )}
          {blocks.map((b, i) => (
            <MessageBlock key={b.id ?? `live-${i}`} block={b} onCopy={copyMessage} onEdit={busy ? undefined : editResend} />
          ))}
          <div ref={bottomRef} />
        </div>
        <div className="composer">
          {pickerOpen && (
            <div className="skill-picker" role="listbox">
              <div className="skill-picker-head">分析技能</div>
              {pickerSkills.map((s, i) => (
                <button
                  key={s.name}
                  type="button"
                  role="option"
                  aria-selected={i === pickerIdx}
                  className={`skill-option${i === pickerIdx ? " active" : ""}`}
                  onMouseEnter={() => setPickerIdx(i)}
                  onMouseDown={(e) => {
                    e.preventDefault(); // 防止 textarea 失焦
                    applySkill(s.name);
                  }}
                >
                  <span className="skill-name">/{s.name}</span>
                  <span className="skill-desc">{s.description}</span>
                </button>
              ))}
            </div>
          )}
          <textarea
            ref={inputRef}
            value={input}
            placeholder="向数据分析助手提问… 输入 / 唤起技能"
            onChange={onInputChange}
            onKeyDown={onKeyDown}
          />
          {busy ? (
            <button className="ghost stop" onClick={stop}>
              停止
            </button>
          ) : (
            <button className="primary" onClick={() => send()} disabled={!input.trim()}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageBlock({ block, onCopy, onEdit }) {
  return (
    <>
      {block.trace?.length > 0 && (
        <div className="tool-trace">
          {block.trace.map((t, i) => {
            const failed = t.startsWith("✗");
            return (
              <span key={i} className={`tool-chip${failed ? " err" : ""}`}>
                <span className="dot" /> {failed ? t.slice(2) : t}
              </span>
            );
          })}
        </div>
      )}
      <div className={`msg ${block.role}`}>
        <div className="bubble">
          <div className="msg-head">
            <span className="role">{block.role === "user" ? "你" : "分析助手"}</span>
            <span className="msg-actions">
              <button type="button" title="复制" onClick={() => onCopy(block.text)}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                复制
              </button>
              {block.role === "user" && !block.live && onEdit && (
                <button type="button" title="编辑并重新发送（其后的对话将被移除）" onClick={() => onEdit(block)}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                  编辑
                </button>
              )}
            </span>
          </div>
          {block.live && !block.text ? (
            <span className="typing-dots"><span /><span /><span /></span>
          ) : (
            <>
              {block.thinking ? <ThinkingBlock text={block.thinking} /> : null}
              <Markdown text={block.text || ""} />
            </>
          )}
        </div>
      </div>
      {block.charts?.map((c) => (
        <ChartBox key={c.id} spec={c.spec} title={c.title} />
      ))}
      {block.role === "assistant" && !block.live && <TableExports text={block.text} />}
    </>
  );
}
