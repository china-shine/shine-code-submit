// 全局状态聚合：只保留跨模块共享的导航态 + 全局轮询数据。
// 各视图数据（events/messages/commits）下沉到模块组件自管 hook，互不覆盖。
import {
  createContext,
  useCallback,
  useContext,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useApi } from "../hooks/useApi";
import { useStatsPolling } from "../hooks/useStatsPolling";
import type { ModuleId, SessionSummary, StatsResponse } from "../types";

export interface AppContextValue {
  token: string;
  // 全局轮询
  stats: StatsResponse | null;
  sessions: SessionSummary[];
  // 导航
  selectedSessionId: string | null;       // 仅「会话」模块详情用
  activeModule: ModuleId;
  navCollapsed: boolean;
  // setters
  setSelectedSessionId: Dispatch<SetStateAction<string | null>>;
  selectModule: (m: ModuleId) => void;
  setNavCollapsed: Dispatch<SetStateAction<boolean>>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ token, children }: { token: string; children: ReactNode }) {
  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [activeModule, setActiveModule] = useState<ModuleId>("overview");
  const [navCollapsed, setNavCollapsed] = useState(false);

  const api = useApi(token);
  useStatsPolling(api, setStats, setSessions);

  const selectModule = useCallback((m: ModuleId) => {
    setActiveModule(m);
  }, []);

  const value: AppContextValue = {
    token,
    stats,
    sessions,
    selectedSessionId,
    activeModule,
    navCollapsed,
    setSelectedSessionId,
    selectModule,
    setNavCollapsed,
  };
  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within <AppProvider>");
  return ctx;
}
