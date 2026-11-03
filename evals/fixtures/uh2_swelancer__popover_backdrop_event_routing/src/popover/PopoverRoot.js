export const INTERACTIVE_MODE_HOVER = 'hover';
export const INTERACTIVE_MODE_CLICK_POPOVER = 'click-popover';

const layers = [];
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

function hitNodesForEvent(event) {
  if (event == null) return [];
  if (typeof event.composedPath === 'function') {
    const path = event.composedPath();
    if (Array.isArray(path) && path.length > 0) return path;
  }
  const doc = event.view?.document ?? globalThis.document ?? null;
  if (doc && typeof doc.elementsFromPoint === 'function') {
    const nodes = doc.elementsFromPoint(event.clientX ?? 0, event.clientY ?? 0);
    if (Array.isArray(nodes) && nodes.length > 0) return nodes;
  }
  return event.target != null ? [event.target] : [];
}

export function getOpenLayers() {
  return layers.map((layer) => ({ ...layer }));
}

export function findTopLayerByMode(mode) {
  for (let i = layers.length - 1; i >= 0; i--) {
    if (layers[i].interactiveMode === mode) return { ...layers[i] };
  }
  return null;
}

export function getTopLayer() {
  return layers.length > 0 ? { ...layers[layers.length - 1] } : null;
}

export function hasLayer(id) {
  return layers.some((layer) => layer.id === id);
}

export function countOpenLayers() {
  return layers.length;
}

export function openPopoverLayer({ id = null, interactiveMode = INTERACTIVE_MODE_CLICK_POPOVER, anchorRef = null, contentRef = null, label = '' } = {}) {
  if (id != null) closePopoverLayer(id);
  if (interactiveMode === INTERACTIVE_MODE_HOVER && findTopLayerByMode(INTERACTIVE_MODE_CLICK_POPOVER) != null) return null;
  if (interactiveMode === INTERACTIVE_MODE_CLICK_POPOVER) closePopoverLayersByMode(INTERACTIVE_MODE_HOVER);
  const layer = { id: id ?? `popover-layer-${++seq}`, interactiveMode, anchorRef, contentRef, label: label || id || '', seq: ++seq };
  layers.push(layer);
  return { ...layer };
}

export function closePopoverLayer(id) {
  const index = layers.findIndex((layer) => layer.id === id);
  if (index === -1) return null;
  return layers.splice(index, 1)[0];
}

export function closePopoverLayersByMode(mode) {
  const kept = [];
  const closed = [];
  for (const layer of layers) (layer.interactiveMode === mode ? closed : kept).push(layer);
  layers.length = 0;
  layers.push(...kept);
  return closed.map((layer) => layer.id);
}

export function closeAllPopoverLayers() {
  const closed = layers.map((layer) => layer.id);
  layers.length = 0;
  return closed;
}

export function closeLayersForAnchor(anchorRef) {
  const ids = layers.filter((layer) => layer.anchorRef === anchorRef).map((layer) => layer.id);
  for (const id of ids) closePopoverLayer(id);
  return ids;
}

export function isEventInsideAnyLayer(event) {
  if (layers.length === 0) return false;
  const nodes = hitNodesForEvent(event);
  if (nodes.length === 0) return false;
  return layers.some((layer) => nodes.some((node) => containsNode(layer.contentRef, node) || containsNode(layer.anchorRef, node)));
}
