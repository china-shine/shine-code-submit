import { describe, test, expect } from "bun:test";
import { applyMark, isAiWork, stripMark } from "../lib/shared";

describe("applyMark", () => {
  const on = { enabled: true, text: "本次内容由AI填报" };

  test("enabled + 文案 → 末尾行内追加 (文案)(不换行)", () => {
    expect(applyMark("完成 A 功能", on)).toBe("完成 A 功能(本次内容由AI填报)");
  });

  test("disabled → 原样", () => {
    expect(applyMark("完成 A 功能", { enabled: false, text: "本次内容由AI填报" })).toBe("完成 A 功能");
  });

  test("text 为空 → 原样(即使 enabled)", () => {
    expect(applyMark("完成 A 功能", { enabled: true, text: "" })).toBe("完成 A 功能");
  });

  test("自定义文案", () => {
    expect(applyMark("x", { enabled: true, text: "[AI代报]" })).toBe("x([AI代报])");
  });

  test("幂等:已带标记不重复追加", () => {
    const once = applyMark("完成 A", on);
    expect(applyMark(once, on)).toBe(once);
  });

  test("多行 work:标记加在整段末尾行内(不在每行)", () => {
    expect(applyMark("1. a\n2. b", on)).toBe("1. a\n2. b(本次内容由AI填报)");
  });

  test("幂等(includes):中间行已带标记的逐条标识产物不再重复追加", () => {
    const numbered = "1. a(本次内容由AI填报)\n2. b(本次内容由AI填报)";
    expect(applyMark(numbered, on)).toBe(numbered); // 旧 endsWith 会在末尾再拼一个
  });
});

describe("isAiWork", () => {
  const text = "本次内容由AI填报";

  test("命中(新括号格式)", () => {
    expect(isAiWork("x(本次内容由AI填报)", text)).toBe(true);
  });

  test("命中(旧换行格式,历史提交兼容)", () => {
    expect(isAiWork("x\n本次内容由AI填报", text)).toBe(true);
  });

  test("不命中(无标记)", () => {
    expect(isAiWork("x", text)).toBe(false);
  });

  test("不命中(同行无括号包裹)", () => {
    expect(isAiWork("x本次内容由AI填报", text)).toBe(false);
  });

  test("text 为空 → false", () => {
    expect(isAiWork("x(本次内容由AI填报)", "")).toBe(false);
  });
});

describe("stripMark", () => {
  const text = "本次内容由AI填报";

  test("剥掉命中标记(新括号格式)", () => {
    expect(stripMark("完成 A(本次内容由AI填报)", text)).toBe("完成 A");
  });

  test("剥掉命中标记(旧换行格式)", () => {
    expect(stripMark("完成 A\n本次内容由AI填报", text)).toBe("完成 A");
  });

  test("不命中原样返回", () => {
    expect(stripMark("完成 A", text)).toBe("完成 A");
  });

  test("text 为空原样返回", () => {
    expect(stripMark("完成 A(本次内容由AI填报)", "")).toBe("完成 A(本次内容由AI填报)");
  });

  test("多行 work:只剥末尾标记(新格式),保留正文", () => {
    expect(stripMark("1. a\n2. b(本次内容由AI填报)", text)).toBe("1. a\n2. b");
  });

  test("不误剥正文里恰好出现的文案(无括号包裹)", () => {
    expect(stripMark("本次内容由AI填报说明", text)).toBe("本次内容由AI填报说明");
  });
});
