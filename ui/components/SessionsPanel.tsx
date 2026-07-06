import { useApp } from "../state/AppContext";
import { SessionTree } from "./SessionTree";

/** 会话模块列表：header + SessionTree（点击进详情）。 */
export function SessionsPanel() {
  const { selectedSessionId, setSelectedSessionId } = useApp();
  return (
    <>
      <div className="panel-header">
        <h2>Sessions</h2>
      </div>
      <SessionTree selectedId={selectedSessionId} onSelect={setSelectedSessionId} />
    </>
  );
}
