import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeTheme } from "./utils/theme";
import "./styles.css";
// 基础样式负责布局兼容，产品层只做视觉令牌与交互状态覆盖；顺序不可交换。
import "./product-polish.css";

// 必须在 React 首次绘制前应用主题，防止已选择黑暗主题时出现白屏闪烁。
initializeTheme();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
