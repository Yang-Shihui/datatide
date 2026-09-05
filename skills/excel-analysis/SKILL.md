---
name: excel-analysis
description: 分析用户上传的 Excel (.xlsx) 数据集。涉及 Excel、表格文件、sheet 数据时使用，说明 Excel 数据集的特性与分析注意事项。
---

# Excel 数据集分析

用户可直接上传 .xlsx 文件注册为数据集（取**第一个 sheet**），引擎用 DuckDB 的 read_xlsx 读取。

## 特性与注意

1. **只读第一个 sheet**：多 sheet 文件需要用户把目标 sheet 另存为独立文件再上传。
2. **公式读缓存值**：单元格公式按 Excel 最后计算的缓存值读取，不重算。
3. **类型推断**：列类型由前几行推断——前 N 行是整数后来出现小数时可能被推断成整数导致精度丢失；混合类型列会变成 VARCHAR。发现可疑类型（如金额列是 VARCHAR）用 `CAST(col AS DOUBLE)` 转换后再聚合。
4. **合并单元格**：只有左上格有值，其余为 NULL——分组统计前先考虑 `NULL` 处理（通常应建议用户整理成规范二维表）。
5. **表头**：第一行作为列名；合并表头（多行表头）的文件读出来列名混乱，建议用户规范后再传。
6. **空行空列**：格式化造成的隔行底纹不影响，但完全的空行/空列会产生 NULL 行，聚合前可 `WHERE 主要字段 IS NOT NULL` 过滤。

## 分析建议

- 先 `dataset_info` 看 schema 快照确认列名与类型，再写 SQL
- 日期列若被读成 VARCHAR，用 `TRY_STRPTIME(col, '%Y-%m-%d')::DATE` 或 `CAST(col AS DATE)` 转换
- 对"第几行是总计行"的报表文件，先排除总计行再聚合（`WHERE 品类 NOT LIKE '%合计%'`）
