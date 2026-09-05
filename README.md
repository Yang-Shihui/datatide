# datatide

自托管对话式 BI 平台：基于 [Pi coding agent SDK](https://github.com/badlogic/pi-mono) 构建的数据分析 agent，用自然语言问数、归因、出图、定时生成分析报告。**数据与模型调用都发生在你自己的机器/内网，不出第三方。**

![控制台](docs/assets/console-chat.png)

## 它能做什么

- **对话分析**：agent 理解你的问题 → 查 schema → 写 SQL → 多步归因（同比/环比/量价拆解）→ 给出带口径的结论，过程流式可见
- **图表**：分析结论自动配图（柱/线/饼/散点，ECharts 暗色主题）
- **数据源**：CSV / Parquet 文件直接上传，Postgres 只读挂载（经 DuckDB postgres_scanner ATTACH），统一一条 SQL 工具链
- **多用户权限**：数据集级授权，prompt 注入 + 工具层双重强制
- **定时归因报告**：cron 调度 agent 无头生成 markdown 报告（如"每周一自动分析上周销售异动"）
- **只读安全守卫**：agent 生成的 SQL 经守卫层才能执行——仅允许单条 SELECT/WITH、禁 DDL/DML/PRAGMA/ATTACH、禁文件读取表函数、白名单外的数据对象一律拒绝、行数上限 + 超时中断

## 快速开始

前提：Node ≥ 22.19（本地）或 Docker；一个 OpenAI 兼容模型端点。

### 本地运行

```bash
npm install
cd webui && npm ci && npm run build && cd ..   # 构建控制台
npm run gen-data && npx tsx scripts/register-demo.ts   # 演示数据集（含归因故事线）
DATATIDE_MODEL=provider/model-id DATATIDE_ADMIN_PASSWORD=secret npm run server
# 打开 http://127.0.0.1:8200 ，admin / secret 登录
```

模型配置走 Pi SDK 约定：`~/.pi/agent/models.json`（OpenAI 兼容格式，支持 `$ENV_VAR` 注入 key），`DATATIDE_MODEL` 选 `provider/model-id`。也可以用 CLI 直接对话：`DATATIDE_MODEL=... npm run cli`。

### Docker

```bash
cp .env.example .env   # 填 DATATIDE_MODEL 与管理员密码
docker compose up -d --build
```

容器内读取模型配置需挂载 `~/.pi/agent`（compose 文件里有注释行）。

## 架构

```
浏览器 ── SSE ── Express (auth + 会话持久化 + 报告调度)
                    │
                    ▼
            Pi Agent SDK（系统提示词 = 分析师人设 + 用户权限 + 数据集快照）
                    │  工具白名单：dataset_info / query_sql / make_chart
                    ▼
             只读 SQL 守卫（词法级白名单 + 行数上限 + 超时中断）
                    │
                    ▼
        DuckDB（文件视图） ── ATTACH READ_ONLY ──▶ Postgres
```

关键设计：

- **权限双重强制**：数据集授权既注入提示词，也在 query_sql 执行前校验表引用白名单——提示词只是软约束，守卫才是硬约束
- **报错即自纠**：守卫拒绝与 SQL 报错都会带上可操作的原因返回给模型，agent 自行修正（实测多步归因里会主动拆品类/渠道验证）
- **结构化工具而非代码沙箱**：agent 不执行任意代码，只走参数化的 SQL 路径，攻击面大幅缩小

## 安全模型与边界

v0.1 的守卫是词法级的，不是完整 SQL 解析器。已覆盖：多语句、注释/字符串伪装、`EXTRACT(... FROM ...)` 类函数参数、逗号多表引用、子查询/CTE 白名单穿透、文件与外部库表函数黑名单。Postgres 连接以 READ_ONLY ATTACH。已知边界：不支持列级/行级权限；守卫拒绝即中断（模型会自纠重试）。

## 开发

```bash
npm test          # hermetic 测试（守卫/引擎/服务端），不需要真实模型
npm run test:live # live 测试，打真实模型端到端（DATATIDE_LIVE=1 门控）
npm run typecheck
cd webui && npm run dev   # 控制台开发（代理到 :8200）
```

测试策略：hermetic 用例 + CI 矩阵（Node 22/24，含真实 Postgres service）；SQL 守卫有专项逃逸用例（PRAGMA/ATTACH/SELECT INTO/注释伪装/逗号多表/函数参数子查询）。

## License

MIT
