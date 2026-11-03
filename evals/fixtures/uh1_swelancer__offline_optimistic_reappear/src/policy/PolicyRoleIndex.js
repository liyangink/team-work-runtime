export const WORKSPACE_ROLE_IDS = Object.freeze(["owner", "admin", "approver", "manager", "member"]);

export class PolicyRoleIndexError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PolicyRoleIndexError";
    this.code = code;
  }
}

export class PolicyRoleIndex {
  #roleByMemberId = new Map();
  #delegateByMemberId = new Map();

  constructor(options = {}) {
    for (const [memberId, roleId] of Object.entries(options.roleByMemberId ?? {})) this.setRole(memberId, roleId);
    for (const [memberId, delegateId] of Object.entries(options.delegateByMemberId ?? {})) this.delegateApproval(memberId, delegateId);
  }

  getRole(memberId) { return this.#roleByMemberId.get(memberId) ?? null; }

  hasRole(memberId) { return this.#roleByMemberId.has(memberId); }

  listRoles() {
    return [...this.#roleByMemberId.entries()].map(([memberId, roleId]) => ({ memberId, roleId })).sort((left, right) => left.memberId.localeCompare(right.memberId));
  }

  setRole(memberId, roleId) {
    if (typeof memberId !== "string" || memberId.length === 0) throw new PolicyRoleIndexError("ROLE_INDEX_MEMBER_INVALID", "成员 id 必须是非空字符串");
    if (!WORKSPACE_ROLE_IDS.includes(roleId)) throw new PolicyRoleIndexError("ROLE_INDEX_ROLE_INVALID", "未知工作区角色：" + roleId);
    this.#roleByMemberId.set(memberId, roleId);
    return roleId;
  }

  removeRole(memberId) { return this.#roleByMemberId.delete(memberId); }

  getDelegate(memberId) { return this.#delegateByMemberId.get(memberId) ?? null; }

  listDelegations() {
    return [...this.#delegateByMemberId.entries()].map(([memberId, delegateId]) => ({ memberId, delegateId })).sort((left, right) => left.memberId.localeCompare(right.memberId));
  }

  delegateApproval(memberId, delegateId) {
    if (!this.#roleByMemberId.has(memberId)) throw new PolicyRoleIndexError("ROLE_INDEX_UNKNOWN_MEMBER", "转交发起人不在角色索引中：" + memberId);
    if (!this.#roleByMemberId.has(delegateId)) throw new PolicyRoleIndexError("ROLE_INDEX_UNKNOWN_MEMBER", "转交目标不在角色索引中：" + delegateId);
    if (memberId === delegateId) throw new PolicyRoleIndexError("ROLE_INDEX_SELF_DELEGATION", "审批不能转交给自己");
    this.#delegateByMemberId.set(memberId, delegateId);
    return delegateId;
  }

  removeDelegation(memberId) { return this.#delegateByMemberId.delete(memberId); }

  resolveApproverId(memberId) {
    if (!this.#roleByMemberId.has(memberId)) throw new PolicyRoleIndexError("ROLE_INDEX_UNKNOWN_MEMBER", "成员不在角色索引中：" + memberId);
    const visited = [];
    let cursor = memberId;
    while (this.#delegateByMemberId.has(cursor)) {
      if (visited.includes(cursor)) throw new PolicyRoleIndexError("ROLE_INDEX_DELEGATION_CYCLE", "审批转交链存在环路：" + [...visited, cursor].join(" -> "));
      visited.push(cursor);
      const next = this.#delegateByMemberId.get(cursor);
      if (!this.#roleByMemberId.has(next)) throw new PolicyRoleIndexError("ROLE_INDEX_DANGLING_DELEGATE", "审批转交目标不存在：" + next);
      cursor = next;
    }
    return cursor;
  }
}
