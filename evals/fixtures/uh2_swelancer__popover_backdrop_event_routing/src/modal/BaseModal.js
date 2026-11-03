import * as PopoverRoot from '../popover/PopoverRoot.js';
import * as ReportContextMenu from '../contextmenu/ReportContextMenu.js';
import * as FloatingActionTrigger from '../fab/FloatingActionTrigger.js';
import * as FocusTrapStack from '../focus/FocusTrapStack.js';

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

export function createBaseModal({ modalId = 'base-modal', fullscreen = false, surfaceRef = null, backdropRef = null, onDismiss = null } = {}) {
  let isOpen = false;
  const trapLayerId = `modal:${modalId}`;

  function open() {
    if (isOpen) return false;
    isOpen = true;
    FocusTrapStack.pushFocusTrap({ layerId: trapLayerId, anchorRef: surfaceRef, reason: trapLayerId });
    return true;
  }

  function dismiss(reason = 'programmatic') {
    if (!isOpen) return false;
    isOpen = false;
    FocusTrapStack.releaseFocusTraps([trapLayerId], { restore: true });
    onDismiss?.(reason);
    return true;
  }

  function closeInteractionIslands({ restore = true } = {}) {
    const closedLayers = [];
    const menus = [];
    const triggers = [];
    let guard = 0;
    while (PopoverRoot.countOpenLayers() > 0 && guard < 64) {
      const top = PopoverRoot.getTopLayer();
      if (top == null) break;
      const before = PopoverRoot.countOpenLayers();
      if (ReportContextMenu.hasMenuLayer(top.id)) {
        const result = ReportContextMenu.closeTopMenu({ restore: false, releaseTraps: false });
        if (result.closed != null) menus.push(result.closed);
        closedLayers.push(...result.layerIds);
      } else if (FloatingActionTrigger.hasTriggerLayer(top.id)) {
        FloatingActionTrigger.closeLayer(top.id, { restore: false, releaseTraps: false });
        triggers.push(top.id);
        closedLayers.push(top.id);
      } else {
        PopoverRoot.closePopoverLayer(top.id);
      }
      if (PopoverRoot.countOpenLayers() >= before) PopoverRoot.closePopoverLayer(top.id);
      guard += 1;
    }
    const trap = FocusTrapStack.releaseFocusTraps(closedLayers, { restore });
    return { menus, triggers, layers: closedLayers, restored: trap.restored };
  }

  function requestBackdropDismiss(event) {
    if (!isOpen) return 'ignored';
    if ((event?.button ?? 0) !== 0) return 'ignored';
    if (surfaceRef != null && containsNode(surfaceRef, event?.target)) return 'inside';
    if (PopoverRoot.isEventInsideAnyLayer(event)) return 'layer';
    if (FloatingActionTrigger.isTriggerExcluded(event?.target)) return 'trigger';
    const hasIsland = ReportContextMenu.hasOpenMenus() || FloatingActionTrigger.hasOpenTriggers() || PopoverRoot.countOpenLayers() > 0;
    if (hasIsland) {
      closeInteractionIslands({ restore: true });
      return 'island';
    }
    dismiss('backdrop');
    return 'dismissed';
  }

  function handleKeyDown(event) {
    if (!isOpen || event?.key !== 'Escape') return 'ignored';
    const top = PopoverRoot.getTopLayer();
    if (top == null) {
      dismiss('escape');
      return 'dismissed';
    }
    event?.preventDefault?.();
    if (ReportContextMenu.hasMenuLayer(top.id)) {
      const result = ReportContextMenu.closeMenuLayer(top.id, { restore: true });
      return result.closed != null ? 'menu' : 'blocked';
    }
    if (FloatingActionTrigger.hasTriggerLayer(top.id)) {
      FloatingActionTrigger.closeLayer(top.id, { restore: true });
      return 'trigger';
    }
    PopoverRoot.closePopoverLayer(top.id);
    return 'layer';
  }

  return {
    modalId,
    fullscreen,
    open,
    dismiss,
    closeInteractionIslands,
    requestBackdropDismiss,
    handleKeyDown,
    isOpen: () => isOpen,
    getBackdropStyle: () => ({ visible: isOpen && !fullscreen, capturesPointer: isOpen && !fullscreen }),
    getSurfaceStyle: () => ({ overflow: 'auto', position: 'relative', zIndex: fullscreen ? 0 : 1 }),
  };
}

export function bindBackdropOutsideGuard(modal, { document: documentRef = null } = {}) {
  const doc = documentRef ?? globalThis.document ?? null;
  if (modal == null || doc == null || typeof doc.addEventListener !== 'function') return () => {};
  const handler = (event) => {
    if (modal.requestBackdropDismiss(event) === 'island') {
      event?.preventDefault?.();
      event?.stopPropagation?.();
    }
  };
  doc.addEventListener('pointerdown', handler, true);
  return () => doc.removeEventListener('pointerdown', handler, true);
}
