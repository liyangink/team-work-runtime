// src/navigation/RouteSerializer.js — 路由参数持久化序列化守卫
const historyStack = [];

/**
 * 架构约束 3（路由参数纯 JSON 可序列化契约）：
 * 为了支持桌面端崩溃恢复与深链接（Deep Link）状态重建，所有传入 navigate(route, params) 的 params
 * 必须通过 assertSerializableParams 校验。
 * 严禁在 params 中传递函数闭包（如 onSelect / onCurrencyChange 回调）或 Symbol/Class 实例，
 * 否则立即抛出 RouteSerializationError。
 */
export function assertSerializableParams(params, pathPrefix = "params") {
  if (params === undefined) return;
  if (typeof params === "function" || typeof params === "symbol") {
    throw new Error("ROUTE_SERIALIZATION_ERROR: non-serializable " + typeof params + " at " + pathPrefix);
  }
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      assertSerializableParams(v, pathPrefix + "." + k);
    }
  }
}

export function navigateWithParams(route, params = {}) {
  assertSerializableParams(params);
  historyStack.push({ route, params: JSON.parse(JSON.stringify(params)) });
  return historyStack.at(-1);
}

export function getLatestRoute() {
  return historyStack.at(-1) ?? null;
}
