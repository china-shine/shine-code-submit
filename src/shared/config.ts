// 全局常量：端口、超时、扫描间隔、服务标识。
// 集中于此，便于 Hook / Daemon / CLI 三端一致。
import pkg from "../../package.json";
import { networkInterfaces } from "node:os";

export const SERVICE_NAME = "shine-code-submit";
export const SERVICE_VERSION = pkg.version; // 单一来源：package.json，避免三处手动同步漏改

/**
 * daemon 监听地址。默认 0.0.0.0（绑所有网卡，局域网/其他设备可直接访问）。
 * 仅本机回环用时设 SHINE_CODE_SUBMIT_HOST=127.0.0.1。
 * 注意：/api/health 与 /ui 无鉴权，绑非回环后 token 是数据接口唯一防线，勿在不可信网络下暴露。
 */
export const LISTEN_HOST = process.env.SHINE_CODE_SUBMIT_HOST ?? "0.0.0.0";

export const HOST = "127.0.0.1"; // hook/cli/daemonctl 连接 daemon 用，固定回环（daemon 即使绑 0.0.0.0 也含 127.0.0.1）
export const PORT = 36666;
export const BASE_URL = `http://${HOST}:${PORT}`; // 内部访问（hook POST、cli、探活）走 127.0.0.1

/**
 * 第一个非回环、非虚拟网卡的 IPv4（给用户展示真实局域网可访问的链接）。
 * 跳过 vEthernet(Hyper-V/WSL)、VMware、VirtualBox、docker/veth/br- 等虚拟网卡，
 * 取真实网卡（以太网/Wi-Fi）的 IP；都没有则退回第一个非回环 IPv4；再没有则 localhost。
 */
function getPrimaryIpv4(): string {
  const VIRTUAL = ["vethernet", "vmware", "virtualbox", "docker", "veth", "br-", "virbr", "vnet", "utun"];
  const isVirtual = (name: string): boolean => {
    const n = name.toLowerCase();
    return VIRTUAL.some((k) => n.includes(k));
  };
  try {
    const nets = networkInterfaces();
    // 第一轮：跳过回环 + 虚拟网卡，取真实局域网 IP
    for (const name of Object.keys(nets)) {
      if (isVirtual(name)) continue;
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) return net.address;
      }
    }
    // 第二轮：全是虚拟网卡时，退回第一个非回环 IPv4
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) return net.address;
      }
    }
  } catch {
    /* fallthrough to localhost */
  }
  return "localhost";
}

export const PUBLIC_BASE_URL = `http://${getPrimaryIpv4()}:${PORT}`; // 打印给用户/局域网访问的链接（网卡 IP）

// Hook 热转发超时：localhost 上 500ms 足够；超时即放弃热路径，靠 spool 兜底。
export const HOOK_POST_TIMEOUT_MS = 500;

// 故障路径：detached 拉起 Daemon 后轮询 /api/health 的总预算与间隔。
// 源码模式下首次 SessionStart 冷启动 daemon(bun run 首次 transpile TS + 加载 react/sqlite)
// 可能 >5s;预算太短会等不到 ready → readToken 空 → 首次会话不打印 Dashboard 链接(得重启才出)。
// 15s 覆盖冷启动;warm 启动 isOursAlive 立即命中,不会真等满。
export const HEALTH_POLL_TIMEOUT_MS = 15000;
export const HEALTH_POLL_INTERVAL_MS = 100;

// Daemon 回捞 spool 的扫描间隔。
export const SPOOL_SCAN_INTERVAL_MS = 1000;

// 运行指标窗口（用于计算 events/sec）。
export const STATS_WINDOW_MS = 10_000;

// /api/stats 附带的日志尾行数。
export const LOG_TAIL_LINES = 200;

// 日志按大小轮转：超过此阈值（字节）触发轮转（无按天逻辑）。
export const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

// git log 子进程超时（提交视图 /api/commits）；超时返回空 + error，不阻塞查看页。
export const GIT_TIMEOUT_MS = 5000;

// git user.name / remote origin 极少变，按 cwd 缓存避免 buildReport 每项目重复 spawn 子进程（各调 2 次）。
export const GIT_CACHE_TTL_MS = 300_000; // 5 分钟

// /api/sessions enrich tokenTotal 时，最多对最近多少个 session 读 transcript 汇总（控 2s 轮询成本）。
export const SESSION_TOKEN_ENRICH_LIMIT = 50;
