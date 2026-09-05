import { MetaStore } from "../src/store/meta.ts";
import { Engine } from "../src/engine/engine.ts";
import { resolve } from "node:path";

// Register the demo dataset into data/meta.db (idempotent for the demo name).
const meta = new MetaStore("data/meta.db");
if (!meta.getDataset("sales_demo")) {
  meta.createDataset(
    "sales_demo",
    "file",
    { path: resolve("data/datasets/sales_demo.csv"), format: "csv" },
    "2025-01 至 2026-08 的模拟销售流水：区域/品类/渠道维度，含订单数、销量与金额。",
  );
  console.log("registered dataset: sales_demo");
} else {
  console.log("dataset sales_demo already registered");
}
meta.close();
void Engine;
