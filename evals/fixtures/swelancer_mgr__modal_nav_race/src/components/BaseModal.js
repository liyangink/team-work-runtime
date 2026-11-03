// src/components/BaseModal.js
import * as ModalStack from "../libs/ModalStack.js";
import * as Navigation from "../libs/Navigation.js";

export function mountBaseModal({ modalId, detachedOverlay = false, onHide }) {
  let visible = true;
  let lastTxId = undefined;

  const unregister = ModalStack.registerModalClose((isNavigating, txId) => {
    visible = false;
    lastTxId = txId;
    if (!detachedOverlay) {
      Navigation.setTransitionLock(true);
    }
    queueMicrotask(() => {
      if (!detachedOverlay) {
        Navigation.setTransitionLock(false);
      }
      onHide?.(isNavigating, lastTxId);
      ModalStack.onModalDidClose({ modalId, detachedOverlay, txId: lastTxId });
    });
  }, { modalId, detachedOverlay });

  return {
    isVisible: () => visible,
    dispose: () => unregister(),
  };
}
