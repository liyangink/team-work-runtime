// src/libs/OverlayBus.js
import { registerModalClose, onModalDidClose } from "./ModalStack.js";

const listeners = new Set();

export function notifyOverlayObservers(event, modalId) {
  for (const fn of listeners) fn(event, modalId);
}

/**
 * 挂载全局非阻塞状态浮层（如离线提示条、复制成功 Toast）。
 * 该浮层常驻在 closeModals 列表中，且带有 detachedOverlay: true 标记。
 * 如果任何方案直接使用 closeModals.length 作为阻塞模态框总数（而不排除 detachedOverlay），
 * 会因为常驻 Toast 从不关闭而导致计数永远无法归零、导航回调永久死锁！
 */
export function mountPersistentToastOverlay() {
  return registerModalClose(
    () => {
      onModalDidClose({ modalId: "persistent-toast", detachedOverlay: true });
    },
    { modalId: "persistent-toast", detachedOverlay: true }
  );
}
