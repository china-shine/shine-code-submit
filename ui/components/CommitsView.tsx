import { useState } from "react";
import { Icon } from "./Icon";
import { fmtDateTime } from "../lib/util";
import type { CommitLog } from "../types";

/** 单条提交：时间 + +新增/-删除 + 说明 + 作者；点击展开文件级明细。 */
function CommitRow({ c }: { c: CommitLog }) {
  const [open, setOpen] = useState(false);
  return (
    <li
      className={`commit${open ? " open" : ""}`}
      title="点击展开/收起文件明细"
      onClick={() => setOpen((v) => !v)}
    >
      <div className="commit-row">
        <span className="commit-ts">{fmtDateTime(c.time)}</span>
        <span className="commit-add">+{c.added}</span>
        <span className="commit-del">-{c.deleted}</span>
        <span className="commit-subject">{c.subject || "(无说明)"}</span>
        <span className="commit-author">{c.author}</span>
      </div>
      {open && c.files.length > 0 && (
        <ul className="commit-files">
          {c.files.map((f, i) => (
            <li key={i} className="commit-file">
              <span className="cf-add">+{f.added}</span>
              <span className="cf-del">-{f.deleted}</span>
              <span className="cf-path">{f.path}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** 提交列表（props 驱动，Step 3 下沉）。数据由 CommitsModule 经 useCommits 传入。 */
export function CommitsView({
  commits,
  loading,
  error,
  cwd,
}: {
  commits: CommitLog[];
  loading: boolean;
  error: string | null;
  cwd: string | null;
}) {
  let body;
  // 仅首次加载（无缓存）才显加载态；切回已有数据静默刷新
  if (loading && commits.length === 0) {
    body = (
      <div className="empty-state">
        <span className="es-hint">加载提交…</span>
      </div>
    );
  } else if (error) {
    body = (
      <div className="empty-state">
        <Icon name="warning" size={28} />
        <span className="es-hint">{error}</span>
        {cwd && <span className="es-sub">{cwd}</span>}
      </div>
    );
  } else if (!commits.length) {
    body = (
      <div className="empty-state">
        <Icon name="inbox" size={30} />
        <span className="es-hint">暂无提交</span>
        <span className="es-sub">该仓库最近无提交记录</span>
      </div>
    );
  } else {
    body = (
      <ul id="commits" className="commit-list">
        {commits.map((c) => (
          <CommitRow key={c.hash} c={c} />
        ))}
      </ul>
    );
  }

  return <div id="commits-view" className="commits-view">{body}</div>;
}
