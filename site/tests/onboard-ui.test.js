import { test } from "node:test";
import assert from "node:assert/strict";
import { authHtml, forgotHtml, installHtml, joinHtml, startHtml } from "../js/onboard-ui.js";

const EVIL = '<img src=x onerror="alert(1)">';
const autocomplete = (html, id) => new RegExp(`id="${id}"[^>]*autocomplete="([^"]+)"|autocomplete="([^"]+)"[^>]*id="${id}"`).exec(html)?.slice(1).find(Boolean);

test("password fields say which password they are, so iCloud Keychain saves and fills them", () => {
  const signup = authHtml({ mode: "signup" });
  assert.equal(autocomplete(signup, "gate-email"), "email");
  assert.equal(autocomplete(signup, "gate-password"), "new-password");
  assert.match(signup, /type="email"/);
  assert.match(signup, /Create account/);
  const signin = authHtml({ mode: "signin" });
  assert.equal(autocomplete(signin, "gate-password"), "current-password");
  assert.match(signin, /Forgot password\?/);
  const code = forgotHtml({ step: "code", email: "anna@example.com" });
  assert.equal(autocomplete(code, "gate-code"), "one-time-code");
  assert.equal(autocomplete(code, "gate-password"), "new-password");
  assert.match(code, /inputmode="numeric"/);
  assert.match(code, /value="anna@example.com"/); // the email goes with the new password
});

test("other people's group and member names can't inject markup", () => {
  const preview = { name: EVIL, members: [{ name: EVIL, claimed: false }, { name: "Julie", claimed: true }], full: false };
  for (const html of [
    authHtml({ preview }),
    joinHtml({ preview }),
    startHtml({ groups: [{ id: EVIL, name: EVIL, me: EVIL, size: 2 }], message: EVIL }),
    forgotHtml({ step: "code", email: EVIL }),
  ]) {
    assert.ok(!html.includes("<img"), html);
    assert.ok(html.includes("&lt;img"));
  }
});

test("the join screen offers unclaimed names to tap, and explains a full group", () => {
  const preview = { name: "Anna's group", members: [{ name: "Anna", claimed: false }, { name: "Julie", claimed: true }], full: false };
  const html = joinHtml({ preview });
  assert.match(html, /data-claim="Anna"/);
  assert.ok(!html.includes('data-claim="Julie"')); // someone already signed in as Julie
  assert.match(html, /autocomplete="given-name"/);
  const full = joinHtml({ preview: { name: "Full house", members: [1, 2, 3, 4, 5].map((n) => ({ name: `P${n}`, claimed: true })), full: true } });
  assert.match(full, /already has 5 people/);
  assert.ok(!full.includes("gate-join"));
  assert.match(full, /Start my own group/);
});

test("the Home Screen step: iPhone shows Share or the ⋯ menu; Android gets one button; both can skip", () => {
  const ios = installHtml("ios-safari");
  assert.match(ios, /Share/);
  assert.match(ios, /⋯/);
  assert.match(ios, /Add to Home Screen/);
  assert.ok(!ios.includes('data-gate="install"'));
  const android = installHtml("android-prompt");
  assert.match(android, /data-gate="install"/);
  for (const html of [ios, android]) assert.match(html, /data-gate="skip-install"[^>]*>Skip, use it in the browser/);
});

test("the start screen lists my groups, or invites me to start one", () => {
  const none = startHtml({ groups: [] });
  assert.match(none, /<h2>Start a group<\/h2>/);
  assert.match(none, /id="gate-paste"/);
  assert.match(none, /data-gate="signout"/);
  const some = startHtml({ groups: [{ id: "g1", name: "Anna's group", me: "Anna", size: 5 }], canCancel: true });
  assert.match(some, /Start another group/);
  assert.match(startHtml({ groups: [{ id: "g1", name: "x", me: "y", size: 1 }] }), /Pick your group/);
  assert.match(some, /data-pick-group="g1"/);
  assert.match(some, /You're Anna · 5 people/);
  assert.match(some, /data-gate="cancel"/);
});
