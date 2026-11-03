export class DeltaStreamError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DeltaStreamError";
    this.code = code;
  }
}

const CONNECTION_STATES = new Set(["online", "offline"]);

export class DeltaStream {
  #vault;
  #policyRoleIndex;
  #cursor = 0;
  #connectionState = "online";
  #listeners = new Set();

  constructor(options = {}) {
    if (!options.vault) throw new DeltaStreamError("DELTA_VAULT_REQUIRED", "DeltaStream 需要 MemberVault 实例");
    this.#vault = options.vault;
    this.#policyRoleIndex = options.policyRoleIndex ?? null;
  }

  get cursor() { return this.#cursor; }
  get connectionState() { return this.#connectionState; }
  isOffline() { return this.#connectionState === "offline"; }

  setConnectionState(state) {
    if (!CONNECTION_STATES.has(state)) throw new DeltaStreamError("DELTA_CONNECTION_INVALID", "未知连接状态：" + state);
    const changed = this.#connectionState !== state;
    this.#connectionState = state;
    if (changed) this.#emit({ type: "connection.changed", state });
    return state;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  applyDelta(delta) {
    if (!delta || !Number.isInteger(delta.seq) || !Array.isArray(delta.events)) throw new DeltaStreamError("DELTA_INVALID", "增量消息必须包含整数 seq 与 events 数组");
    if (delta.seq <= this.#cursor) return { applied: false, seq: this.#cursor };
    for (const event of delta.events) this.#applyEvent(event, delta.seq);
    this.#cursor = delta.seq;
    this.#emit({ type: "delta.applied", seq: delta.seq });
    return { applied: true, seq: delta.seq };
  }

  applyServerSnapshot(snapshot) {
    if (!snapshot || !Number.isInteger(snapshot.snapshotSeq) || !Array.isArray(snapshot.members)) throw new DeltaStreamError("SNAPSHOT_INVALID", "快照必须包含整数 snapshotSeq 与 members 数组");
    this.#vault.replaceMembers(snapshot.members);
    for (const member of snapshot.members) {
      if (member && typeof member.id === "string") this.#vault.recordMutationSeq(member.id, snapshot.snapshotSeq);
    }
    this.#cursor = Math.max(this.#cursor, snapshot.snapshotSeq);
    this.#emit({ type: "snapshot.applied", seq: snapshot.snapshotSeq });
    return { applied: true, snapshotSeq: snapshot.snapshotSeq };
  }

  #applyEvent(event, seq) {
    if (!event || typeof event.type !== "string") throw new DeltaStreamError("DELTA_EVENT_INVALID", "增量事件缺少 type");
    if (event.type === "member.added" || event.type === "member.updated") {
      if (!event.member || typeof event.member.id !== "string") throw new DeltaStreamError("DELTA_EVENT_INVALID", "成员事件缺少 member.id");
      if (seq < this.#vault.lastMutationSeqOf(event.member.id)) return;
      this.#vault.upsertMember(event.member);
      this.#vault.recordMutationSeq(event.member.id, seq);
      return;
    }
    if (event.type === "member.removed") {
      if (typeof event.memberId !== "string") throw new DeltaStreamError("DELTA_EVENT_INVALID", "移除事件缺少 memberId");
      this.#vault.removeMember(event.memberId, { mutationSeq: seq });
      return;
    }
    throw new DeltaStreamError("DELTA_EVENT_UNKNOWN", "未知增量事件：" + event.type);
  }

  #emit(payload) {
    for (const listener of [...this.#listeners]) {
      try { listener(payload); } catch {}
    }
  }
}
