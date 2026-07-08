import { AppProvider, useApp } from "../state/AppContext";
import { Header } from "./Header";
import { SideNav } from "./SideNav";
import { SessionsModule } from "./SessionsModule";
import { EventsModule } from "./EventsModule";
import { CommitsModule } from "./CommitsModule";
import { OverviewModule } from "./OverviewModule";
import { StatsModule } from "./StatsModule";
import { ReportModule } from "./ReportModule";
import { SettingsModule } from "./SettingsModule";
import { SystemModule } from "./SystemModule";

/** 模块路由：按 activeModule 渲染对应模块。 */
function ModuleRouter() {
  const { activeModule } = useApp();
  switch (activeModule) {
    case "overview":
      return <OverviewModule />;
    case "sessions":
      return <SessionsModule />;
    // case "events":
    //   return <EventsModule />;        // 暂时屏蔽
    // case "commits":
    //   return <CommitsModule />;       // 暂时屏蔽
    // case "stats":
    //   return <StatsModule />;        // 暂时屏蔽
    case "report":
      return <ReportModule />;
    case "settings":
      return <SettingsModule />;
    case "system":
      return <SystemModule />;
    default:
      return <OverviewModule />;
  }
}

function Layout() {
  const { navCollapsed } = useApp();
  return (
    <>
      <Header />
      <div className="body-middle">
        <aside id="nav-panel" className={`panel${navCollapsed ? " collapsed" : ""}`}>
          <SideNav />
        </aside>
        <section id="events-panel" className="panel">
          <ModuleRouter />
        </section>
      </div>
    </>
  );
}

export function App({ token }: { token: string }) {
  return (
    <AppProvider token={token}>
      <Layout />
    </AppProvider>
  );
}
