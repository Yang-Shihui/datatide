import { splitMd, tableToCsv } from "../md.js";

function downloadCsv(header, rows, index) {
  const bom = "\uFEFF"; // Excel 中文兼容
  const csv = bom + tableToCsv(header, rows);
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `datatide-结果表-${index}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** 助手回答里每个 markdown 表格上方给一个 CSV 导出按钮 */
export function TableExports({ text }) {
  const tables = splitMd(text).filter((s) => s.type === "table");
  if (tables.length === 0) return null;
  return (
    <div className="table-exports">
      {tables.map((t, i) => (
        <button key={i} type="button" className="ghost table-export" onClick={() => downloadCsv(t.header, t.rows, i + 1)}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M7 10l5 5 5-5" />
            <path d="M12 15V3" />
          </svg>
          导出结果表 {tables.length > 1 ? i + 1 : ""}
        </button>
      ))}
    </div>
  );
}
