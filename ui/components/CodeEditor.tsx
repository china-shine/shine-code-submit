// Monaco Editor 封装:Skills 模块的 markdown 编辑器(VS Code 内核)。
// 细粒度导入(核心 API + 全部 editor contribution + markdown tokenizer),不带语言服务 worker——
// markdown 着色无需 worker;空 blob worker 占位,消除 MonacoEnvironment "no worker" 控制台警告。
import { useEffect, useRef } from "react";

// monaco 0.56 细粒度导入(exports 子路径映射 esm/vs/*):核心 API + 手挑 contrib(查找/折叠/多光标/
// 注释/括号匹配等)+ 仅 markdown tokenizer,不带 LSP 语言服务(worker),体积最小。
// side-effect contribution 模块无类型,ambient 声明在 ui/monaco-modules.d.ts。
import * as monaco from "monaco-editor/editor/editor.api";
import "monaco-editor/editor/browser/coreCommands";
import "monaco-editor/features/find/register";
import "monaco-editor/editor/contrib/find/browser/findController";
import "monaco-editor/editor/contrib/folding/browser/folding";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/editor/contrib/comment/browser/comment";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/editor/contrib/links/browser/links";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations";
import "monaco-editor/languages/definitions/markdown/register";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as any).MonacoEnvironment = {
  getWorker: () =>
    new Worker(URL.createObjectURL(new Blob(["self.onmessage = () => {}"], { type: "text/javascript" }))),
};

// 对齐 dashboard 的 VS Code Dark+(editor.background = --bg #1e1e1e)
monaco.editor.defineTheme("shine-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1e1e1e",
    "editor.lineNumber.foreground": "#858585",
  },
});

/** 受控 Monaco:value 变化仅在外部赋值(切文件/恢复)时重设模型,打字由 onDidChange 回流不构成循环。 */
export function CodeEditor({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange; // 恒取最新回调,避免 effect 依赖 onChange 导致编辑器重建

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const editor = monaco.editor.create(host, {
      value,
      language: "markdown",
      theme: "shine-dark",
      minimap: { enabled: false },
      fontSize: 13,
      lineHeight: 20,
      wordWrap: "on",
      scrollBeyondLastLine: false,
      automaticLayout: false, // ResizeObserver 手动 layout:tab 切换/窗口缩放/侧栏折叠都覆盖
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
      padding: { top: 8, bottom: 8 },
    });
    editorRef.current = editor;
    const sub = editor.onDidChangeModelContent(() => onChangeRef.current(editor.getValue()));
    const ro = new ResizeObserver(() => editor.layout());
    ro.observe(host);
    return () => {
      ro.disconnect();
      sub.dispose();
      editor.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
  }, [value]);

  // host 必须有非零高度:Monaco 按宿主尺寸布局,0 高宿主渲染空白(父级均为 flex 链,height:100% 兜底)
  return <div ref={hostRef} style={{ flex: 1, minHeight: 0, height: "100%" }} />;
}
