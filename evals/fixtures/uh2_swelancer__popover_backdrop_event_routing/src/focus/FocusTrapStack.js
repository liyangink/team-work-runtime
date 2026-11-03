const stack = [];

export function pushFocusTrap({ layerId = null, anchorRef = null, onRestore = null, reason = '' } = {}) {
  if (layerId == null) return null;
  const existing = stack.find((entry) => entry.layerId === layerId);
  if (existing) return { ...existing };
  const entry = { layerId, anchorRef, onRestore, reason: reason || layerId };
  stack.push(entry);
  return { ...entry };
}

export function getFocusTrapStack() {
  return stack.map((entry) => ({ ...entry }));
}

export function getTopFocusTrap() {
  return stack.length > 0 ? { ...stack[stack.length - 1] } : null;
}

function restoreEntry(entry) {
  if (entry == null) return false;
  try {
    if (typeof entry.onRestore === 'function') {
      entry.onRestore(entry);
      return true;
    }
    const anchor = entry.anchorRef;
    if (anchor != null && typeof anchor.focus === 'function') {
      anchor.focus({ preventScroll: true });
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function releaseFocusTraps(layerIds, { restore = true } = {}) {
  const wanted = new Set(layerIds);
  const released = [];
  while (stack.length > 0 && wanted.has(stack[stack.length - 1].layerId)) {
    released.push(stack.pop());
  }
  const restored = restore && released.length > 0 ? restoreEntry(released[released.length - 1]) : false;
  const blocked = [...wanted].filter((id) => !released.some((entry) => entry.layerId === id));
  return { released: released.map((entry) => entry.layerId), restored, blocked };
}

export function popFocusTrap(layerId, { restore = true } = {}) {
  const result = releaseFocusTraps([layerId], { restore });
  return { popped: result.released.length > 0, restored: result.restored, blockedByLifo: result.blocked.length > 0, blocked: result.blocked };
}

export function restoreFocusTo(layerId) {
  const entry = stack.find((item) => item.layerId === layerId);
  return restoreEntry(entry ?? null);
}
