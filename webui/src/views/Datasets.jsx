import { useEffect, useState } from "react";
import { api } from "../api.js";

export function Datasets({ user, notify, wrap, refreshMe }) {
  const [datasets, setDatasets] = useState([]);
  const [schema, setSchema] = useState(null);
  const [form, setForm] = useState({ name: "", kind: "file", format: "csv", description: "", dsn: "", file: null });

  const reload = () => api.get("/api/datasets").then(setDatasets).catch((e) => notify(e.message, true));
  useEffect(() => {
    reload();
  }, []);

  const upload = wrap(async () => {
    if (!form.name.trim()) throw new Error("请填写数据集名");
    const body = { name: form.name.trim(), kind: form.kind, description: form.description };
    if (form.kind === "file") {
      if (!form.file) throw new Error("请选择 CSV/Parquet 文件");
      const buf = await form.file.arrayBuffer();
      body.format = form.format;
      body.content_base64 = arrayBufferToBase64(buf);
    } else {
      body.dsn = form.dsn;
    }
    await api.post("/api/datasets", body);
    notify("数据集已注册");
    setForm({ name: "", kind: "file", format: "csv", description: "", dsn: "", file: null });
    reload();
  });

  const showSchema = wrap(async (name) => {
    setSchema({ name, loading: true });
    const s = await api.get(`/api/datasets/${name}/schema`);
    setSchema({ name, ...s });
  });

  const remove = wrap(async (name) => {
    if (!confirm(`确认删除数据集 ${name}？`)) return;
    await api.delete(`/api/datasets/${name}`);
    if (schema?.name === name) setSchema(null);
    reload();
    refreshMe();
  });

  const isAdmin = user.role === "admin";

  return (
    <div className="page">
      <div className="page-inner">
        <h2>数据集</h2>
        {isAdmin && (
          <div className="panel ds-form">
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
              <div>
                <label>数据集名（小写下划线）</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="sales_demo" />
              </div>
              <div>
                <label>类型</label>
                <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  <option value="file">CSV / Parquet 文件</option>
                  <option value="postgres">Postgres 连接</option>
                </select>
              </div>
              {form.kind === "file" && (
                <>
                  <div>
                    <label>格式</label>
                    <select value={form.format} onChange={(e) => setForm({ ...form, format: e.target.value })}>
                      <option value="csv">CSV</option>
                      <option value="parquet">Parquet</option>
                    </select>
                  </div>
                  <div>
                    <label>文件（≤64MB）</label>
                    <label className={`file-button${form.file ? " has-file" : ""}`}>
                      {form.file ? form.file.name : "选择 CSV / Parquet 文件"}
                      <input
                        type="file"
                        accept=".csv,.parquet"
                        onChange={(e) => setForm({ ...form, file: e.target.files[0] })}
                      />
                    </label>
                  </div>
                </>
              )}
              {form.kind === "postgres" && (
                <div style={{ flex: 1, minWidth: 280 }}>
                  <label>连接串（host=… dbname=… user=… password=…）</label>
                  <input className="mono" value={form.dsn} onChange={(e) => setForm({ ...form, dsn: e.target.value })} />
                </div>
              )}
              <button className="primary" onClick={upload}>
                注册数据集
              </button>
            </div>
            <label>描述（会注入分析助手的上下文）</label>
            <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </div>
        )}

        <div className="ds-grid">
          {datasets.map((d) => (
            <div key={d.name} className="panel ds-card">
              <h3>
                {d.name}
                <span className="kind">{d.kind}</span>
              </h3>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 10 }}>
                {d.description || "（无描述）"} · {d.authorized ? "已授权" : "未授权"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="ghost" disabled={!d.authorized} onClick={() => showSchema(d.name)}>
                  查看 schema
                </button>
                {isAdmin && (
                  <button className="ghost danger" onClick={() => remove(d.name)}>
                    删除
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>

        {schema && (
          <div className="panel" style={{ marginTop: 18, padding: 18, position: "relative" }}>
            <button className="ghost" style={{ position: "absolute", right: 14, top: 14 }} onClick={() => setSchema(null)}>
              关闭
            </button>
            <h3 style={{ fontFamily: "var(--mono)", color: "var(--accent)", margin: 0 }}>{schema.name}</h3>
            {schema.loading ? (
              <div className="muted">加载中…</div>
            ) : (
              <>
                <div className="muted" style={{ fontSize: 12.5, margin: "4px 0" }}>
                  {schema.schema.rowCount} 行 · {schema.schema.columns.length} 字段
                </div>
                <table className="schema-table">
                  <thead>
                    <tr>
                      <th>字段</th>
                      <th>类型</th>
                      <th>取值示例</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schema.schema.columns.map((c) => (
                      <tr key={c.name}>
                        <td>{c.name}</td>
                        <td>{c.type}</td>
                        <td>{c.sampleValues?.join("、") || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
