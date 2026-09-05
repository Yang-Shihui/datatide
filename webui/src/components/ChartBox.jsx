import { useEffect, useRef } from "react";
import * as echarts from "echarts";

const PALETTE = ["#1e40af", "#d97706", "#0ea5e9", "#059669", "#7c3aed", "#dc2626"];

const LIGHT_BASE = {
  color: PALETTE,
  textStyle: { color: "#475569" },
  grid: { left: 70, right: 30, top: 88, bottom: 48 },
  // title left / legend right：agent 生成的 spec 常把长标题和标注塞进顶部，
  // 钉死布局避免互相遮挡
  title: {
    left: 8,
    top: 10,
    itemGap: 6,
    textStyle: { color: "#0f172a", fontSize: 14, fontWeight: 600, lineHeight: 20 },
    subtextStyle: { color: "#94a3b8", fontSize: 12, lineHeight: 16 },
  },
  legend: { top: 4, right: 8, textStyle: { color: "#475569" }, itemWidth: 14, itemHeight: 8 },
  tooltip: {
    trigger: "axis",
    backgroundColor: "#ffffff",
    borderColor: "#e2e8f0",
    textStyle: { color: "#0f172a", fontSize: 12 },
    extraCssText: "box-shadow: 0 4px 12px rgba(15,23,42,0.10); border-radius: 8px;",
  },
};

// 折线默认加渐变面积、柱状加圆角，给图表"仪表盘"的体量感
function polishSeries(series) {
  if (series?.type === "line" && !series.areaStyle) {
    const c = series.itemStyle?.color || series.lineStyle?.color || series.color;
    return {
      ...series,
      symbolSize: series.symbolSize ?? 5,
      areaStyle: c
        ? {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: c + "38" },
              { offset: 1, color: c + "05" },
            ]),
          }
        : { opacity: 0.12 },
    };
  }
  if (series?.type === "bar") {
    return { ...series, itemStyle: { ...series.itemStyle, borderRadius: [4, 4, 0, 0] } };
  }
  return series;
}

/** 模型会把 JS 函数 stringify 成字符串传进来，ECharts 会当字面量渲染成 tick 文本 */
function stripJsStringFormatter(obj) {
  if (!obj || typeof obj !== "object") return;
  const label = obj.axisLabel ?? obj;
  if (typeof label.formatter === "string" && !label.formatter.includes("{value}") && /[=>;]|\breturn\b|^\s*value/.test(label.formatter)) {
    delete label.formatter;
  }
  if (typeof obj.tooltip === "object" && obj.tooltip !== null) {
    for (const k of ["formatter", "valueFormatter"]) {
      if (typeof obj.tooltip[k] === "string" && /[=>;]/.test(obj.tooltip[k])) delete obj.tooltip[k];
    }
  }
}

/** 轴的浅色样式兜底（agent spec 只给结构，颜色在这里补） */
function polishAxis(axis) {
  if (!axis || typeof axis !== "object") return axis;
  stripJsStringFormatter(axis);
  const apply = (a) => {
    if (!a || typeof a !== "object") return a;
    const value = a.type === "value";
    if (!value && a.axisLine === undefined) a.axisLine = { lineStyle: { color: "#cbd5e1" } };
    if (a.axisTick === undefined) a.axisTick = { show: false };
    if (a.axisLabel === undefined) a.axisLabel = { color: "#64748b", fontSize: 12 };
    if (value && a.splitLine === undefined) a.splitLine = { lineStyle: { color: "#eef2f7" } };
    if (a.nameTextStyle === undefined) a.nameTextStyle = { color: "#94a3b8", fontSize: 12 };
    return a;
  };
  return Array.isArray(axis) ? axis.map(apply) : apply(axis);
}

export function ChartBox({ spec, title }) {
  const ref = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!ref.current || !spec) return;
    const chart = echarts.init(ref.current);
    chartRef.current = chart;
    const option = {
      ...LIGHT_BASE,
      ...spec,
      // 布局钉点放在 spec 展开之后：agent 的 spec 不能破坏顶带布局
      title: { ...LIGHT_BASE.title, ...(spec.title || { text: title }), top: 10 },
      legend: { ...LIGHT_BASE.legend, ...(spec.legend || {}) },
      tooltip: (() => {
        const t = typeof spec.tooltip === "object" && spec.tooltip !== null ? { ...spec.tooltip } : {};
        for (const k of ["formatter", "valueFormatter"]) {
          if (typeof t[k] === "string" && /[=>;]/.test(t[k])) delete t[k];
        }
        return { ...LIGHT_BASE.tooltip, ...t };
      })(),
      xAxis: polishAxis(spec.xAxis),
      yAxis: polishAxis(spec.yAxis),
      series: Array.isArray(spec.series) ? spec.series.map(polishSeries) : spec.series,
    };
    // agent specs 爱用巨型 markPoint 气球和贴边标注 —— 统一规整（白底深字）
    for (const ser of option.series ?? []) {
      if (ser.markPoint) {
        ser.markPoint.symbolSize = Math.min(Number(ser.markPoint.symbolSize) || 60, 44);
        ser.markPoint.label = {
          ...(ser.markPoint.label || {}),
          position: "top",
          distance: 10,
          fontSize: 12,
          color: "#0f172a",
          backgroundColor: "rgba(255,255,255,0.92)",
          padding: [2, 6],
          borderRadius: 3,
        };
      }
      if (ser.markLine) {
        ser.markLine.label = {
          ...(typeof ser.markLine.label === "object" ? ser.markLine.label : {}),
          position: "insideEndTop",
          fontSize: 11,
          color: "#475569",
          backgroundColor: "rgba(255,255,255,0.92)",
          padding: [2, 6],
          borderRadius: 3,
        };
        for (const item of Array.isArray(ser.markLine.data) ? ser.markLine.data : []) {
          if (item && typeof item === "object" && item.label) {
            item.label = {
              ...item.label,
              position: item.label.position || "insideEndTop",
              fontSize: 11,
              backgroundColor: "rgba(255,255,255,0.92)",
              padding: [2, 6],
              borderRadius: 3,
            };
          }
        }
      }
      if (ser.markArea) {
        ser.markArea.label = {
          ...(typeof ser.markArea.label === "object" ? ser.markArea.label : {}),
          position: "insideTopLeft",
          fontSize: 11,
          color: "#475569",
          backgroundColor: "rgba(255,255,255,0.92)",
          padding: [2, 6],
          borderRadius: 3,
        };
      }
    }
    chart.setOption(option);
    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      chart.dispose();
      chartRef.current = null;
    };
  }, [spec, title]);

  const downloadPng = () => {
    const url = chartRef.current?.getDataURL({ pixelRatio: 2, backgroundColor: "#ffffff" });
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(title || "chart").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.png`;
    a.click();
  };

  return (
    <div className="chart-wrap">
      <div ref={ref} className="chart-box" />
      <button type="button" className="chart-download" onClick={downloadPng}>
        下载 PNG
      </button>
    </div>
  );
}
