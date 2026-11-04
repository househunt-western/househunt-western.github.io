import { test } from "node:test";
import assert from "node:assert/strict";
import { captureInstallPrompt, currentInstallState, installState, promptInstall } from "../js/install.js";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

test("installState: the Home Screen app first, then Android's prompt, then iPhone steps", () => {
  assert.equal(installState({ standalone: true, ios: true, prompt: false }), "installed");
  assert.equal(installState({ standalone: true, ios: false, prompt: true }), "installed");
  assert.equal(installState({ standalone: false, ios: false, prompt: true }), "android-prompt");
  assert.equal(installState({ standalone: false, ios: true, prompt: false }), "ios-safari");
  assert.equal(installState({ standalone: false, ios: false, prompt: false }), "other");
});

// A pretend window: user agent, display mode, and event listeners we can fire.
function fakeWindow({ ua, standalone = false, touch = 0 }) {
  const listeners = {};
  return {
    navigator: { userAgent: ua, maxTouchPoints: touch, standalone: standalone || undefined },
    matchMedia: (q) => ({ matches: q === "(display-mode: standalone)" && standalone }),
    addEventListener: (type, fn) => (listeners[type] ||= []).push(fn),
    fire: (type, e = {}) => (listeners[type] || []).forEach((fn) => fn(e)),
  };
}

test("real phones and browsers land in the right state", () => {
  const iphone = fakeWindow({ ua: IPHONE });
  assert.equal(currentInstallState(captureInstallPrompt(iphone), iphone), "ios-safari");
  const homeScreen = fakeWindow({ ua: IPHONE, standalone: true });
  assert.equal(currentInstallState(captureInstallPrompt(homeScreen), homeScreen), "installed");
  const ipad = fakeWindow({ ua: MAC, touch: 5 }); // iPads say Macintosh
  assert.equal(currentInstallState(captureInstallPrompt(ipad), ipad), "ios-safari");
  const mac = fakeWindow({ ua: MAC });
  assert.equal(currentInstallState(captureInstallPrompt(mac), mac), "other");
  const android = fakeWindow({ ua: ANDROID });
  assert.equal(currentInstallState(captureInstallPrompt(android), android), "other"); // until Chrome offers
});

test("Chrome's install offer is kept, shown on tap, and works once", async () => {
  const win = fakeWindow({ ua: ANDROID });
  const holder = captureInstallPrompt(win);
  let heard = 0;
  holder.listeners.push(() => heard++);
  let prevented = false;
  let shown = 0;
  win.fire("beforeinstallprompt", {
    preventDefault: () => (prevented = true),
    prompt: async () => shown++,
    userChoice: Promise.resolve({ outcome: "accepted" }),
  });
  assert.equal(prevented, true); // our button, not Chrome's mini-bar
  assert.equal(heard, 1);
  assert.equal(currentInstallState(holder, win), "android-prompt");
  assert.equal(await promptInstall(holder), true);
  assert.equal(shown, 1);
  assert.equal(currentInstallState(holder, win), "other");
  assert.equal(await promptInstall(holder), false); // used up
  assert.equal(shown, 1);
});

test("saying no, or installing from Chrome's menu, both drop the offer", async () => {
  const win = fakeWindow({ ua: ANDROID });
  const holder = captureInstallPrompt(win);
  const offer = () => win.fire("beforeinstallprompt", { preventDefault() {}, prompt: async () => {}, userChoice: Promise.resolve({ outcome: "dismissed" }) });
  offer();
  assert.equal(await promptInstall(holder), false);
  offer();
  win.fire("appinstalled");
  assert.equal(holder.prompt, null);
});
