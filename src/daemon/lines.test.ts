import { describe, test, expect } from "bun:test";
import { isTrivialLine } from "./lines";

describe("isTrivialLine(AI 行集合过滤)", () => {
  test("空行/纯空白 → trivial", () => {
    expect(isTrivialLine("")).toBe(true);
    expect(isTrivialLine(" ")).toBe(true);
    expect(isTrivialLine("\t")).toBe(true);
  });
  test("纯括号/分号/标点 → trivial(惯用行,任何 commit 都有,入集合会虚高 aiAdded)", () => {
    expect(isTrivialLine("}")).toBe(true);
    expect(isTrivialLine("});")).toBe(true);
    expect(isTrivialLine("{")).toBe(true);
    expect(isTrivialLine(");")).toBe(true);
    expect(isTrivialLine("```")).toBe(true);
  });
  test("含字母/数字/中文 → 非 trivial(有信息量,保留)", () => {
    expect(isTrivialLine("const x = 1;")).toBe(false);
    expect(isTrivialLine("'use strict'")).toBe(false);
    expect(isTrivialLine("// 注释")).toBe(false);
    expect(isTrivialLine("中文行")).toBe(false);
    expect(isTrivialLine("0")).toBe(false);
  });
});
