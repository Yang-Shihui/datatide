---
name: sql-dialect-duckdb
description: DuckDB SQL 方言要点与查询性能规范。写复杂 SQL、遇到方言报错、或查询超时时使用。
---

# DuckDB SQL 方言与性能

本平台查询引擎是 DuckDB（Postgres 数据集经 ATTACH 只读访问）。方言要点：

## 常用能力

- 日期：`date_trunc('month', ts)`、`strftime(ts, '%Y-%m')`、`EXTRACT(year FROM ts)`
- 时间差：`date_diff('day', a, b)`、直接 `date1 - date2` 得天数
- 条件聚合：`SUM(CASE WHEN cond THEN 1 ELSE 0 END)` 或 `count_if(cond)`
- 近似去重：大表用 `approx_count_distinct(col)` 代替 count(distinct)
- 取整分组：`floor(amount / 100) * 100` 做分桶
- 中位数/分位：`median(x)`、`quantile_cont(x, 0.9)`
- top-k per group：`row_number() OVER (PARTITION BY g ORDER BY v DESC)`

## Postgres 数据集差异

- 用限定表名 `数据集名.schema.表名`（以 dataset_info 返回为准）
- 语法以 DuckDB 解析为准；个别 Postgres 函数不存在（如 generate_series 用法不同）

## 性能规范

- WHERE 里先过滤时间窗再其他条件
- 避免对大表 `SELECT *`，只取需要的列
- 排序只有需要时才 ORDER BY（守卫层外层 LIMIT 不依赖内层排序）
- 查询超时（>20s）被中断时：缩小时间窗、预先聚合、或加过滤条件后重试
- 字符串模糊匹配用 `LIKE '前缀%'`（可下推），避免 `'%关键词%'` 全扫
