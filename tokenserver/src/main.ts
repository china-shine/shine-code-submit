// tokenserver 入口:启动 HTTP 服务,监听 36667。
import { startServer } from "./server";
import { readAuthConfig } from "./store";

const { reportSecret, viewToken } = readAuthConfig();
if (!reportSecret || !viewToken) {
  console.warn(
    `[tokenserver] auth: reportSecret ${reportSecret ? "on" : "OFF(上报不验签)"}, viewToken ${viewToken ? "on" : "OFF(读接口开放)"} —— 公网部署请在 config.json 或 env 配置两者`,
  );
}

const server = startServer();
console.log(`[tokenserver] listening http://${server.hostname}:${server.port}`);
