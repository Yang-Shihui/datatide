/**
 * Read-only guard for agent-generated SQL.
 *
 * The agent may only run a single top-level SELECT/WITH statement that
 * references registered dataset views. Everything else (DDL/DML, pragmas,
 * attaching databases, file-reading table functions) is rejected before the
 * statement ever reaches DuckDB. This is defense in depth on top of the
 * tool layer's dataset-permission check, not a SQL parser: novel bypasses
 * are possible, so the DuckDB connection runs with the least privilege the
 * engine allows (read-only attachments, no write-back endpoints).
 */

const STATEMENT_KEYWORDS = new Set([
  // multi-statement / session control
  "attach", "detach", "pragma", "set", "reset", "use",
  "checkpoint", "vacuum", "analyze", "call",
  // extensions / external code
  "install", "load", "force",
  // writes / schema
  "create", "insert", "update", "delete", "alter", "drop",
  "export", "import", "copy",
  // transactions
  "begin", "commit", "rollback", "transaction",
  // SELECT ... INTO produces a table
  "into",
]);

// Table functions that read files or foreign databases directly. Users must
// go through registered dataset views, or dataset-level permissions and the
// dataset allowlist could be bypassed (e.g. read_text('/etc/passwd')).
const FILE_TABLE_FUNCTIONS = new Set([
  "read_csv", "read_csv_auto", "read_parquet", "read_json", "read_json_auto",
  "read_jsonl", "read_ndjson", "read_text", "read_blob", "read_xlsx",
  "read_iceberg", "glob", "parquet_scan", "csv_scan", "json_scan",
  "iceberg_scan", "delta_scan", "sqlite_scan", "sqlite_attach", "postgres_scan",
  "postgres_scanner", "mysql_scan", "sniff_csv",
]);

export interface GuardResult {
  ok: true;
  /** guarded SQL: comments stripped, single statement, hard LIMIT applied */
  sql: string;
}

export interface GuardRejection {
  ok: false;
  reason: string;
}

/** Strip -- and /* *​/ comments while respecting string literals. */
export function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += ch;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            out += quote + quote; // escaped quote ('' or "")
            i += 2;
            continue;
          }
          break;
        }
        out += sql[i];
        i++;
      }
      if (i < n) {
        out += quote;
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Split on top-level semicolons, respecting single/double-quoted strings. */
function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      cur += ch;
      i++;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            cur += quote;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ";") {
      parts.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  parts.push(cur);
  return parts;
}

/** Replace single-quoted string literals with placeholders (keyword checks run on the masked text). */
function maskStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "'…'");
}

/** Whole-word uppercase-insensitive token check (single-quoted strings masked first). */
function containsWord(sql: string, word: string): boolean {
  const re = new RegExp(`"[^"]*"|\\b${word}\\b`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(maskStrings(sql))) !== null) {
    // a match that landed inside a quoted identifier is not the keyword
    if (!m[0].startsWith('"')) return true;
  }
  return false;
}

/** All `name(` occurrences, for the file-reading table function blocklist. */
function calledFunctions(sql: string): Set<string> {
  const fns = new Set<string>();
  const re = /"([^"]+)"\s*\(|\b([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  const masked = maskStrings(sql);
  while ((m = re.exec(masked)) !== null) {
    fns.add((m[1] ?? m[2] ?? "").toLowerCase());
  }
  return fns;
}

interface Token {
  text: string;
  pos: number;
  kind: "word" | "quoted" | "punct";
}

/** Lexer: words, quoted identifiers, single-quoted strings (as opaque words), punctuation. */
function lex(sql: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i++;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      tokens.push({ text: sql.slice(start, i), pos: start, kind: ch === "'" ? "word" : "quoted" });
      continue;
    }
    if (/[a-zA-Z_0-9]/.test(ch)) {
      const start = i;
      while (i < n && /[a-zA-Z_0-9]/.test(sql[i]!)) i++;
      tokens.push({ text: sql.slice(start, i), pos: start, kind: "word" });
      continue;
    }
    tokens.push({ text: ch, pos: i, kind: "punct" });
    i++;
  }
  return tokens;
}

const JOIN_WORDS = new Set(["join", "inner", "left", "right", "full", "outer", "cross", "natural", "as", "on"]);
const CTE_RE = /("[^"]+"|[a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\([a-zA-Z_0-9,\s]*\))?\s*as\s*\(/gi;

/**
 * Table/view references after FROM or JOIN, including comma-separated table
 * lists — a missed comma ref (`FROM sales, secret`) would be an allowlist
 * bypass. Subqueries in parens are skipped; CTE aliases are returned
 * separately so they pass the allowlist.
 */
