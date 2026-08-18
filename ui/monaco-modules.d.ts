// monaco-editor 0.56 细粒度 contribution 模块无独立 d.ts(类型集中在 editor.api.d.ts)。
// 必须放在全局脚本文件(无 import/export)里才是 ambient 通配声明;
// 放进组件模块会被当作 augmentation 报 TS2664。
declare module "monaco-editor/editor/browser/*";
declare module "monaco-editor/editor/contrib/*";
declare module "monaco-editor/features/*";
