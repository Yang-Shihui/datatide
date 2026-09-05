// Minimal markdown renderer. Escapes all HTML first, then applies a small
// subset: headings, bold, inline code, tables, lists. No raw HTML passthrough.
export function mdToHtml(md) {
  // 模型偶尔把标题写在段中同一行（"…假设。## 结论"）——强制标题另起一行
  md = md.replace(/([^\n#])((?:#{1,4})\s)/g, "$1\n$2");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) =>
    esc(s)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");

  const lines = md.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\|.*\|/.test(line) && i + 1 < lines.length && /^\|[-\s|]+\|$/.test(lines[i + 1])) {
      const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((h) => `<th>${inline(h)}</th>`).join("")}</tr></thead>` +
          `<tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      continue;
    }
    if (/^#{1,4}\s/.test(line)) {
      out.push(`<h3>${inline(line.replace(/^#{1,4}\s/, ""))}</h3>`);
      i++;
      continue;
    }
    if (/^\s*[-*]\s/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*]\s/, ""));
      out.push(`<ul>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</ul>`);
      continue;
    }
    if (line.trim() === "") {
      out.push("<div style='height:6px'></div>");
      i++;
      continue;
    }
    out.push(`<p style='margin:4px 0'>${inline(line)}</p>`);
    i++;
  }
  return out.join("");
}

/** 把 markdown 拆成文本段与表格段；表格段返回结构化数据供渲染与 CSV 导出 */
export function splitMd(md) {
  const lines = md.split("\n");
  const segments = [];
  let buf = [];
  let i = 0;
  const isTableLine = (l) => /^\|.*\|/.test(l);
  const isSep = (l) => /^\|[-\s|]+\|$/.test(l);
  const cells = (l) => l.split("|").slice(1, -1).map((c) => c.trim());
  while (i < lines.length) {
    if (isTableLine(lines[i]) && i + 1 < lines.length && isSep(lines[i + 1])) {
      if (buf.length) {
        segments.push({ type: "md", text: buf.join("\n") });
        buf = [];
      }
      const header = cells(lines[i]);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableLine(lines[i])) rows.push(cells(lines[i++]));
      segments.push({ type: "table", header, rows });
      continue;
    }
    buf.push(lines[i++]);
  }
  if (buf.length) segments.push({ type: "md", text: buf.join("\n") });
  return segments;
}

export function tableToCsv(header, rows) {
  const esc = (v) => {
    const s2 = String(v ?? "");
    return /[",\n]/.test(s2) ? '"' + s2.replace(/"/g, '""') + '"' : s2;
  };
  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}
