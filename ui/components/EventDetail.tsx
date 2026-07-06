import { formatDetail } from "../lib/format";

/** 事件详情：formatDetail 产出 HTML（内部已 escapeHtml），用 dangerouslySetInnerHTML 渲染。 */
export function EventDetail({ payload }: { payload: unknown }) {
  return (
    <div className="event-detail" dangerouslySetInnerHTML={{ __html: formatDetail(payload) }} />
  );
}
