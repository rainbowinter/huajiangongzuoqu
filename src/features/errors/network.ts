/**
 * 把底层网络错误翻成一句**能指导下一步**的话。
 *
 * 更新器（Tauri 插件）抛出来的错误常常只有一句 reqwest 的
 * `error sending request for url (…)` —— 用户看不出是「网络不通 / 代理没开」还是
 * 「服务器出问题」，只能来问。这里**只加一句结论**、原文照旧附在后面（真要排查还得靠它）。
 *
 * 两条边界：
 *
 * - 认不出来的错误**原样返回**，别的错误类型一个字都不动；
 * - Rust 侧（插件市场）已经翻过一遍了，靠前缀判断，避免被包成两层。
 */

/**
 * Rust 侧 `plugins::market::describe_request_error` 说的话。
 *
 * **不锚定开头**：市场那边外面还裹着一层「下载失败：」，只看开头会认不出来、被包成两层。
 */
const ALREADY_DESCRIBED = /(连接超时|连不上服务器|重定向次数过多|响应内容解析失败)/;

const NETWORK_FAILURES: ReadonlyArray<{ pattern: RegExp; hint: string }> = [
  {
    pattern: /timed out|timeout|os error 10060/i,
    hint: "连接超时：没能在限定时间内连上服务器。网络可能不通，或者代理没有开启。",
  },
  {
    pattern:
      /error sending request|error trying to connect|connection refused|connection reset|failed to connect|os error 100(54|61)|dns error|failed to lookup address/i,
    hint: "连不上服务器：网络可能不通，或者代理没有开启。",
  },
];

export function describeNetworkFailure(message: string): string {
  if (!message || ALREADY_DESCRIBED.test(message)) return message;

  const failure = NETWORK_FAILURES.find((candidate) => candidate.pattern.test(message));
  return failure ? `${failure.hint}（${message}）` : message;
}
