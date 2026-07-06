import { useApp } from "../state/AppContext";

/** 系统模块：daemon 运行信息（来自 /api/stats）。 */
export function SystemModule() {
  const { stats } = useApp();
  if (!stats) {
    return (
      <div className="empty-state">
        <span className="es-hint">连接中…</span>
      </div>
    );
  }
  const up = Math.floor(stats.uptime / 1000);
  return (
    <div className="system-view">
      <section className="sum-section">
        <div className="sum-head">
          <h3>Daemon</h3>
        </div>
        <div className="sys-grid">
          <div className="sys-row"><span>服务</span><b>{stats.service}</b></div>
          <div className="sys-row"><span>版本</span><b>v{stats.version}</b></div>
          <div className="sys-row"><span>pid</span><b>{stats.pid}</b></div>
          <div className="sys-row"><span>uptime</span><b>{up}s</b></div>
          <div className="sys-row"><span>事件总数</span><b>{stats.totalEvents}</b></div>
          <div className="sys-row"><span>事件速率</span><b>{stats.eventsPerSec.toFixed(1)} evt/s</b></div>
          <div className="sys-row"><span>spool 积压</span><b>{stats.spoolBacklog}</b></div>
          {stats.lastError && (
            <div className="sys-row err">
              <span>最近错误</span>
              <b>{stats.lastError.message}</b>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
