import { createRoot } from "react-dom/client";
import { ChartBox } from "../src/components/ChartBox.jsx";
import spec from "./spec.json";
import "../src/style.css";

createRoot(document.getElementById("root")).render(
  <div style={{ padding: 20, background: "#0d1117", minHeight: "100vh" }}>
    <div style={{ maxWidth: 860, margin: "0 auto" }}>
      <ChartBox spec={spec} title={spec.title?.text || "图表"} />
    </div>
  </div>,
);
