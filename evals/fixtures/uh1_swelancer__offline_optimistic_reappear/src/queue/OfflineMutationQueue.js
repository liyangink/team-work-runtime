export class OfflineMutationQueueError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "OfflineMutationQueueError";
    this.code = code;
  }
}

const DEFAULT_BATCH_SIZE = 20;

export class OfflineMutationQueue {
  #transport;
  #batchSize;
  #pending = [];
  #inflight = null;
  #listeners = new Set();

  constructor(options = {}) {
    if (!options.transport || typeof options.transport.send !== "function") throw new OfflineMutationQueueError("QUEUE_TRANSPORT_REQUIRED", "离线队列需要提供 transport.send");
    this.#transport = options.transport;
    this.#batchSize = Number.isInteger(options.batchSize) && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH_SIZE;
  }

  get size() { return this.#pending.length; }
  get isFlushing() { return this.#inflight !== null; }

  listPending() {
    return this.#pending.map((mutation) => ({ id: mutation.id, kind: mutation.kind, memberIds: [...(mutation.memberIds ?? [])], createdAt: mutation.createdAt ?? null }));
  }

  enqueue(mutation) {
    if (!mutation || typeof mutation.id !== "string" || mutation.id.length === 0) throw new OfflineMutationQueueError("QUEUE_MUTATION_INVALID", "待决操作必须包含非空 id");
    if (typeof mutation.kind !== "string" || mutation.kind.length === 0) throw new OfflineMutationQueueError("QUEUE_MUTATION_INVALID", "待决操作必须包含非空 kind");
    if (this.#pending.some((item) => item.id === mutation.id)) throw new OfflineMutationQueueError("QUEUE_DUPLICATE_MUTATION", "待决操作 id 重复：" + mutation.id);
    this.#pending.push(mutation);
    return mutation.id;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  flush() {
    if (this.#inflight) return this.#inflight;
    if (this.#pending.length === 0) return Promise.resolve({ appliedSeq: null, succeeded: [], failed: [] });
    const batch = this.#pending.slice(0, this.#batchSize);
    this.#pending = this.#pending.slice(batch.length);
    this.#inflight = this.#sendBatch(batch).finally(() => { this.#inflight = null; });
    return this.#inflight;
  }

  async #sendBatch(batch) {
    let result;
    try {
      result = await this.#transport.send(batch);
    } catch (error) {
      this.#pending = batch;
      throw new OfflineMutationQueueError("QUEUE_BATCH_FAILED", "批量同步失败：" + (error && error.message ? error.message : "unknown"), { cause: error });
    }
    return this.#settleBatch(batch, result);
  }

  #settleBatch(batch, result) {
    if (!result || typeof result !== "object") throw new OfflineMutationQueueError("QUEUE_RESULT_INVALID", "transport.send 必须返回对象");
    const appliedIds = new Set(Array.isArray(result.applied) ? result.applied : []);
    const appliedSeq = Number.isInteger(result.appliedSeq) ? result.appliedSeq : null;
    const idempotentById = new Map((Array.isArray(result.idempotent) ? result.idempotent : []).map((entry) => [entry.mutationId, entry]));
    const failedById = new Map((Array.isArray(result.failed) ? result.failed : []).map((entry) => [entry.mutationId, entry]));
    const succeeded = [];
    const failed = [];
    for (const mutation of batch) {
      if (appliedIds.has(mutation.id)) {
        const outcome = { mutation, result: { appliedSeq, code: null, outcome: "applied" } };
        succeeded.push(outcome);
        this.#emit({ type: "mutation.succeeded", ...outcome });
        continue;
      }
      const idempotentEntry = idempotentById.get(mutation.id);
      if (idempotentEntry) {
        if (this.#declaresIdempotentSuccess(mutation, idempotentEntry.code)) {
          const outcome = { mutation, result: { appliedSeq: Number.isInteger(idempotentEntry.appliedSeq) ? idempotentEntry.appliedSeq : appliedSeq, code: idempotentEntry.code, outcome: "idempotent" } };
          succeeded.push(outcome);
          this.#emit({ type: "mutation.succeeded", ...outcome });
          continue;
        }
        const outcome = { mutation, error: { code: idempotentEntry.code, message: idempotentEntry.message ?? "" } };
        failed.push(outcome);
        this.#emit({ type: "mutation.failed", ...outcome });
        continue;
      }
      const failedEntry = failedById.get(mutation.id);
      const error = failedEntry ? { code: failedEntry.code, message: failedEntry.message ?? "" } : { code: "QUEUE_RESULT_MISSING", message: "服务器结果缺少该待决操作" };
      const outcome = { mutation, error };
      failed.push(outcome);
      this.#emit({ type: "mutation.failed", ...outcome });
    }
    if (failed.length > 0) this.#pending = failed.map((outcome) => outcome.mutation);
    return { appliedSeq, succeeded, failed };
  }

  #declaresIdempotentSuccess(mutation, code) {
    return Array.isArray(mutation.successData) && mutation.successData.some((entry) => entry && entry.code === code && entry.behavior === "treatAsApplied");
  }

  #emit(payload) {
    for (const listener of [...this.#listeners]) {
      try { listener(payload); } catch {}
    }
  }
}

export function createOfflineMutationQueue(options) { return new OfflineMutationQueue(options); }
