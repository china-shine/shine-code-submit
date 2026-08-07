import { describe, test, expect } from "bun:test";
import { applyMark, isAiWork, stripMark } from "../lib/shared";

describe("applyMark", () => {
  const on = { enabled: true, text: "本次内容由AI填报" };

  test("enabled + 文案 → 末尾追加换行+文案", () => {
    expect(applyMark("完成 A 功能", on)).toBe("完成 A 功能\n本次内容由AI填报");
  });

  test("disabled → 原样", () => {
    expect(applyMark("完成 A 功能", { enabled: false, text: "本次内容由AI填报" })).toBe("完成 A 功能");
  });

  test("text 为空 → 原样(即使 enabled)", () => {
    expect(applyMark("完成 A 功能", { enabled: true, text: "" })).toBe("完成 A 功能");
  });

  test("自定义文案", () => {
    expect(applyMark("x", { enabled: true, text: "[AI代报]" })).toBe("x\n[AI代报]");
  });

  test("幂等:已带标记不重复追加", () => {
    const once = applyMark("完成 A", on);
    expect(applyMark(once, on)).toBe(once);
  });

  test("多行 work:标记加在整段末尾(不在每行)", () => {
    expect(applyMark("1. a\n2. b", on)).toBe("1. a\n2. b\n本次内容由AI填报");
  });
});

describe("isAiWork", () => {
  const text = "本次内容由AI填报";

  test("命中(独立行结尾)", () => {
    expect(isAiWork("x\n本次内容由AI填报", text)).toBe(true);
  });

  test("不命中(无标记)", () => {
    expect(isAiWork("x", text)).toBe(false);
  });

  test("不命中(同行无换行前缀)", () => {
    expect(isAiWork("x本次内容由AI填报", text)).toBe(false);
  });

  test("text 为空 → false", () => {
    expect(isAiWork("x\n本次内容由AI填报", "")).toBe(false);
  });
});

describe("stripMark", () => {
  const text = "本次内容由AI填报";

  test("剥掉命中标记", () => {
    expect(stripMark("完成 A\n本次内容由AI填报", text)).toBe("完成 A");
  });

  test("不命中原样返回", () => {
    expect(stripMark("完成 A", text)).toBe("完成 A");
  });

  test("text 为空原样返回", () => {
    expect(stripMark("完成 A\n本次内容由AI填报", "")).toBe("完成 A\n本次内容由AI填报");
  });

  test("多行 work:只剥末尾标记行,保留正文", () => {
    expect(stripMark("1. a\n2. b\n本次内容由AI填报", text)).toBe("1. a\n2. b");
  });

  test("不误剥正文里恰好出现的文案(无换行前缀)", () => {
    expect(stripMark("本次内容由AI填报说明", text)).toBe("本次内容由AI填报说明");
  });
});
