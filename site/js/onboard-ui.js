// HTML for the screens before the app: sign up / sign in, forgot password, joining or starting a
// group, and the Home Screen step. Group and member names come from other people, so they go
// through esc().
//
// The autocomplete values matter: they're how iCloud Keychain (and Android's password manager)
// knows to save the password on sign-up and fill it in on sign-in, including inside the Home
// Screen app, which starts out signed out.
import { MIN_PASSWORD } from "./auth.js";
import { initials } from "./logic.js";
import { esc } from "./ui.js";

export const MAX_MEMBERS = 5;

const error = (text) => `<div class="field-error" role="alert" data-gate-error>${esc(text || "")}</div>`;

const emailField = (email, extra = "") =>
  `<input class="field" type="email" name="email" id="gate-email" autocomplete="email" autocapitalize="none" autocorrect="off" spellcheck="false" inputmode="email" required placeholder="Email" aria-label="Email" value="${esc(email || "")}" ${extra}>`;

const passwordField = (kind, placeholder) =>
  `<input class="field" type="password" name="password" id="gate-password" autocomplete="${kind}" minlength="${MIN_PASSWORD}" required placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">`;

const nameList = (names) => names.map((n) => esc(n)).join(", ");

// The line under the title when someone opened an invite link.
function inviteLine(preview) {
  if (!preview) return "";
  const names = (preview.members || []).map((m) => m.name);
  return `<div class="gate-invite">
      <div class="avatars">${names.slice(0, MAX_MEMBERS).map((n) => `<span class="avatar">${esc(initials(n))}</span>`).join("")}</div>
      <div class="small muted">${names.length ? nameList(names) : "Nobody has joined yet"}</div>
    </div>`;
}

// mode: "signup" or "signin". preview: what the invite link opens (or null).
export function authHtml({ mode = "signup", preview = null, email = "", message = "" } = {}) {
  const signup = mode === "signup";
  const title = preview ? `You're invited to <span class="nowrap">${esc(preview.name)}</span>` : signup ? "House Hunt" : "Welcome back";
  const lead = preview
    ? (signup ? "Make an account to join. It takes a few seconds." : "Sign in to join.")
    : (signup ? "Find a student house with your friends. Make an account to start." : "Sign in to get back to your group.");
  return `
    <h2>${title}</h2>
    ${inviteLine(preview)}
    <p class="muted">${lead}</p>
    <form class="gate-form" id="gate-auth" data-mode="${signup ? "signup" : "signin"}" novalidate>
      ${emailField(email)}
      ${passwordField(signup ? "new-password" : "current-password", signup ? `Password (${MIN_PASSWORD}+ characters)` : "Password")}
      ${error(message)}
      <button class="btn btn-ink wide" type="submit">${signup ? "Create account" : "Sign in"}</button>
    </form>
    ${signup ? "" : '<button class="text-link" type="button" data-gate="forgot">Forgot password?</button>'}
    <p class="small muted gate-switch">${signup
      ? 'Already have an account? <button class="text-link" type="button" data-gate="signin">Sign in</button>'
      : 'New here? <button class="text-link" type="button" data-gate="signup">Create an account</button>'}</p>`;
}

// step "email": ask where to send the code. step "code": type the code and a new password.
export function forgotHtml({ step = "email", email = "", message = "" } = {}) {
  if (step === "email") {
    return `
      <h2>Reset your password</h2>
      <p class="muted">We'll email you a 6-digit code.</p>
      <form class="gate-form" id="gate-forgot-email" novalidate>
        ${emailField(email)}
        ${error(message)}
        <button class="btn btn-ink wide" type="submit">Email me a code</button>
      </form>
      <button class="text-link" type="button" data-gate="signin">Back to sign in</button>`;
  }
  return `
    <h2>Check your email</h2>
    <p class="muted">We sent a 6-digit code to <b>${esc(email)}</b>. It can take a minute; check Spam too.</p>
    <form class="gate-form" id="gate-forgot-code" novalidate>
      ${emailField(email, "readonly")}
      <input class="field code" type="text" name="code" id="gate-code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]*" maxlength="6" required placeholder="123456" aria-label="6-digit code">
      ${passwordField("new-password", `New password (${MIN_PASSWORD}+ characters)`)}
      ${error(message)}
      <button class="btn btn-ink wide" type="submit">Save new password</button>
    </form>
    <p class="small muted gate-switch">No email? <button class="text-link" type="button" data-gate="resend">Send a new code</button></p>
    <button class="text-link" type="button" data-gate="signin">Back to sign in</button>`;
}

