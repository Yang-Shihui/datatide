import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Select } from "../components/Select.jsx";

export function Datasets({ user, notify, wrap, refreshMe }) {
  const [datasets, setDatasets] = useState([]);
  const [schema, setSchema] = useState(null);
  const [schemaTab, setSchemaTab] = useState("fields"); // fields | preview
  const [preview, setPreview] = useState(null);
  const [accessModal, setAccessModal] = useState(null); // { name, users }
  const [confirmDel, setConfirmDel] = useState(null);
  const [form, setForm] = useState({ name: "", kind: "file", format: "csv", description: "", dsn: "", file: null });

  const reload = () => api.get("/api/datasets").then(setDatasets).catch((e) => notify(e.message, true));
  useEffect(() => {
    reload();
  }, []);

  const upload = wrap(async () => {
    if (!form.name.trim()) throw new Error("请填写数据集名");
    const body = { name: form.name.trim(), kind: form.kind, description: form.description };
    if (form.kind === "file") {
      if (!form.file) throw new Error("请选择 CSV/Parquet/Excel 文件");
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
    setSchemaTab("fields");
    setPreview(null);
    try {
      const s = await api.get(`/api/datasets/${name}/schema`);
      setSchema({ name, ...s });
    } catch (err) {
      setSchema(null);
      throw err;
    }
  });

  const showPreview = wrap(async (name) => {
    setSchemaTab("preview");
    if (preview?.name === name) return;
    setPreview({ name, loading: true });
    const p = await api.get(`/api/datasets/${name}/preview?rows=50`);
    setPreview({ name, ...p });
  });

  const openAccess = wrap(async (name) => {
    const a = await api.get(`/api/datasets/${name}/access`);
    setAccessModal({ name, users: a.users });
  });

  const toggleAccess = wrap(async (username, grant) => {
    await api.put(`/api/datasets/${accessModal.name}/access`, { username, grant });
    const a = await api.get(`/api/datasets/${accessModal.name}/access`);
    setAccessModal({ ...accessModal, users: a.users });
    notify(grant ? `已授权 ${username}` : `已撤销 ${username}`);
    refreshMe();
  });

  const remove = wrap(async (name) => {
    await api.delete(`/api/datasets/${name}`);
    setConfirmDel(null);
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
            <div className="form-row">
              <div>
                <label>数据集名（小写下划线）</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="sales_demo" />
              </div>
              <div className="field">
                <label>类型</label>
                <Select
                  value={form.kind}
                  onChange={(kind) => setForm({ ...form, kind })}
                  options={[
                    { value: "file", label: "CSV / Parquet / Excel 文件" },
                    { value: "postgres", label: "Postgres 连接" },
                  ]}
                  ariaLabel="数据集类型"
                />
              </div>
              {form.kind === "file" && (
                <>
                  <div className="field">
                    <label>格式</label>
                    <Select
                      value={form.format}
                      onChange={(format) => setForm({ ...form, format })}
                      options={[
                        { value: "csv", label: "CSV" },
                        { value: "parquet", label: "Parquet" },
                        { value: "xlsx", label: "Excel (.xlsx)" },
                      ]}
                      ariaLabel="文件格式"
                    />
                  </div>
                  <div className="field">
                    <div className="field-label">文件（≤64MB）</div>
                    <label className={`file-button${form.file ? " has-file" : ""}`}>
                      {form.file ? form.file.name : "选择 CSV / Parquet / Excel 文件"}
                      <input
                        type="file"
                        accept=".csv,.parquet,.xlsx"
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
              <button className="primary" style={{ height: 40, padding: "0 20px" }} onClick={upload}>
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
                <span className="kind">{d.kind === "file" ? "文件" : "PostgreSQL 数据库"}</span>
              </h3>
              <div className="muted" style={{ fontSize: 13.5, marginBottom: 10 }}>
                {d.description || "（无描述）"} · {d.authorized ? "可访问" : "无访问权限"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="ghost" disabled={!d.authorized} onClick={() => showSchema(d.name)}>
                  查看结构与预览
                </button>
                {isAdmin && (
                  <button className="ghost" onClick={() => openAccess(d.name)}>
                    授权
                  </button>
                )}
                {isAdmin && (
                  <button className="ghost danger" onClick={() => setConfirmDel(d.name)}>
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
                <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
                  <button className={`ghost${schemaTab === "fields" ? " active-tab" : ""}`} onClick={() => setSchemaTab("fields")}>
                    字段
                  </button>
                  <button className={`ghost${schemaTab === "preview" ? " active-tab" : ""}`} onClick={() => showPreview(schema.name)}>
                    数据预览（首张表前 50 行）
                  </button>
                </div>
                {schemaTab === "fields" && (
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
                )}
                {schemaTab === "preview" && (
                  preview?.loading || preview?.name !== schema.name ? (
                    <div className="skeleton" style={{ height: 120, marginTop: 8 }} />
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="schema-table">
                        <thead>
                          <tr>{preview.rows[0] && Object.keys(preview.rows[0]).map((k) => <th key={k}>{k}</th>)}</tr>
                        </thead>
                        <tbody>
                          {preview.rows.map((r, i) => (
                            <tr key={i}>{Object.values(r).map((v, j) => <td key={j}>{String(v ?? "")}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                      {preview.truncated && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>仅显示前 50 行</div>}
                    </div>
                  )
                )}
              </>
            )}
          </div>
        )}
      </div>
      {confirmDel && (
        <div className="modal-overlay" onClick={() => setConfirmDel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>删除数据集</h3>
            <p>
              确认删除 <b className="mono">{confirmDel}</b>？该操作不可恢复（分析数据文件保留在服务器上，仅移除注册）。
            </p>
            <div className="actions">
              <button className="ghost" onClick={() => setConfirmDel(null)}>取消</button>
              <button className="primary" style={{ background: "var(--err)" }} onClick={() => remove(confirmDel)}>
                确认删除
              </button>
            </div>
          </div>
        </div>
      )}

      {accessModal && (
        <div className="modal-overlay" onClick={() => setAccessModal(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>数据集授权</h3>
            <p style={{ marginBottom: 10 }}>
              <b className="mono">{accessModal.name}</b> · admin 天然可见全部数据集
            </p>
            <table className="schema-table" style={{ fontFamily: "var(--sans)" }}>
              <thead>
                <tr><th>用户</th><th>角色</th><th style={{ width: 90 }}>已授权</th></tr>
              </thead>
              <tbody>
                {accessModal.users.map((u) => (
                  <tr key={u.username}>
                    <td>{u.username}</td>
                    <td className="muted">{u.role}</td>
                    <td>
                      <input
                        type="checkbox"
                        checked={u.granted}
                        disabled={u.role === "admin"}
                        onChange={(e) => toggleAccess(u.username, e.target.checked)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="inline-edit-actions">
              <button className="primary" onClick={() => setAccessModal(null)}>完成</button>
            </div>
          </div>
        </div>
      )}
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
