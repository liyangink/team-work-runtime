// src/libs/ModalStack.js
import { notifyOverlayObservers } from "./OverlayBus.js";

const closeModals = [];
let onModalClose = null;
let isNavigatingFlag = false;
let activeTransactionId = 0;

export function registerModalClose(closeHandler, options = {}) {
  const entry = {
    closeHandler,
    detachedOverlay: Boolean(options.detachedOverlay),
    modalId: options.modalId ?? "anonymous-modal",
  };
  closeModals.push(entry);
  return () => {
    const idx = closeModals.indexOf(entry);
    if (idx !== -1) closeModals.splice(idx, 1);
  };
}

export function close(onModalCloseCallback, isNavigating = true) {
  const txId = ++activeTransactionId;
  const blockingModals = closeModals.filter((m) => !m.detachedOverlay);
  if (blockingModals.length === 0) {
    if (typeof onModalCloseCallback === "function") onModalCloseCallback();
    return txId;
  }
  onModalClose = onModalCloseCallback;
  isNavigatingFlag = Boolean(isNavigating);
  for (let i = blockingModals.length - 1; i >= 0; i--) {
    blockingModals[i].closeHandler(isNavigatingFlag, txId);
  }
  return txId;
}

export function onModalDidClose(options = {}) {
  if (options.detachedOverlay) {
    notifyOverlayObservers("detached-closed", options.modalId);
    return;
  }
  if (options.txId !== undefined && options.txId !== activeTransactionId) {
    // 过期事务的延迟隐藏事件，不得触发当前轮次的 onModalClose
    return;
  }
  if (!onModalClose) {
    return;
  }
  const cb = onModalClose;
  onModalClose = null;
  isNavigatingFlag = false;
  cb();
}

export function getRegisteredEntries() {
  return [...closeModals];
}
