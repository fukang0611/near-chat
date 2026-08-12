import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
// 基础样式负责布局兼容，产品层只做视觉令牌与交互状态覆盖；顺序不可交换。
import "./product-polish.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
