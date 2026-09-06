import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deterministic demo dataset: monthly sales rows for 2025-01..2026-08 with a
 * planted attribution story — 华东 got a promo pulse in 2025-07/08 that did
 * not repeat in 2026, so 2026-07/08 shows a sharp YoY drop.
 */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(20260905);
const REGIONS = ["华东", "华北", "华南", "西南"] as const;
const CATEGORIES = ["食品", "日化", "数码"] as const;
const CHANNELS = ["线上", "线下"] as const;

const rows: string[] = ["order_id,order_date,region,category,channel,units,amount"];
let orderId = 10000;

for (const ym of months("2025-01-01", "2026-08-01")) {
  const [y, m] = ym.split("-").map(Number);
  const seasonal = 1 + 0.12 * Math.sin(((m - 1) / 12) * 2 * Math.PI);
  const yearlyGrowth = y === 2026 ? 1.08 : 1.0;
  for (const region of REGIONS) {
    for (const category of CATEGORIES) {
      for (const channel of CHANNELS) {
        // 2025-07/08 华东大促：线上脉冲，2026 年没有
        const isPromo = region === "华东" && channel === "线上" && y === 2025 && (m === 7 || m === 8);
        const promoBoost = isPromo ? 2.6 : 1.0;
        const base =
          (region === "华东" ? 900 : region === "华北" ? 700 : region === "华南" ? 550 : 380) *
          (category === "数码" ? 1.6 : category === "食品" ? 1.0 : 0.8) *
          (channel === "线上" ? 1.3 : 1.0);
        const expected = base * seasonal * yearlyGrowth * promoBoost;
        const n = Math.max(2, Math.round(expected / 40));
        for (let k = 0; k < n; k++) {
          const units = 1 + Math.floor(rand() * 5) + (isPromo && rand() < 0.3 ? 3 : 0);
          const unitPrice = category === "数码" ? 800 + rand() * 900 : category === "食品" ? 25 + rand() * 40 : 15 + rand() * 30;
          const day = 1 + Math.floor(rand() * 28);
          rows.push(
            [
              orderId++,
              `${ym}-${String(day).padStart(2, "0")}`,
              region,
              category,
              channel,
              units,
              (units * unitPrice).toFixed(2),
            ].join(","),
          );
        }
      }
    }
  }
}

mkdirSync("data/datasets", { recursive: true });
writeFileSync(join("data/datasets", "sales_demo.csv"), rows.join("\n") + "\n");
console.log(`wrote data/datasets/sales_demo.csv (${rows.length - 1} rows)`);

// 第二个数据集：区域×月份 销售目标（供跨数据集关联分析演示：达成率 = 销售/目标）
// 目标 ≈ 常态月销的 1.05 倍（不含 2025 大促脉冲），使"达标/未达标"有真实波动
const targetRows: string[] = ["region,month,target_amount"];
for (const ym of months("2025-01-01", "2026-08-01")) {
  const [y, m] = ym.split("-").map(Number);
  const seasonal = 1 + 0.12 * Math.sin(((m - 1) / 12) * 2 * Math.PI);
  const yoyTarget = y === 2026 ? 1.1 : 1.0; // 2026 年目标定在常态的 +10%
  for (const region of REGIONS) {
    const base = region === "华东" ? 330000 : region === "华北" ? 310000 : region === "华南" ? 300000 : 300000;
    const target = Math.round(base * seasonal * yoyTarget * (1 + (rand() - 0.5) * 0.04));
    targetRows.push([region, ym, target].join(","));
  }
}
writeFileSync(join("data/datasets", "region_targets.csv"), targetRows.join("\n") + "\n");
console.log(`wrote data/datasets/region_targets.csv (${targetRows.length - 1} rows)`);

function months(startISO: string, endISO: string): string[] {
  const out: string[] = [];
  const cur = new Date(startISO);
  const end = new Date(endISO);
  while (cur <= end) {
    out.push(`${cur.getUTCFullYear()}-${String(cur.getUTCMonth() + 1).padStart(2, "0")}`);
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}
