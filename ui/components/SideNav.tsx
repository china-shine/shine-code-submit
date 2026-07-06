import { useApp } from "../state/AppContext";
import { Icon, type IconName } from "./Icon";
import type { ModuleId } from "../types";

/** 左侧模块导航：6 个一级模块，active 项左侧蓝条；底部折叠按钮收成图标条。 */
const ITEMS: Array<{ id: ModuleId; label: string; icon: IconName }> = [
  { id: "overview", label: "概览", icon: "home" },
  { id: "sessions", label: "会话", icon: "sessions" },
  { id: "events", label: "事件", icon: "activity" },
  { id: "commits", label: "提交", icon: "git" },
  { id: "stats", label: "统计", icon: "chart" },
  { id: "system", label: "系统", icon: "server" },
];

export function SideNav() {
  const { activeModule, selectModule, navCollapsed, setNavCollapsed } = useApp();
  return (
    <nav className={`side-nav${navCollapsed ? " collapsed" : ""}`}>
      <ul className="nav-list">
        {ITEMS.map((it) => (
          <li key={it.id}>
            <button
              type="button"
              className={`nav-item${activeModule === it.id ? " active" : ""}`}
              title={it.label}
              aria-label={it.label}
              onClick={() => selectModule(it.id)}
            >
              <Icon name={it.icon} size={18} />
              <span className="nav-label">{it.label}</span>
            </button>
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="nav-collapse"
        title={navCollapsed ? "展开导航" : "收起导航"}
        aria-label={navCollapsed ? "展开导航" : "收起导航"}
        onClick={() => setNavCollapsed(!navCollapsed)}
      >
        <Icon name="chevron" size={16} />
      </button>
    </nav>
  );
}
