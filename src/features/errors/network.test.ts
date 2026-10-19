import { describe, expect, test } from "vitest";
import { describeNetworkFailure } from "./network";

describe("describeNetworkFailure", () => {
  test("reqwest 那句「error sending request」补上「连不上服务器」", () => {
    const raw = "error sending request for url (https://github.com/x/y.zip)";
    const described = describeNetworkFailure(raw);

    expect(described.startsWith("连不上服务器")).toBe(true);
    // 原文必须留着 —— 真要排查还得靠它。
    expect(described).toContain(raw);
  });

  test("超时那一类说的是「连接超时」", () => {
    expect(describeNetworkFailure("operation timed out")).toMatch(/^连接超时/);
  });

  test("Rust 侧已经翻好的话不再包一层", () => {
    const already =
      "连不上服务器：网络可能不通，或者代理没有开启。（error sending request for url (x)）";
    expect(describeNetworkFailure(already)).toBe(already);
  });

  test("市场那边裹了一层「下载失败：」时也不会再包一层", () => {
    const raw =
      "下载失败：连不上服务器：网络可能不通，或者代理没有开启。（error sending request for url (x)）";

    expect(describeNetworkFailure(raw)).toBe(raw);
  });

  test("别的错误原样返回", () => {
    expect(describeNetworkFailure("磁盘空间不足")).toBe("磁盘空间不足");
  });

  test("空串原样返回", () => {
    expect(describeNetworkFailure("")).toBe("");
  });
});
