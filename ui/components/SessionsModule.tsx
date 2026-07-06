import { useEffect } from "react";
import { useApp } from "../state/AppContext";
import { SessionsPanel } from "./SessionsPanel";
import { SessionDetail } from "./SessionDetail";
import { Splitter } from "./Splitter";
import { Icon } from "./Icon";

/** 会话模块（两栏筛选式）：左侧会话树（选会话）+ 右侧该会话对话。
 *  默认选中第一个会话；树宽可拖拽（--tree-w）。 */
export function SessionsModule() {
  const { selectedSessionId, setSelectedSessionId, sessions } = useApp();
  // 默认选中第一个会话（首次进入或选中被清空时）
  useEffect(() => {
    const first = sessions[0];
    if (!selectedSessionId && first) {
      setSelectedSessionId(first.sessionId);
    }
  }, [selectedSessionId, sessions, setSelectedSessionId]);

  return (
    <div className="sessions-with-tree">
      <aside className="sessions-tree-panel panel">
        <SessionsPanel />
      </aside>
      <Splitter orient="v" varName="--tree-w" />
      <div className="sessions-main">
        {selectedSessionId ? (
          <SessionDetail sessionId={selectedSessionId} />
        ) : (
          <div className="empty-state">
            <Icon name="chat" size={30} />
            <span className="es-hint">暂无会话</span>
            <span className="es-sub">启动 Claude Code 后会出现</span>
          </div>
        )}
      </div>
    </div>
  );
}
