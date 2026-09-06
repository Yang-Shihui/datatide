import { useEffect, useRef, useState } from "react";
import { api, postSSE } from "../api.js";
import { ChartBox } from "../components/ChartBox.jsx";
import { TableExports } from "../components/TableExports.jsx";
import { Markdown } from "../components/Markdown.jsx";
import { ThinkingBlock } from "../components/ThinkingBlock.jsx";

const SKILL_RE = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/;

export function Chat({ user, notify, wrap }) {
  const [sessions, setSessions] = useState([]);
  const [skills, setSkills] = useState([]);
  const [sessionId, setSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [liveBlocks, setLiveBlocks] = useState([]);
  const [pickerIdx, setPickerIdx] = useState(-1);
  const [pickerDismissed, setPickerDismissed] = useState(false);
  const [editing, setEditing] = useState(null);
  const [renaming, setRenaming] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(() => localStorage.getItem("datatide-sidebar") !== "0");
  const inputRef = useRef(null);
  const abortRef = useRef(null);
  const stickToBottomRef = useRef(true);
  const bottomRef = useRef(null);
  const turnSeqRef = useRef(0);

  useEffect(() => {
    api.get("/api/sessions").then(setSessions).catch(() => {});
    api.get("/api/skills").then(setSkills).catch(() => {});
  }, []);

  useEffect(() => {
    if (stickToBottomRef.current) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, liveBlocks]);

  const onScroll = (e) => {
    const el = e.currentTarget;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
  };

  const openSession = async (id) => {
    if (busy) return;
    const prevSessionId = sessionId;
    turnSeqRef.current += 1;
    setEditing(null);
    setPickerDismissed(false);
    setSessionId(id);
    try {
      const msgs = await api.get(`/api/sessions/${id}/messages`);
      setMessages(
        msgs.map((m) => {
          let extras = {};
          try {
            extras = m.role === "assistant" ? JSON.parse(m.extras_json || "{}") : {};
          } catch {
            extras = {};
          }
          return {
            id: m.id,
            role: m.role,
            text: m.content,
            charts: extras.charts || [],
            thinking: extras.thinking || "",
          };
        }),
      );
      stickToBottomRef.current = true;
    } catch (err) {
      setSessionId(prevSessionId);
      notify(err.message, true);
    }
  };

  const newSession = () => {
    if (busy) return;
    turnSeqRef.current += 1;
    setEditing(null);
    setPickerDismissed(false);
    setSessionId(null);
    setMessages([]);
    stickToBottomRef.current = true;
  };

  const refreshSessions = () => api.get("/api/sessions").then(setSessions).catch(() => {});

  const toggleSidebar = () => {
    setSidebarOpen((v) => {
      localStorage.setItem("datatide-sidebar", v ? "0" : "1");
      return !v;
    });
  };

  const renameSession = wrap(async (id, title) => {
    await api.patch(`/api/sessions/${id}`, { title: title.trim() });
    setRenaming(null);
    refreshSessions();
  });

  const deleteSession = wrap(async (id) => {
    await api.delete(`/api/sessions/${id}`);
    setDeleting(null);
    if (sessionId === id) {
      setSessionId(null);
      setMessages([]);
    }
    refreshSessions();
    notify("会话已删除");
  });

  const send = async (textArg, editMessageId) => {
    const raw = (textArg ?? input).trim();
    if (!raw || busy) return;
    if (!textArg) setInput("");
    setPickerIdx(-1);
    setEditing(null);
    setPickerDismissed(false);
    stickToBottomRef.current = true;

    let skill;
    let question = raw;
    const m = SKILL_RE.exec(raw);
    if (m && skills.some((s) => s.name === m[1])) {
      skill = m[1];
      question = m[2]?.trim() || "请按该技能的方法论对当前数据集进行分析";
    }

    turnSeqRef.current += 1;
    const mySeq = turnSeqRef.current;
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
        {
          session_id: sessionId,
          message: question,
          ...(skill ? { skill } : {}),
          ...(editMessageId != null ? { edit_message_id: editMessageId } : {}),
        },
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
    setBusy(false);

    // 回合结束后以服务端持久化消息为准（本地追加的消息没有 id，编辑重发/截断需要 id）。
    // liveBlocks 先不清空：等 refetch 成功再替换，避免回答在慢网络上闪烁消失。
    const finalize = async () => {
      const toLocal = (m) => {
        let extras = {};
        try {
          extras = m.role === "assistant" ? JSON.parse(m.extras_json || "{}") : {};
        } catch {
          extras = {};
        }
        return {
          id: m.id,
          role: m.role,
          text: m.content,
          charts: extras.charts || [],
          thinking: extras.thinking || "",
        };
      };
      let fetched = null;
      try {
        let sid = sessionId;
        if (sid == null) {
          const s = await api.get("/api/sessions");
          setSessions(s);
          sid = s[0]?.id;
          if (sid != null) setSessionId(sid);
        }
        if (sid != null) fetched = await api.get(`/api/sessions/${sid}/messages`);
      } catch {
        // 拉取失败走本地合并
      }
      if (mySeq !== turnSeqRef.current) return; // 代际已变（用户切换/新开/新轮次），丢弃过期结果
      setLiveBlocks([]);
      if (fetched) {
        setMessages(fetched.map(toLocal));
        return;
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

  const startEdit = (msg) => {
    if (busy) return;
    setEditing({ id: msg.id, text: msg.text.replace(/^\/skill:([a-z0-9-]+)\s*/, "/$1 ") });
  };

  const submitEdit = (msgId, newText) => {
    const idx = messages.findIndex((x) => x.id === msgId);
    if (idx < 0) {
      notify("要编辑的消息已不存在（会话可能被其他窗口修改）", true);
      return;
    }
    setMessages(messages.slice(0, idx));
    stickToBottomRef.current = true;
    void send(newText, msgId);
  };

  const pickerQuery = /^\/([a-z0-9-]*)$/.exec(input) ? input.slice(1) : null;
  const pickerSkills =
    pickerQuery === null
      ? []
      : skills.filter((s) => s.name.startsWith(pickerQuery) || s.description.includes(pickerQuery));
  const pickerOpen = !pickerDismissed && pickerSkills.length > 0;

  const applySkill = (name) => {
    setInput(`/${name} `);
    setPickerIdx(-1);
    setPickerDismissed(false);
    inputRef.current?.focus();
  };

  const onInputChange = (e) => {
    setInput(e.target.value);
    setPickerIdx(-1);
    setPickerDismissed(false);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
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
        setPickerDismissed(true);
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
    <div className={`chat-layout${sidebarOpen ? "" : " sidebar-collapsed"}`}>
      <button
        type="button"
        className="sidebar-toggle"
        title={sidebarOpen ? "收起侧栏" : "展开侧栏"}
        onClick={toggleSidebar}
        style={{ position: "absolute", left: sidebarOpen ? 252 : 12, top: 10, zIndex: 30, background: "var(--panel)", border: "1px solid var(--border)" }}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <path d="M9 3v18" />
        </svg>
      </button>
      <aside className="sidebar session-list">
        <button className="ghost new" onClick={newSession}>
          ＋ 新对话
        </button>
        {sessions.map((s) =>
          renaming?.id === s.id ? (
            <form
              key={s.id}
              className="session-rename"
              onSubmit={(e) => {
                e.preventDefault();
                if (renaming.text.trim()) renameSession(s.id, renaming.text);
                else setRenaming(null);
              }}
            >
              <input
                value={renaming.text}
                autoFocus
                onChange={(e) => setRenaming({ ...renaming, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setRenaming(null);
                }}
              />
              <button type="submit" className="primary">✓</button>
            </form>
          ) : (
            <div key={s.id} className={`session-item${s.id === sessionId ? " active" : ""}`} onClick={() => openSession(s.id)}>
              {s.title}
              <span className="session-actions">
                <button
                  type="button"
                  title="重命名"
                  onClick={(e) => {
                    e.stopPropagation();
                    setRenaming({ id: s.id, text: s.title });
                  }}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                </button>
                <button
                  type="button"
                  title="删除会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleting(s.id);
                  }}
                >
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </span>
            </div>
          ),
        )}
      </aside>
      <div className="chat-pane">
        <div className="messages" onScroll={onScroll}>
          <div className="chat-column">
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
              <MessageBlock
                key={b.id ?? `live-${i}`}
                block={b}
                onCopy={copyMessage}
                onEdit={busy ? undefined : startEdit}
                editing={editing}
                onSubmitEdit={submitEdit}
                onCancelEdit={() => setEditing(null)}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </div>
        <div className="composer-area">
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
                      e.preventDefault();
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
              rows={1}
              placeholder="向数据分析助手提问… 输入 / 唤起技能"
              onChange={onInputChange}
              onKeyDown={onKeyDown}
            />
            {busy ? (
              <button className="send-btn stop-btn" title="停止生成" onClick={stop}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor">
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              </button>
            ) : (
              <button className="send-btn" title="发送" onClick={() => send()} disabled={!input.trim()}>
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            )}
          </div>
          <div className="composer-hint">AI 可能会出错，请核对重要数据。</div>
        </div>
      </div>
      {deleting != null && (
        <div className="modal-overlay" onClick={() => setDeleting(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>删除会话</h3>
            <p>会话及其全部消息将被删除，不可恢复。</p>
            <div className="inline-edit-actions">
              <button type="button" className="ghost" onClick={() => setDeleting(null)}>取消</button>
              <button type="button" className="primary" style={{ background: "var(--err)" }} onClick={() => deleteSession(deleting)}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MessageBlock({ block, onCopy, onEdit, editing, onSubmitEdit, onCancelEdit }) {
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
              </button>
              {block.role === "user" && !block.live && block.id != null && onEdit && editing?.id !== block.id && (
                <button type="button" title="编辑并重新生成回答（之前的消息不受影响）" onClick={() => onEdit(block)}>
                  <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                  </svg>
                </button>
              )}
            </span>
          </div>
          {editing != null && block.id != null && editing.id === block.id ? (
            <InlineEdit
              initial={editing.text}
              onCancel={() => onCancelEdit()}
              onSubmit={(text) => onSubmitEdit(block.id, text)}
            />
          ) : (
            <>
              {block.live && !block.text ? (
                <span className="typing-dots"><span /><span /><span /></span>
              ) : (
                <>
                  {block.thinking ? <ThinkingBlock text={block.thinking} /> : null}
                  <Markdown text={block.text || ""} />
                </>
              )}
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

function InlineEdit({ initial, onCancel, onSubmit }) {
  const [text, setText] = useState(initial);
  const ref = useRef(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.setSelectionRange(text.length, text.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submit = () => {
    const t = text.trim();
    if (t) onSubmit(t);
  };
  return (
    <div className="inline-edit">
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === "Escape") onCancel();
        }}
      />
      <div className="inline-edit-actions">
        <button type="button" className="ghost" onClick={onCancel}>
          取消
        </button>
        <button type="button" className="primary" onClick={submit} disabled={!text.trim()}>
          重新生成
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        提交后此消息及其后的回答将被替换，之前的消息与上下文保持不变
      </div>
    </div>
  );
}
