import { useApi } from "../hooks/useApi";
import { useCommits } from "../hooks/useCommits";
import { useApp } from "../state/AppContext";
import { CommitsView } from "./CommitsView";

/** 提交模块：最近活跃项目（sessions[0].cwd）的 git log。
 *  Step 3：cwd 自管（不再依赖 selectedSessionId），数据经 useCommits 拉取。 */
export function CommitsModule() {
  const { token, sessions } = useApp();
  const api = useApi(token);
  const cwd = sessions[0]?.cwd ?? null;
  const { commits, loading, error } = useCommits(api, cwd, true);
  return (
    <>
      <div className="toolbar">
        {cwd && (
          <span className="filter-label" title={cwd}>
            {cwd}
          </span>
        )}
      </div>
      <CommitsView commits={commits} loading={loading} error={error} cwd={cwd} />
    </>
  );
}
