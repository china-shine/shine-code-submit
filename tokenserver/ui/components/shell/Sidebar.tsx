// 侧栏:品牌头 + 两项导航(数据总览/成员分析) + 底部 dark toggle。
// 从 TokenWeb App.tsx 搬运(683-722),品牌名 "AI效能平台"。
import { LayoutDashboard, Users, Zap, Sun, Moon } from "lucide-react";

const NAV_ITEMS = [
  { id: "overview", label: "数据总览", icon: LayoutDashboard },
  { id: "member", label: "成员分析", icon: Users },
] as const;

export type PageId = (typeof NAV_ITEMS)[number]["id"];

export function Sidebar({
  page,
  dark,
  onNav,
  onToggleDark,
}: {
  page: PageId;
  dark: boolean;
  onNav: (p: PageId) => void;
  onToggleDark: () => void;
}) {
  return (
    <aside className="w-52 flex-shrink-0 bg-sidebar flex flex-col h-screen sticky top-0">
      <div className="px-4 pt-5 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-sm bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center flex-shrink-0">
            <Zap className="w-4 h-4 text-white" />
          </div>
          <div className="text-sm font-bold text-white tracking-tight">AI效能平台</div>
        </div>
      </div>

      <nav className="flex-1 px-2 space-y-0.5">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const isActive = page === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onNav(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-sm text-sm font-medium transition-colors ${
                isActive
                  ? "bg-sidebar-accent text-sidebar-primary"
                  : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
              }`}
            >
              <Icon className="w-4 h-4 flex-shrink-0" />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="px-3 py-3 border-t border-sidebar-border flex justify-end">
        <button
          onClick={onToggleDark}
          className="w-7 h-7 rounded-sm bg-sidebar-accent flex items-center justify-center hover:bg-sidebar-accent/80 transition-colors"
        >
          {dark ? <Sun className="w-3.5 h-3.5 text-sidebar-primary" /> : <Moon className="w-3.5 h-3.5 text-sidebar-primary" />}
        </button>
      </div>
    </aside>
  );
}
