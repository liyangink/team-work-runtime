// src/pages/AmountStepPage.js — 金额与币种编辑主页面（点击保存才应正式提交）
import * as StateVault from "../store/StateVault.js";

export function createAmountStepController(routeParams = {}) {
  const initialDraft = StateVault.getDraft("IOU_DRAFT");
  const capturedEpoch = routeParams.draftEpoch ?? initialDraft.draftEpoch;
  // 若路由参数带回了待定 currency，应在页面本地预览态持有，直到用户点击 save()
  let pendingCurrency = routeParams.currency ?? initialDraft.currency;
  let pendingAmount = initialDraft.amount;

  return {
    getPreviewState() {
      return {
        amount: pendingAmount,
        currency: pendingCurrency,
        persistedCurrency: StateVault.getDraft("IOU_DRAFT").currency,
        persistedShares: StateVault.getDraft("IOU_DRAFT").splitShares,
      };
    },
    setPendingAmount(val) {
      pendingAmount = val;
    },
    save() {
      return StateVault.mergeDraft(
        "IOU_DRAFT",
        { amount: pendingAmount, currency: pendingCurrency },
        { expectedEpoch: capturedEpoch }
      );
    },
  };
}
