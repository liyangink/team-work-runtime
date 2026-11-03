import { MemberVault } from "../store/MemberVault.js";
import { PolicyRoleIndex } from "../policy/PolicyRoleIndex.js";
import { OfflineMutationQueue } from "../queue/OfflineMutationQueue.js";
import { DeltaStream } from "../sync/DeltaStream.js";

let mutationSequence = 0;

function nextMutationId(kind) {
  mutationSequence += 1;
  return kind + "-" + Date.now().toString(36) + "-" + mutationSequence;
}

export function createWorkspaceMemberActions(options = {}) {
  const { vault, policyRoleIndex, queue, isOffline = () => false } = options;
  if (!vault || !policyRoleIndex || !queue) throw new Error("createWorkspaceMemberActions 需要 vault、policyRoleIndex 与 queue");

  queue.subscribe((event) => {
    const mutation = event.mutation;
    if (!mutation) return;
    if (mutation.kind === "deleteWorkspaceMember") {
      if (event.type === "mutation.succeeded") {
        for (const memberId of mutation.memberIds) vault.removeMember(memberId, { mutationSeq: event.result.appliedSeq });
        return;
      }
      for (const snapshot of mutation.rollbackMembers ?? []) {
        vault.restoreMember(snapshot);
        vault.setLastError(snapshot.id, event.error?.message || "删除失败");
      }
      return;
    }
    if (mutation.kind === "assignWorkspaceMemberRole" && event.type === "mutation.failed") {
      const memberId = mutation.memberIds[0];
      if (mutation.previousRole === null) policyRoleIndex.removeRole(memberId);
      else policyRoleIndex.setRole(memberId, mutation.previousRole);
    }
  });

  async function flushPendingMutations() {
    if (isOffline()) return null;
    try {
      return await queue.flush();
    } catch (error) {
      return { appliedSeq: null, succeeded: [], failed: [], error };
    }
  }

  async function deleteMembers(memberIds) {
    const candidates = Array.isArray(memberIds) ? memberIds : [memberIds];
    const ids = [...new Set(candidates)].filter((id) => typeof id === "string" && vault.hasMember(id));
    if (ids.length === 0) return { queued: [], flushed: false, error: null };
    const rollbackMembers = ids.map((id) => vault.getMember(id)).filter(Boolean);
    for (const id of ids) vault.setPendingAction(id, "delete");
    const mutation = {
      id: nextMutationId("delete-members"),
      kind: "deleteWorkspaceMember",
      memberIds: ids,
      rollbackMembers,
      createdAt: Date.now(),
    };
    queue.enqueue(mutation);
    const report = await flushPendingMutations();
    return { queued: ids, flushed: report !== null, error: report?.error ?? null };
  }

  async function assignRole(memberId, roleId) {
    const previousRole = policyRoleIndex.getRole(memberId);
    policyRoleIndex.setRole(memberId, roleId);
    const mutation = {
      id: nextMutationId("assign-role"),
      kind: "assignWorkspaceMemberRole",
      memberIds: [memberId],
      payload: { roleId },
      previousRole,
      createdAt: Date.now(),
    };
    queue.enqueue(mutation);
    const report = await flushPendingMutations();
    return { queued: [memberId], flushed: report !== null, error: report?.error ?? null };
  }

  return { deleteMembers, assignRole, flushPendingMutations };
}

export function createWorkspaceRuntime(options = {}) {
  const vault = options.vault ?? new MemberVault(options.members ?? []);
  const policyRoleIndex = options.policyRoleIndex ?? new PolicyRoleIndex(options.policy ?? {});
  const queue = options.queue ?? new OfflineMutationQueue({ transport: options.transport, batchSize: options.batchSize });
  const isOffline = typeof options.isOffline === "function" ? options.isOffline : () => false;
  const actions = createWorkspaceMemberActions({ vault, policyRoleIndex, queue, isOffline });
  const stream = options.stream ?? new DeltaStream({ vault, policyRoleIndex });
  return { vault, policyRoleIndex, queue, stream, actions, deleteMembers: actions.deleteMembers, assignRole: actions.assignRole, flushPendingMutations: actions.flushPendingMutations };
}