export function extractTableRefs(sql: string): { refs: string[]; cteNames: Set<string> } {
  const refs: string[] = [];
  const cteNames = new Set<string>();

  CTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CTE_RE.exec(sql)) !== null) {
    cteNames.add(m[1]!.replace(/"/g, "").toLowerCase());
  }

  const tokens = lex(sql);
  const isIdent = (t: Token) => t.kind === "quoted" || (t.kind === "word" && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t.text));
  const skipParens = (i: number): number => {
    // tokens[i] is "(", return the index after the matching ")"
    let depth = 0;
    while (i < tokens.length) {
      if (tokens[i]!.text === "(") depth++;
      if (tokens[i]!.text === ")") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
    return i;
  };
  const readDottedRef = (i: number): { ref: string; next: number } | null => {
    const parts: string[] = [];
    let j = i;
    let expectPart = true;
    while (j < tokens.length) {
      const t = tokens[j]!;
      if (expectPart && isIdent(t)) {
        parts.push(t.text.replace(/"/g, ""));
        expectPart = false;
        j++;
        continue;
      }
      if (!expectPart && t.text === ".") {
        expectPart = true;
        j++;
        continue;
      }
      break;
    }
    if (parts.length === 0 || expectPart) return null;
    return { ref: parts.join("."), next: j };
  };

  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const w = t.kind === "word" ? t.text.toLowerCase() : "";
    if (w === "from" || w === "join") {
      i++;
      let expectRef = w === "from" || w === "join";
      while (i < tokens.length) {
        const tk = tokens[i]!;
        if (expectRef && tk.text === "(") {
          i = skipParens(i); // subquery / table function parenthesized args
          expectRef = false;
          continue;
        }
        if (expectRef && isIdent(tk)) {
          const r = readDottedRef(i);
          if (!r) break;
          refs.push(r.ref.toLowerCase());
          i = r.next;
          expectRef = false;
          continue;
        }
        if (!expectRef && tk.text === ",") {
          i++;
          expectRef = true;
          continue;
        }
        if (tk.kind === "word") {
          const kw = tk.text.toLowerCase();
          if (kw === "using") {
            i++;
            if (tokens[i]?.text === "(") i = skipParens(i);
            continue;
          }
          if (kw === "join") expectRef = true;
          i++;
          continue;
        }
        break;
      }
      continue;
    }
    i++;
  }
  return { refs, cteNames };
}

export function guardSql(raw: string, opts: { allowedViews: string[]; rowCap: number }): GuardResult | GuardRejection {
  const sql = stripComments(raw).trim().replace(/;+\s*$/, "").trim();
  if (!sql) return { ok: false, reason: "SQL 为空。" };

  const statements = splitStatements(sql).map((s) => s.trim()).filter(Boolean);
  if (statements.length > 1) {
    return { ok: false, reason: "只允许单条 SELECT 语句。" };
  }
  const single = statements[0]!;

  if (!/^(select|with)\b/i.test(single)) {
    return { ok: false, reason: "只允许 SELECT 或 WITH 开头的查询语句。" };
  }

  for (const kw of STATEMENT_KEYWORDS) {
    if (containsWord(single, kw)) {
      return { ok: false, reason: `只读查询不允许使用 ${kw.toUpperCase()}。` };
    }
  }

  const fns = calledFunctions(single);
  for (const fn of fns) {
    if (FILE_TABLE_FUNCTIONS.has(fn)) {
      return { ok: false, reason: `只读查询不允许调用 ${fn}(…)：请查询已注册的数据集视图。` };
    }
  }

  const allowed = new Set(opts.allowedViews.map((v) => v.toLowerCase()));
  const { refs, cteNames } = extractTableRefs(single);
  for (const ref of refs) {
    if (cteNames.has(ref)) continue;
    if (allowed.has(ref)) continue;
    // allow unqualified access when the view is unambiguous, and qualified
    // access when it ends with a registered view name
    const qualified = [...allowed].some((v) => v.endsWith("." + ref) || ref.endsWith("." + v));
    if (!qualified) {
      return {
        ok: false,
        reason: `查询引用了未授权的数据对象 \`${ref}\`。只允许查询已授权的数据集：${[...allowed].join(", ")}。`,
      };
    }
  }

  const wrapped = `SELECT * FROM (\n${single}\n) AS __guarded LIMIT ${opts.rowCap + 1}`;
  return { ok: true, sql: wrapped };
}
