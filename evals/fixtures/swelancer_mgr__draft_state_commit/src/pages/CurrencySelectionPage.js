// src/pages/CurrencySelectionPage.js — 币种选择列表页
import * as StateVault from "../store/StateVault.js";
import * as RouteSerializer from "../navigation/RouteSerializer.js";

/**
 * 当前缺陷实现：
 * 用户在币种列表点击某个币种（如 'JPY'）时，selectCurrency 直接调用了 StateVault.mergeDraft('IOU_DRAFT', { currency })，
 * 然后返回上一页（AmountStepPage）。
 * 这导致用户在 AmountStepPage 尚未点击“保存（Save）”按钮、甚至直接按返回键取消时，
 * IOU_DRAFT 中的 currency 已经被永久篡改，且 splitShares 分摊精度已被不可逆截断！
 */
export function selectCurrencyOption(selectedCurrency, returnToRoute = "/iou/amount") {
  StateVault.mergeDraft("IOU_DRAFT", { currency: selectedCurrency });
  return RouteSerializer.navigateWithParams(returnToRoute, {});
}
