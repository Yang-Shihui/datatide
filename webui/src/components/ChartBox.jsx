import { useEffect, useRef } from "react";
import * as echarts from "echarts";

const PALETTE = ["#58a6ff", "#39d2c0", "#bc8cff", "#3fb950", "#f0883e", "#f85149"];

const DARK_BASE = {
  backgroundColor: "transparent",
  color: PALETTE,
  textStyle: { color: "#8b949e" },
  grid: { left: 70, right: 30, top: 64, bottom: 40 },
  // title left / legend right: the agent-generated specs put long titles and
  // markArea notes in the top band — pin them apart to avoid overlap
  title: { left: 8, top: 4, textStyle: { color: "#e6edf3", fontSize: 13 } },
  legend: { top: 4, right: 8, textStyle: { color: "#8b949e" } },
  tooltip: { trigger: "axis" },
};

export function ChartBox({ spec, title }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!ref.current || !spec) return;
    const chart = echarts.init(ref.current);
    const option = {
      ...DARK_BASE,
      ...spec,
      // keep our layout pins after the spec spread so agent specs can't undo them
      title: { ...DARK_BASE.title, ...(spec.title || { text: title }) },
      legend: { ...DARK_BASE.legend, ...(spec.legend || {}) },
      tooltip: spec.tooltip || { trigger: "axis" },
    };
    // agent specs love giant markPoint balloons and edge-clipped mark labels —
    // normalize the risky decorations after the spec spread
    for (const ser of option.series ?? []) {
      if (ser.markPoint) {
        ser.markPoint.symbolSize = Math.min(Number(ser.markPoint.symbolSize) || 60, 44);
        ser.markPoint.label = {
          ...(ser.markPoint.label || {}),
          position: "top",
          distance: 10,
          fontSize: 11,
          color: "#e6edf3",
        };
      }
      if (ser.markLine) {
        // default label position "end" gets clipped by the plot edge; solid
        // bars can sit under any inside position, so add an opaque backdrop
        const lineLabel = {
          ...(typeof ser.markLine.label === "object" ? ser.markLine.label : {}),
          position: "insideEndTop",
          fontSize: 11,
          color: "#e6edf3",
          backgroundColor: "rgba(22,27,34,0.88)",
          padding: [2, 6],
          borderRadius: 3,
        };
        ser.markLine.label = lineLabel;
        for (const item of Array.isArray(ser.markLine.data) ? ser.markLine.data : []) {
          if (item && typeof item === "object" && item.label) {
            item.label = {
              ...item.label,
              position: item.label.position || "insideEndTop",
              fontSize: 11,
              backgroundColor: "rgba(22,27,34,0.88)",
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
          color: "#e6edf3",
          backgroundColor: "rgba(22,27,34,0.88)",
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
    };
  }, [spec, title]);

  return <div ref={ref} className="chart-box" />;
}
