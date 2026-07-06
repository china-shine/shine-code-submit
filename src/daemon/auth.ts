// token 鉴权。token 为 Daemon 启动时生成的随机串，写 pid 文件，Hook/查看页带上。
import type { PidFile } from "../shared/types";

export function checkToken(authHeader: string | null, pid: PidFile): boolean {
  if (!authHeader) return false;
  return authHeader === `Bearer ${pid.token}`;
}
