// 顶部加载进度条(不确定动画):首次打开/刷新 loading 时显示,数据到了消失。
// fixed 顶部细条,不影响布局;inline keyframes 自包含(不改 style.css)。
export function LoadingBar({ loading }: { loading: boolean }) {
  if (!loading) return null;
  return (
    <>
      <style>{`@keyframes shine-loadingbar { 0% { left: -35%; } 100% { left: 100%; } }`}</style>
      <div
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          right: 0,
          height: 3,
          zIndex: 9999,
          pointerEvents: "none",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            height: "100%",
            width: "35%",
            background: "#4f8cff",
            animation: "shine-loadingbar 1s ease-in-out infinite",
          }}
        />
      </div>
    </>
  );
}
