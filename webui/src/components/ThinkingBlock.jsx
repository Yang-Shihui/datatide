import { useState } from "react";

/** 可折叠的思考过程卡片（pi-web-ui 的 ThinkingBlock 交互模式） */
export function ThinkingBlock({ text }) {
  const [open, setOpen] = useState(false);
  if (!text?.trim()) return null;
  return (
    <div className="thinking-block">
      <button type="button" className="thinking-toggle" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ transform: open ? "rotate(90deg)" : "none", transition: "transform 150ms ease" }}>
          <path d="m9 18 6-6-6-6" />
        </svg>
        思考过程
      </button>
      {open && <div className="thinking-body">{text}</div>}
    </div>
  );
}
