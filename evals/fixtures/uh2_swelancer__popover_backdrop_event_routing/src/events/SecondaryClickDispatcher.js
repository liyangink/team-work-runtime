import * as PopoverRoot from '../popover/PopoverRoot.js';
import * as ReportContextMenu from '../contextmenu/ReportContextMenu.js';
import * as FloatingActionTrigger from '../fab/FloatingActionTrigger.js';
import * as FocusTrapStack from '../focus/FocusTrapStack.js';

export const PASSTHROUGH_ATTRIBUTE = 'data-passthrough-overlay';

export function elementsFromPoint(documentRef, x, y) {
  const doc = documentRef ?? globalThis.document ?? null;
  if (doc == null || typeof doc.elementsFromPoint !== 'function') return [];
  const nodes = doc.elementsFromPoint(x, y);
  return Array.isArray(nodes) ? nodes : [];
}

function readPassthroughFlag(node) {
  if (node == null) return null;
  const dataset = node.dataset ?? null;
  if (dataset != null && dataset.passthroughOverlay != null) return dataset.passthroughOverlay;
  if (typeof node.getAttribute === 'function') return node.getAttribute(PASSTHROUGH_ATTRIBUTE);
  return null;
}

export function isPassthroughNode(node) {
  if (node == null) return false;
  const flag = readPassthroughFlag(node);
  if (flag != null && String(flag).toLowerCase() === 'true') return true;
  if (typeof node.classList?.contains === 'function' && node.classList.contains('overlay-passthrough')) return true;
  return (node.style?.pointerEvents ?? null) === 'none';
}

export function hitTest({ event = null, document: documentRef = null, point = null } = {}) {
  const x = point?.x ?? event?.clientX ?? 0;
  const y = point?.y ?? event?.clientY ?? 0;
  const stack = elementsFromPoint(documentRef, x, y);
  if (stack.length === 0 && event?.target != null) stack.push(event.target);
  for (const node of stack) {
    const menuTarget = ReportContextMenu.resolveMenuTarget(node);
    if (menuTarget != null) return { menuTarget, node, stack, stoppedAt: null };
    if (!isPassthroughNode(node)) return { menuTarget: null, node: null, stack, stoppedAt: node };
  }
  return { menuTarget: null, node: null, stack, stoppedAt: null };
}

export function closeMenusAndBlockingLayers({ restore = false } = {}) {
  const closedMenus = [];
  const closedLayerIds = [];
  let guard = 0;
  while (ReportContextMenu.getOpenMenus().length > 0 && guard < 64) {
    const top = PopoverRoot.getTopLayer();
    if (top == null) break;
    if (ReportContextMenu.hasMenuLayer(top.id)) {
      const result = ReportContextMenu.closeMenuLayer(top.id, { restore: false, releaseTraps: false });
      if (result.closed == null) break;
      closedMenus.push(result.closed);
      closedLayerIds.push(...result.layerIds);
    } else if (FloatingActionTrigger.hasTriggerLayer(top.id)) {
      const result = FloatingActionTrigger.closeLayer(top.id, { restore: false, releaseTraps: false });
      if (result.closed == null) break;
      closedLayerIds.push(top.id);
    } else {
      PopoverRoot.closePopoverLayer(top.id);
      closedLayerIds.push(top.id);
    }
    guard += 1;
  }
  const trap = FocusTrapStack.releaseFocusTraps(closedLayerIds, { restore: restore && closedLayerIds.length > 0 });
  return { closedMenus, restored: trap.restored, closedLayerIds };
}

export function dispatchSecondaryClick(event, { document: documentRef = null } = {}) {
  const result = hitTest({ event, document: documentRef });
  if (result.menuTarget != null) {
    event?.preventDefault?.();
    const closed = closeMenusAndBlockingLayers({ restore: false });
    const anchorRef = result.menuTarget.element ?? result.node ?? event?.target ?? null;
    const opened = ReportContextMenu.openContextMenu({ menuId: result.menuTarget.menuId, anchorRef, items: result.menuTarget.items });
    return {
      closeExisting: closed.closedMenus.length > 0,
      openNewCustom: opened != null,
      allowNativeMenu: false,
      restoreFocus: false,
      menuId: opened?.id ?? null,
      closedMenus: closed.closedMenus,
      stoppedAt: null,
    };
  }
  const closed = closeMenusAndBlockingLayers({ restore: true });
  return {
    closeExisting: closed.closedMenus.length > 0,
    openNewCustom: false,
    allowNativeMenu: true,
    restoreFocus: closed.restored,
    closedMenus: closed.closedMenus,
    stoppedAt: result.stoppedAt ?? null,
  };
}

export function bindSecondaryClickDispatcher({ document: documentRef = null, host = null } = {}) {
  const doc = documentRef ?? globalThis.document ?? null;
  const listenerHost = host ?? doc;
  if (listenerHost == null || typeof listenerHost.addEventListener !== 'function') return () => {};
  const handler = (event) => dispatchSecondaryClick(event, { document: doc });
  listenerHost.addEventListener('contextmenu', handler);
  return () => listenerHost.removeEventListener('contextmenu', handler);
}
