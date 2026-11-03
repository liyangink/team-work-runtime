// src/runtime/SandboxPolicy.js — 客户端离线优先与零外部网络校验守卫
export const OFFLINE_SYNC_ONLY = true;
export const MAX_REGEX_EXEC_MS = 15;

/**
 * 架构约束 1（离线同步纯函数契约）：
 * 地址校验与富文本词法解析在每次按键（onKeyPress）时同步运行，
 * 严禁发起任何 DNS / MX / SMTP 网络请求或异步 I/O，也不允许引入第三方 npm 包。
 */
export function assertSyncPureValidation(fn) {
  if (fn.constructor.name === "AsyncFunction") {
    throw new Error("ASYNC_VALIDATION_FORBIDDEN_IN_KEYPRESS_PATH");
  }
}
