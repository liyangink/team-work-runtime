// src/libs/Navigation.js
import * as ModalStack from "./ModalStack.js";

const routeStack = [{ name: "WorkspaceHome", isModalScreen: false }];
let transitionLocked = false;

export function setTransitionLock(locked) {
  transitionLocked = Boolean(locked);
}

export function navigate(route, options = {}) {
  if (transitionLocked) {
    throw new Error("NAVIGATION_LOCKED_DURING_MODAL_ANIMATION");
  }
  routeStack.push({
    name: route,
    isModalScreen: Boolean(options.isModalScreen),
  });
}

export function dismissModal() {
  if (routeStack.length > 1) {
    routeStack.pop();
  }
}

export function openQuickSwitcherShortcut() {
  ModalStack.close(() => {
    navigate("/quick-switcher", { isModalScreen: true });
  }, true);
}

export function getRouteStack() {
  return [...routeStack];
}
