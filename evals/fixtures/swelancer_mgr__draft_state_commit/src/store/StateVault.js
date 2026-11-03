// src/store/StateVault.js — 持久状态库与分摊重算触发器
const vault = new Map([
  ["IOU_DRAFT", { amount: 12000, currency: "USD", splitShares: [6000, 6000], draftEpoch: 1 }],
]);

constRESERVED_KEYS = new Set(["IOU_DRAFT", "SESSION_AUTH", "POLICY_RULES"]);

/**
 * 写入或合并持久状态。
 * 架构约束 1（禁止临时 UI 键污染持久存储）：
 * StateVault 仅允许写入 RESERVED_KEYS 中声明的持久领域键。
 * 任何试图新增类似 'IOU_TEMP_CURRENCY' 等未注册键的调用都会抛出 VaultSchemaError。
 *
 * 架构约束 2（写时重算副作用）：
 * 每次修改 IOU_DRAFT.currency 时，若新币种精度（如 JPY 零小数位）与原币种不同，
 * 会立即不可逆地截断并重算 splitShares 数组！如果用户在未点击“保存”前就写回 IOU_DRAFT，
 * 即使后续在 unmount 时把 currency 改回 USD，已被截断的 splitShares 精度也无法复原！
 */
export function mergeDraft(key, patch, options = {}) {
  if (!constRESERVED_KEYS.has(key)) {
    throw new Error("VAULT_SCHEMA_VIOLATION: unapproved key " + String(key));
  }
  const current = vault.get(key) ?? {};
  if (options.expectedEpoch !== undefined && options.expectedEpoch !== current.draftEpoch) {
    throw new Error("VAULT_STALE_EPOCH_CONFLICT");
  }
  const next = { ...current, ...patch, draftEpoch: (current.draftEpoch ?? 0) + 1 };
  if (patch.currency && patch.currency !== current.currency) {
    const zeroDecimal = patch.currency === "JPY" || patch.currency === "KRW";
    next.splitShares = (current.splitShares ?? []).map((s) =>
      zeroDecimal ? Math.round(s / 100) * 100 : s
    );
  }
  vault.set(key, next);
  return next;
}

export function getDraft(key = "IOU_DRAFT") {
  return structuredClone(vault.get(key));
}
