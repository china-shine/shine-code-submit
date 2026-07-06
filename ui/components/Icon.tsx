import type { ReactNode } from "react";

/** 统一图标：24×24 viewBox、stroke=currentColor、1.6 描边、圆角端点。
 *  跨平台渲染一致（替代 emoji/几何符号），尺寸随 --icon 或 size 覆盖。 */
export type IconName =
  | "sessions"
  | "log"
  | "download"
  | "close"
  | "chevron"
  | "info"
  | "inbox"
  | "chat"
  | "diamond"
  | "activity"
  | "warning"
  | "home"
  | "git"
  | "chart"
  | "server";

const PATHS: Record<IconName, ReactNode> = {
  sessions: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18" />
    </>
  ),
  log: (
    <>
      <rect x="6" y="3" width="12" height="18" rx="2" />
      <path d="M9 8h6 M9 12h6 M9 16h3" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </>
  ),
  close: <path d="M6 6l12 12 M18 6L6 18" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5 M12 8h.01" />
    </>
  ),
  inbox: (
    <>
      <path d="M3 12h5l2 3h4l2-3h5" />
      <rect x="4" y="4" width="16" height="16" rx="1" />
    </>
  ),
  chat: <path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2z" />,
  diamond: <path d="M12 3l9 9-9 9-9-9z" />,
  activity: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  warning: (
    <>
      <path d="M12 3l9 17H3z" />
      <path d="M12 10v4 M12 17h.01" />
    </>
  ),
  home: (
    <>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h4v-6h6v6h4V10" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="9" r="2" />
      <path d="M6 8v8M15 9h1" />
    </>
  ),
  chart: <path d="M4 20V12M10 20V5M16 20v-8M3 20h17" />,
  server: (
    <>
      <rect x="4" y="4" width="16" height="6" rx="1" />
      <rect x="4" y="14" width="16" height="6" rx="1" />
      <path d="M8 7h.01M8 17h.01" />
    </>
  ),
};

export function Icon({
  name,
  size,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`icon icon-${name}${className ? " " + className : ""}`}
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
