import { useEffect, useRef, useState } from "react";

const Chevron = ({ open }) => (
  <svg
    viewBox="0 0 24 24" width="14" height="14" fill="none"
    stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"
    style={{ transform: open ? "rotate(180deg)" : "none", transition: "transform 150ms ease", flex: "none" }}
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const Check = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none"
    stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" style={{ flex: "none" }}>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/**
 * 自绘下拉：原生 <select> 的展开浮层是操作系统渲染的，无法定制样式，
 * 这里用 trigger + listbox 完全接管（Esc 关闭、点击外部关闭、键盘上下+回车）。
 */
export function Select({ value, onChange, options, placeholder = "选择…", ariaLabel }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const rootRef = useRef(null);

  useEffect(() => {
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  useEffect(() => {
    if (!open) setActive(-1);
  }, [open]);

  const commit = (option) => {
    onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (!open) {
      if (e.key === "Enter" || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => {
        const next = i < 0 ? 0 : Math.min(Math.max(i + (e.key === "ArrowDown" ? 1 : -1), 0), options.length - 1);
        return next;
      });
    } else if (e.key === "Enter" && active >= 0) {
      e.preventDefault();
      commit(options[active]);
    }
  };

  const current = options.find((o) => o.value === value);

  return (
    <div className="select" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        className="select-trigger"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className={current ? "" : "select-placeholder"}>{current ? current.label : placeholder}</span>
        <Chevron open={open} />
      </button>
      {open && (
        <ul className="select-menu" role="listbox">
          {options.map((o, i) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={`select-item${o.value === value ? " selected" : ""}${i === active ? " active" : ""}`}
                onMouseEnter={() => setActive(i)}
                onClick={() => commit(o)}
              >
                <span>{o.label}</span>
                {o.value === value && <Check />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
