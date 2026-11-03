// src/components/AttachmentPreviewModal.js — 底层父模态屏（内嵌二级确认弹窗）
import * as ModalStack from "../libs/ModalStack.js";
import * as Navigation from "../libs/Navigation.js";

export function createAttachmentPreviewModal() {
  let isConfirmDeleteOpen = false;
  let isPreviewVisible = true;

  // 父模态框注册关闭句柄
  const unregisterParent = ModalStack.registerModalClose(() => {
    isPreviewVisible = false;
    ModalStack.onModalDidClose({ modalId: "attachment-preview" });
  }, { modalId: "attachment-preview", detachedOverlay: false });

  // 当打开二级删除确认框时，注册第二个阻塞模态框句柄
  let unregisterConfirm = null;
  function openDeleteConfirmDialog() {
    isConfirmDeleteOpen = true;
    unregisterConfirm = ModalStack.registerModalClose((isNavigating) => {
      isConfirmDeleteOpen = false;
      // 如果仅关闭确认弹窗而不等待父预览弹窗隐藏，onModalDidClose 就会提前触发
      ModalStack.onModalDidClose({ modalId: "delete-confirm" });
      if (!isNavigating) {
        Navigation.dismissModal();
      }
    }, { modalId: "delete-confirm", detachedOverlay: false });
  }

  return {
    openDeleteConfirmDialog,
    getState: () => ({ isPreviewVisible, isConfirmDeleteOpen }),
    dispose: () => {
      unregisterConfirm?.();
      unregisterParent();
    },
  };
}
