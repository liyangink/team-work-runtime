// src/validation/AddressValidator.js — 前后端账号地址校验器
// 当前缺陷 1：前端 EMAIL_LOOSE_REGEX 未限制总长度（<=254）、本地部分长度（<=64）以及域名单标签长度（<=63），
// 且允许域名段以连字符 '-' 开头或结尾，导致超长或畸形地址通过前端校验却被后端 rejectBackendAddress 拒绝。

export const EMAIL_LOOSE_REGEX = /^[\w.'#%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

export function isValidFrontendAddress(input) {
  if (typeof input !== "string") return false;
  return EMAIL_LOOSE_REGEX.test(input);
}

/**
 * 后端严格校验基线（前端必须与该规则保持 100% 行为等价）：
 * 1. 总长度 <= 254；
 * 2. '@' 左侧 local-part 长度 1..64，且不得以 '.' 开头或结尾，不得包含连续 '..'；
 * 3. '@' 右侧 domain 总长度 <= 253，按 '.' 切分的每个 domain label 长度 1..63，
 *    且每个 label 不得以 '-' 开头或结尾，顶级域名（TLD）至少 2 个字母。
 */
export function verifyBackendAddressContract(input) {
  if (typeof input !== "string" || input.length === 0 || input.length > 254) return false;
  const atIdx = input.indexOf("@");
  if (atIdx <= 0 || atIdx !== input.lastIndexOf("@")) return false;
  const local = input.slice(0, atIdx);
  const domain = input.slice(atIdx + 1);
  if (local.length > 64 || domain.length > 253) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  if (!/^[\w.'#%+-]+$/.test(local)) return false;
  const labels = domain.split(".");
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (label.startsWith("-") || label.endsWith("-")) return false;
    if (!/^[a-zA-Z0-9-]+$/.test(label)) return false;
  }
  const tld = labels.at(-1);
  return /^[a-zA-Z]{2,}$/.test(tld);
}
