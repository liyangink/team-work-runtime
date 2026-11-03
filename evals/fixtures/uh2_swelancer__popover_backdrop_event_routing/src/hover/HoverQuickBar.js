import * as PopoverRoot from '../popover/PopoverRoot.js';

export const DEFAULT_HOVER_ACTIONS = ['reply', 'assign-to-me', 'mark-read'];

function hasClickPopoverLayer() {
  return PopoverRoot.getOpenLayers().some((layer) => layer.interactiveMode === PopoverRoot.INTERACTIVE_MODE_CLICK_POPOVER);
}

export function createHoverQuickBar({ messageId = null, messageRef = null, actions = DEFAULT_HOVER_ACTIONS, graceMs = 120, schedule = null } = {}) {
  const id = messageId ?? `message-${Math.random().toString(36).slice(2, 8)}`;
  const layerId = `hover:${id}`;
  const setTimer = schedule?.setTimeout ?? setTimeout;
  const clearTimer = schedule?.clearTimeout ?? clearTimeout;
  let dismissTimer = null;

  function openOnPointerEnter() {
    if (hasClickPopoverLayer()) return null;
    if (dismissTimer != null) {
      clearTimer(dismissTimer);
      dismissTimer = null;
    }
    return PopoverRoot.openPopoverLayer({ id: layerId, interactiveMode: PopoverRoot.INTERACTIVE_MODE_HOVER, anchorRef: messageRef, label: id });
  }

  function dismissOnPointerLeave() {
    if (dismissTimer != null) return 'pending';
    dismissTimer = setTimer(() => {
      dismissTimer = null;
      if (hasClickPopoverLayer()) return;
      PopoverRoot.closePopoverLayer(layerId);
    }, graceMs);
    return 'scheduled';
  }

  function dispose() {
    if (dismissTimer != null) {
      clearTimer(dismissTimer);
      dismissTimer = null;
    }
    PopoverRoot.closePopoverLayer(layerId);
  }

  return {
    id,
    layerId,
    actions: [...actions],
    messageRef,
    openOnPointerEnter,
    dismissOnPointerLeave,
    isOpen: () => PopoverRoot.hasLayer(layerId),
    isSuppressedByClickLayer: hasClickPopoverLayer,
    dispose,
  };
}
