const MEMBER_STATUSES = new Set(["active", "invited", "suspended"]);

export class MemberVaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MemberVaultError";
    this.code = code;
  }
}

export function normalizeMember(input) {
  if (!input || typeof input !== "object") throw new MemberVaultError("MEMBER_INVALID", "成员记录必须是对象");
  if (typeof input.id !== "string" || input.id.trim().length === 0) throw new MemberVaultError("MEMBER_ID_INVALID", "成员 id 必须是非空字符串");
  const status = input.status ?? "active";
  if (!MEMBER_STATUSES.has(status)) throw new MemberVaultError("MEMBER_STATUS_INVALID", "未知成员状态：" + status);
  return {
    id: input.id,
    email: typeof input.email === "string" ? input.email : "",
    displayName: typeof input.displayName === "string" && input.displayName.length > 0 ? input.displayName : (typeof input.email === "string" ? input.email : input.id),
    status,
    pendingAction: input.pendingAction ?? null,
    lastError: input.lastError ?? null,
  };
}

export class MemberVault {
  #members = new Map();
  #mutationSeq = new Map();
  #revision = 0;
  #listeners = new Set();

  constructor(members = []) {
    for (const member of members) {
      const normalized = normalizeMember(member);
      this.#members.set(normalized.id, normalized);
    }
  }

  get revision() { return this.#revision; }

  listMembers() {
    return [...this.#members.values()].map((member) => ({ ...member })).sort((left, right) => left.id.localeCompare(right.id));
  }

  getMember(id) {
    const member = this.#members.get(id);
    return member ? { ...member } : null;
  }

  hasMember(id) { return this.#members.has(id); }

  upsertMember(input) {
    const normalized = normalizeMember(input);
    const current = this.#members.get(normalized.id);
    if (current && normalized.pendingAction === null) normalized.pendingAction = current.pendingAction;
    this.#members.set(normalized.id, normalized);
    this.#bump("member.upserted", normalized.id);
    return { ...normalized };
  }

  setPendingAction(id, action) {
    const current = this.#members.get(id);
    if (!current) return false;
    this.#members.set(id, { ...current, pendingAction: action ?? null });
    this.#bump("member.pending-changed", id);
    return true;
  }

  setLastError(id, lastError) {
    const current = this.#members.get(id);
    if (!current) return false;
    this.#members.set(id, { ...current, lastError: lastError ?? null });
    this.#bump("member.error-changed", id);
    return true;
  }

  removeMember(id, options = {}) {
    if (Number.isInteger(options.mutationSeq)) this.recordMutationSeq(id, options.mutationSeq);
    const removed = this.#members.delete(id);
    if (removed) this.#bump("member.removed", id);
    return removed;
  }

  restoreMember(input) {
    const normalized = normalizeMember({ ...input, pendingAction: null, lastError: null });
    this.#members.set(normalized.id, normalized);
    this.#bump("member.restored", normalized.id);
    return { ...normalized };
  }

  replaceMembers(members) {
    const next = new Map();
    for (const member of members ?? []) {
      const normalized = normalizeMember(member);
      next.set(normalized.id, normalized);
    }
    this.#members = next;
    this.#bump("members.replaced", null);
  }

  recordMutationSeq(id, seq) {
    if (!Number.isInteger(seq) || seq < 0) throw new MemberVaultError("MEMBER_SEQ_INVALID", "变更序号必须是非负整数");
    const current = this.#mutationSeq.get(id) ?? 0;
    if (seq > current) this.#mutationSeq.set(id, seq);
    return this.#mutationSeq.get(id);
  }

  lastMutationSeqOf(id) { return this.#mutationSeq.get(id) ?? 0; }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #bump(reason, memberId) {
    this.#revision += 1;
    const event = { reason, memberId, revision: this.#revision };
    for (const listener of [...this.#listeners]) {
      try { listener(event); } catch {}
    }
  }
}
