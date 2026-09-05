import { useEffect, useState } from "react";
import { api } from "../api.js";
import { Select } from "../components/Select.jsx";
import { mdToHtml } from "../md.js";

export function Reports({ user, notify, wrap }) {
  const [reports, setReports] = useState([]);
  const [runs, setRuns] = useState(null); // runs of selected report
  const [content, setContent] = useState(null); // {runId, html}
  const [form, setForm] = useState({ dataset: "", title: "", prompt: "", cron: "0 9 * * 1" });

  const reload = () => api.get("/api/reports").then(setReports).catch((e) => notify(e.message, true));
  useEffect(() => {
    reload();
  }, []);

  const create = wrap(async () => {
    await api.post("/api/reports", form);
    notify("报告已创建并加入调度");
    setForm({ ...form, title: "", prompt: "" });
    reload();
  });

  const runNow = wrap(async (id) => {
    notify("报告生成中…");
    await api.post(`/api/reports/${id}/run`, {});
    notify("报告已生成");
    showRuns(id);
    reload();
  });

  const showRuns = wrap(async (id) => {
    const list = await api.get(`/api/reports/${id}/runs`);
    setRuns({ id, list });
    setContent(null);
  });

  const showContent = wrap(async (runId) => {
    const res = await fetch(`/api/report-runs/${runId}/content`, {
      headers: { Authorization: `Bearer ${localStorage.getItem("datatide-token")}` },
    });
    const text = await res.text();
    setContent({ runId, html: mdToHtml(text) });
  });

  return (
    <div className="page">
      <div className="page-inner">
        <h2>定时归因报告</h2>
        <div className="panel ds-form">
          <div className="form-row">
            <div className="field">
              <label>数据集</label>
              <Select
                value={form.dataset}
                onChange={(dataset) => setForm({ ...form, dataset })}
                options={user.datasets.map((d) => ({ value: d, label: d }))}
                placeholder="选择…"
                ariaLabel="报告数据集"
              />
            </div>
            <div className="field">
              <label>报告主题</label>
              <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="每周销售异动归因" />
            </div>
            <div className="field">
              <label>cron 表达式</label>
              <input className="mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} style={{ width: 130 }} />
            </div>
            <button className="primary" onClick={create} disabled={!form.dataset || !form.title || !form.prompt}>
              创建
            </button>
          </div>
          <label>分析要求（会原样交给分析助手）</label>
          <textarea rows={2} value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} placeholder="对比上周与本周各区域销售额，定位异动的主要品类与渠道" />
        </div>

        {reports.length === 0 && <div className="muted">还没有报告配置。</div>}
        {reports.map((r) => (
          <div key={r.id} className="panel rep-card">
            <div className="meta">
              <div className="title">{r.title}</div>
              <div className="muted mono" style={{ fontSize: 12 }}>
                {r.dataset_name} · cron: {r.cron} · 上次运行: {r.last_run_at ?? "从未"}
              </div>
            </div>
            <button className="ghost" onClick={() => showRuns(r.id)}>
              运行历史
            </button>
            <button className="primary" onClick={() => runNow(r.id)}>
              立即生成
            </button>
          </div>
        ))}

        {runs && (
          <div className="panel" style={{ marginTop: 16, padding: 16 }}>
            <h3 style={{ margin: "0 0 10px", fontSize: 14 }}>运行历史</h3>
            {runs.list.length === 0 && <div className="muted">暂无运行记录。</div>}
            {runs.list.map((run) => (
              <div key={run.id} style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 0", borderBottom: "1px solid var(--border)" }}>
                <span className={`badge ${run.status === "success" ? "ok" : run.status === "error" ? "err" : "run"}`}>{run.status}</span>
                <span className="mono muted" style={{ fontSize: 13 }}>
                  {run.started_at}
                </span>
                {run.status === "success" && (
                  <button className="ghost" onClick={() => showContent(run.id)}>
                    查看报告
                  </button>
                )}
                {run.error && <span className="error-text" style={{ fontSize: 13 }}>{run.error}</span>}
              </div>
            ))}
            {content && <div className="panel md-view" style={{ marginTop: 14 }} dangerouslySetInnerHTML={{ __html: content.html }} />}
          </div>
        )}
      </div>
    </div>
  );
}
