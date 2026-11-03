import * as PopoverRoot from '../popover/PopoverRoot.js';
import * as FocusTrapStack from '../focus/FocusTrapStack.js';

export const REPORT_MENU_ITEMS = ['hide-report', 'copy-permalink', 'open-in-new-window'];
export const SUBMENU_ITEMS = ['assign-to-me', 'snooze-until-tomorrow'];

const menuTargets = new Map();
const openMenus = [];
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

function isTopContiguous(layerIds) {
  const layers = PopoverRoot.getOpenLayers();
  for (let i = 0; i < layerIds.length; i += 1) {
    const layer = layers[layers.length - 1 - i];
    if (layer == null || layer.id !== layerIds[layerIds.length - 1 - i]) return false;
  }
  return true;
}

function closeMenusFrom(startIndex, { restore = true, releaseTraps = true } = {}) {
  const removed = openMenus.slice(startIndex);
  const layerIds = removed.map((menu) => menu.layerId);
  if (!isTopContiguous(layerIds)) {
    return { closed: [], layerIds: [], restored: false, blocked: removed.map((menu) => menu.id) };
  }
  openMenus.splice(startIndex);
  for (const layerId of layerIds) PopoverRoot.closePopoverLayer(layerId);
  const restored = releaseTraps ? FocusTrapStack.releaseFocusTraps(layerIds, { restore }).restored : false;
  return { closed: removed.map((menu) => menu.id), layerIds, restored, blocked: [] };
}

export function registerContextMenuTarget(element, { menuId = 'report-context-menu', items = REPORT_MENU_ITEMS } = {}) {
  if (element == null) return () => {};
  menuTargets.set(element, { menuId, items: [...items] });
  return () => menuTargets.delete(element);
}

export function unregisterContextMenuTarget(element) {
  menuTargets.delete(element);
}

export function resolveMenuTarget(node) {
  if (node == null) return null;
  for (const [element, entry] of menuTargets) {
    if (element === node || containsNode(element, node)) return { ...entry, element };
  }
  return null;
}

export function hasOpenMenus() {
  return openMenus.length > 0;
}

export function hasMenuLayer(layerId) {
  return openMenus.some((menu) => menu.layerId === layerId);
}

export function getOpenMenus() {
  return openMenus.map((menu) => ({ ...menu }));
}

export function openContextMenu({ menuId = null, anchorRef = null, parentId = null, items = REPORT_MENU_ITEMS, onSelect = null } = {}) {
  const id = menuId ?? `report-menu-${++seq}`;
  const layer = PopoverRoot.openPopoverLayer({ id: `menu:${id}`, interactiveMode: PopoverRoot.INTERACTIVE_MODE_CLICK_POPOVER, anchorRef, label: id });
  if (layer == null) return null;
  const entry = { id, layerId: layer.id, anchorRef, parentId, items: [...items], onSelect };
  openMenus.push(entry);
  FocusTrapStack.pushFocusTrap({ layerId: layer.id, anchorRef, reason: layer.id });
  return { ...entry };
}

export function openSubmenu(parentId, { menuId = 'report-submenu', anchorRef = null, items = SUBMENU_ITEMS } = {}) {
  if (!openMenus.some((menu) => menu.id === parentId)) return null;
  return openContextMenu({ menuId, anchorRef, parentId, items });
}

export function closeContextMenu(menuId, options = {}) {
  const index = openMenus.findIndex((menu) => menu.id === menuId);
  if (index === -1) return { closed: [], layerIds: [], restored: false, blocked: [] };
  return closeMenusFrom(index, options);
}

export function closeMenuLayer(layerId, { restore = true, releaseTraps = true } = {}) {
  const top = openMenus[openMenus.length - 1];
  if (top == null || top.layerId !== layerId) return { closed: null, layerIds: [], restored: false, blocked: [layerId] };
  const result = closeMenusFrom(openMenus.length - 1, { restore, releaseTraps });
  return { closed: result.closed[0] ?? null, layerIds: result.layerIds, restored: result.restored, blocked: result.blocked };
}

export function closeTopMenu({ restore = true, releaseTraps = true } = {}) {
  const top = openMenus[openMenus.length - 1];
  if (top == null) return { closed: null, layerIds: [], restored: false, blocked: [] };
  return closeMenuLayer(top.layerId, { restore, releaseTraps });
}

export function closeAllMenus(options = {}) {
  if (openMenus.length === 0) return { closed: [], layerIds: [], restored: false, blocked: [] };
  return closeMenusFrom(0, options);
}

export function handleEscapeKey(event = null) {
  const top = openMenus[openMenus.length - 1];
  if (top == null) return { closed: null, restored: false, remaining: 0, blocked: [] };
  event?.preventDefault?.();
  const result = closeMenuLayer(top.layerId, { restore: true });
  return { closed: result.closed, restored: result.restored, remaining: openMenus.length, blocked: result.blocked };
}

export function selectMenuItem(menuId, itemId) {
  const menu = openMenus.find((item) => item.id === menuId);
  if (menu == null || !menu.items.includes(itemId)) return null;
  const result = closeContextMenu(menuId, { restore: true });
  if (result.closed.length === 0) return null;
  menu.onSelect?.(itemId);
  return { itemId, closed: result.closed, restored: result.restored };
}
