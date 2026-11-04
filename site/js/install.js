// Getting the app onto the phone's Home Screen. installState() is pure, so tests cover every case.
//
// - Android Chrome fires beforeinstallprompt: we keep it, and the Install button replays it.
// - iPhone can't be prompted by any website: we show where Share (or the ⋯ menu) is, then
//   Add to Home Screen.
import { isIos, isStandalone } from "./push.js";

export { isIos, isStandalone };

// "installed": opened from the Home Screen icon. "android-prompt": one tap installs it.
// "ios-safari": show the iPhone steps. "other": a computer, or a browser that can't install.
export function installState({ standalone, ios, prompt }) {
  if (standalone) return "installed";
  if (prompt) return "android-prompt";
  if (ios) return "ios-safari";
  return "other";
}

// Chrome fires beforeinstallprompt once, early, so start listening before anything else.
export function captureInstallPrompt(win = globalThis) {
  const holder = { prompt: null, listeners: [] };
  win.addEventListener?.("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep Chrome's own mini-bar away; our button shows it instead
    holder.prompt = e;
    holder.listeners.forEach((fn) => fn());
  });
  win.addEventListener?.("appinstalled", () => {
    holder.prompt = null;
    holder.listeners.forEach((fn) => fn());
  });
  return holder;
}

// Show Chrome's install dialog. Resolves true if they installed it. Each prompt works once.
export async function promptInstall(holder) {
  const e = holder.prompt;
  if (!e) return false;
  holder.prompt = null;
  await e.prompt();
  const choice = await e.userChoice;
  return choice?.outcome === "accepted";
}

export function currentInstallState(holder, win = globalThis) {
  return installState({ standalone: isStandalone(win), ios: isIos(win.navigator), prompt: Boolean(holder?.prompt) });
}
