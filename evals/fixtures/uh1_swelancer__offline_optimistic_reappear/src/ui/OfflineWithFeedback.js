export function isMemberHidden(options = {}) {
  return !options.isOffline && (options.pendingAction ?? null) === "delete";
}

export function buildMemberRowViewModel(options = {}) {
  const member = options.member;
  if (!member) return null;
  const pendingAction = member.pendingAction ?? null;
  const isOffline = Boolean(options.isOffline);
  const hidden = isMemberHidden({ isOffline, pendingAction });
  return {
    id: member.id,
    displayName: typeof member.displayName === "string" && member.displayName.length > 0 ? member.displayName : (member.email ?? member.id),
    email: member.email ?? "",
    status: member.status ?? "active",
    pendingAction,
    hidden,
    interactive: !hidden,
    offlineIndicator: isOffline && pendingAction !== null,
    errorText: member.lastError ?? null,
  };
}

export function buildMemberListViewModel(options = {}) {
  const rows = (options.members ?? []).map((member) => buildMemberRowViewModel({ member, isOffline: options.isOffline })).filter(Boolean);
  return {
    rows,
    visibleRows: rows.filter((row) => !row.hidden),
    hiddenCount: rows.filter((row) => row.hidden).length,
  };
}
