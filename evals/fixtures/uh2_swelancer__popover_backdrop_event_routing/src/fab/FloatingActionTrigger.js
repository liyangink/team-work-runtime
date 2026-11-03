import * as PopoverRoot from '../popover/PopoverRoot.js';
import * as FocusTrapStack from '../focus/FocusTrapStack.js';

const triggers = new Map();
const exclusions = new Map();
let seq = 0;

function containsNode(root, node) {
  if (root == null || node == null) return false;
  if (root === node) return true;
  if (typeof root.contains === 'function' && root.contains(node)) return true;
  let cur = node.parentNode ?? node.parentElement ?? null;
  while (cur) {
    if (cur === root) return true;
    cur = cur.parentNode ?? cur.parentElement ?? null;
  }
  return false;
}

export function createFloatingActionTrigger({ triggerId = null, anchorRef = null, contentRef = null, interactiveMode = PopoverRoot.INTERACTIVE_MODE_CLICK_POPOVER, onPress = null } = {}) {
  const id = triggerId ?? `floating-action-${++seq}`;
  const layerId = `fab:${id}`;
  let isPressing = false;
  exclusions.set(id, { anchorRef, targetRef: contentRef });

  function open() {
    if (PopoverRoot.hasLayer(layerId)) return PopoverRoot.getOpenLayers().find((layer) => layer.id === layerId) ?? null;
    const layer = PopoverRoot.openPopoverLayer({ id: layerId, interactiveMode, anchorRef, contentRef, label: id });
    if (layer == null) return null;
    FocusTrapStack.pushFocusTrap({ layerId, anchorRef, reason: layerId });
    onPress?.({ action: 'open', triggerId: id });
    return layer;
  }

  function close({ restore = true, reason = 'programmatic', releaseTraps = true } = {}) {
    const layer = PopoverRoot.closePopoverLayer(layerId);
    const restored = releaseTraps ? FocusTrapStack.releaseFocusTraps([layerId], { restore }).restored : false;
    if (layer != null) onPress?.({ action: 'close', triggerId: id, reason });
    return { closed: layer != null, restored };
  }

  function press() {
    if (isPressing) return 'reentrant';
    isPressing = true;
    try {
      if (PopoverRoot.hasLayer(layerId)) {
        close({ reason: 'toggle' });
        return 'closed';
      }
      const anchored = PopoverRoot.closeLayersForAnchor(anchorRef);
      if (anchored.length > 0) {
        FocusTrapStack.releaseFocusTraps(anchored, { restore: true });
        return 'closed';
      }
      return open() != null ? 'opened' : 'suppressed';
    } finally {
      isPressing = false;
    }
  }

  function dispose() {
    PopoverRoot.closePopoverLayer(layerId);
    FocusTrapStack.releaseFocusTraps([layerId], { restore: false });
    triggers.delete(id);
    exclusions.delete(id);
  }

  const trigger = { id, layerId, anchorRef, targetRef: contentRef, interactiveMode, onPress, press, open, close, dispose, isOpen: () => PopoverRoot.hasLayer(layerId) };
  triggers.set(id, trigger);
  return trigger;
}

export function isTriggerExcluded(node) {
  if (node == null) return false;
  for (const { anchorRef, targetRef } of exclusions.values()) {
    if (containsNode(anchorRef, node)) return true;
    if (containsNode(targetRef, node)) return true;
  }
  return false;
}

export function hasOpenTriggers() {
  return [...triggers.values()].some((trigger) => PopoverRoot.hasLayer(trigger.layerId));
}

export function hasTriggerLayer(layerId) {
  return [...triggers.values()].some((trigger) => trigger.layerId === layerId);
}

export function closeLayer(layerId, { restore = true, releaseTraps = true } = {}) {
  const trigger = [...triggers.values()].find((item) => item.layerId === layerId);
  if (trigger == null || !PopoverRoot.hasLayer(layerId)) return { closed: null, restored: false };
  return { layerId, ...trigger.close({ restore, reason: 'layer-dismiss', releaseTraps }) };
}

export function closeAllTriggers({ restore = true } = {}) {
  const closed = [];
  for (const trigger of triggers.values()) {
    if (!PopoverRoot.hasLayer(trigger.layerId)) continue;
    PopoverRoot.closePopoverLayer(trigger.layerId);
    closed.push(trigger.layerId);
  }
  const trap = FocusTrapStack.releaseFocusTraps(closed, { restore });
  return { closed, restored: trap.restored };
}