// Joining from an invite link: tap a name that was added before accounts existed, or type yours.
export function joinHtml({ preview, message = "" }) {
  const open = (preview.members || []).filter((m) => !m.claimed);
  const full = preview.full && !open.length;
  return `
    <h2>Join <span class="nowrap">${esc(preview.name)}</span></h2>
    ${inviteLine(preview)}
    ${full
      ? `<p class="muted">This group already has ${MAX_MEMBERS} people, the most a group can have. Ask them to make room, or start your own.</p>${error(message)}`
      : `${open.length ? `<p class="muted">Are you one of these? Tap your name to get your votes back.</p>
          <div class="name-grid">${open.map((m) => `<button class="btn" type="button" data-claim="${esc(m.name)}">${esc(m.name)}</button>`).join("")}</div>
          <p class="muted small">Not on the list? Type your first name.</p>`
        : '<p class="muted">What should your friends call you?</p>'}
        <form class="gate-form" id="gate-join" novalidate>
          <input class="field" name="name" id="gate-name" autocomplete="given-name" maxlength="20" required placeholder="Your first name" aria-label="Your first name" enterkeyhint="go">
          ${error(message)}
          <button class="btn btn-ink wide" type="submit">Join group</button>
        </form>`}
    <button class="text-link" type="button" data-gate="skip-invite">${full ? "Start my own group" : "Not now"}</button>`;
}

// No invite (or not using it): pick one of my groups, start one, or paste an invite link.
export function startHtml({ groups = [], message = "", pasteMessage = "", canCancel = false } = {}) {
  const pick = groups.length
    ? `<div class="gate-groups">${groups.map((g) => `<button class="gate-group" type="button" data-pick-group="${esc(g.id)}">
          <span><span class="gate-group-name">${esc(g.name)}</span><span class="muted small">You're ${esc(g.me)} · ${Number(g.size) || 1} ${Number(g.size) === 1 ? "person" : "people"}</span></span>
          <i class="ti ti-chevron-right" aria-hidden="true"></i></button>`).join("")}</div>
       <div class="gate-or"><span>${canCancel ? "or open one you're in" : "or start another"}</span></div>`
    : "";
  return `
    <h2>${canCancel ? "Start another group" : groups.length ? "Pick your group" : "Start a group"}</h2>
    ${groups.length ? "" : `<p class="muted">Up to ${MAX_MEMBERS} of you share votes, notes and a shortlist. You'll get a link to send them.</p>`}
    ${pick}
    <form class="gate-form" id="gate-start" novalidate>
      <input class="field" name="group" id="gate-group-name" autocomplete="off" maxlength="40" required placeholder="Group name, like Anna's group" aria-label="Group name">
      <input class="field" name="name" id="gate-my-name" autocomplete="given-name" maxlength="20" required placeholder="Your first name" aria-label="Your first name">
      ${error(message)}
      <button class="btn ${groups.length && !canCancel ? "" : "btn-ink"} wide" type="submit">Start group</button>
    </form>
    <p class="small muted gate-paste-label">Have an invite link? Paste it here.</p>
    <form class="join-form" id="gate-paste" novalidate>
      <input name="invite" placeholder="Paste invite link" aria-label="Invite link" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go">
      <button class="btn" type="submit" style="padding:9px 16px">Join</button>
    </form>
    <div class="field-error" role="alert" data-paste-error>${esc(pasteMessage)}</div>
    ${canCancel ? '<button class="text-link" type="button" data-gate="cancel">Back to the app</button>' : '<button class="text-link" type="button" data-gate="signout">Sign out</button>'}`;
}

// The iPhone steps, as small pictures of the buttons to tap. Shared with the Group tab.
export function iosStepsHtml() {
  const step = (n, icon, text) => `<li class="install-step"><span class="install-num">${n}</span><span class="install-icon"><i class="ti ti-${icon}" aria-hidden="true"></i></span><span>${text}</span></li>`;
  return `<ol class="install-steps">
      ${step(1, "share", "Tap <b>Share</b>. In Safari it's at the bottom of the screen (or at the top on iPad). If you don't see it, tap the <b>⋯</b> menu first.")}
      ${step(2, "square-plus", "Scroll down and tap <b>Add to Home Screen</b>.")}
      ${step(3, "circle-check", "Tap <b>Add</b>, then open <b>House Hunt</b> from your Home Screen.")}
      ${step(4, "key", "Sign in once there. Your iPhone fills in your password for you.")}
    </ol>`;
}

// state: from install.js (only "ios-safari" and "android-prompt" get this screen).
export function installHtml(state) {
  const ios = state === "ios-safari";
  return `
    <div class="install-badge"><img src="apple-touch-icon.png" alt="" width="72" height="72"></div>
    <h2>Put it on your Home Screen</h2>
    <p class="muted">${ios
      ? "It opens like an app, full screen, and it's the only way an iPhone can get alerts about new houses."
      : "It opens like an app, and alerts about new houses come straight to your phone."}</p>
    ${ios ? iosStepsHtml() : '<button class="btn btn-ink wide" type="button" data-gate="install"><i class="ti ti-download" aria-hidden="true"></i> Install House Hunt</button>'}
    <button class="text-link" type="button" data-gate="skip-install">Skip, use it in the browser</button>`;
}

// Something went wrong before the app could open (offline, say): explain and offer a retry.
export function problemHtml(message) {
  return `
    <h2>Can't open your group</h2>
    <p class="muted">${esc(message)}</p>
    <button class="btn btn-ink wide" type="button" data-gate="retry">Try again</button>
    <button class="text-link" type="button" data-gate="signout">Sign out</button>`;
}
