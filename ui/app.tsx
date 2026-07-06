// Shine Code Submit 查看页（React 入口）。token 从 URL ?t= 取、存 sessionStorage 后清掉 URL；
// 随后 createRoot 挂载 <App/>（AppProvider 在 App 内部包裹全局状态）。
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./components/App";

const TOKEN_KEY = "shine_code_submit_token";

function getToken(): string | null {
  const fromUrl = new URLSearchParams(location.search).get("t");
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    history.replaceState(null, "", location.pathname);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY);
}

const token = getToken();
const root = document.getElementById("root")!;
if (!token) {
  root.innerHTML =
    '<div style="padding:2rem;font-family:sans-serif;color:#ccc;background:#0f1115;min-height:100vh">' +
    "缺少 token。请通过 <code>shine-code-submit ui</code> 命令打开。</div>";
} else {
  createRoot(root).render(
    <StrictMode>
      <App token={token} />
    </StrictMode>,
  );
}
