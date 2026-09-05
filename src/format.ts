/** Render row objects as a compact markdown table (context-window friendly). */
export function formatTable(rows: Record<string, unknown>[], maxRows = 30): string {
  if (rows.length === 0) return "（查询结果为空）";
  const shown = rows.slice(0, maxRows);
  const cols = [...new Set(shown.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) return v.toISOString();
    const s = String(v);
    return s.length > 40 ? s.slice(0, 37) + "…" : s;
  };
  const head = `| ${cols.join(" | ")} |`;
  const sep = `|${cols.map(() => " --- ").join("|")}|`;
  const body = shown.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`).join("\n");
  const note = rows.length > maxRows ? `\n（仅显示前 ${maxRows} 行，共 ${rows.length} 行）` : "";
  return [head, sep, body].join("\n") + note;
}
