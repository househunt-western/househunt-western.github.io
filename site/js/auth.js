// Accounts: email + password through Supabase Auth, with plain fetch (no library).
//
// The session (access token, refresh token, when it expires) is kept in localStorage under
// lh_session. token() hands out the access token for the group database, refreshing it first if
// it's about to run out, so a phone that's been closed for a week just carries on.
//
// Forgot password: sendResetCode(email) emails a 6-digit code, verifyResetCode(email, code)
// signs in with it, then setPassword(newPassword) saves the new password.

const SESSION_KEY = "lh_session";
const EARLY_S = 60; // refresh this many seconds before the token runs out
export const MIN_PASSWORD = 8;

const FRIENDLY = [
  [/invalid login credentials/i, "That email and password don't match. Check them, or tap Forgot password."],
  [/already (registered|been registered)|user_already_exists/i, "There's already an account with this email. Sign in instead."],
  [/password should be at least|weak_password/i, `Use at least ${MIN_PASSWORD} characters for your password.`],
  [/should be different|same_password/i, "Pick a password you haven't used here before."],
  [/token has expired|otp_expired|invalid otp/i, "That code is wrong or has run out. Send a new one."],
  [/rate limit|too many|over_email_send_rate_limit/i, "Too many tries. Wait a minute, then try again."],
  [/invalid format|validate email|email_address_invalid/i, "That email address doesn't look right."],
  [/email not confirmed/i, "This account still needs its email confirmed. Check your inbox for the link."],
  [/signups not allowed|signup_disabled/i, "New accounts are turned off right now."],
];

export class AuthError extends Error {
  constructor(raw, status = 0) {
    const match = FRIENDLY.find(([re]) => re.test(raw));
    super(match ? match[1] : status ? "Something went wrong signing in. Try again." : "Couldn't connect. Check your connection and try again.");
    this.raw = raw;
    this.status = status;
  }
}

export const cleanEmail = (email) => String(email ?? "").trim().toLowerCase();

export class Auth {
  constructor({ url, anonKey, fetch = globalThis.fetch?.bind(globalThis), storage = globalThis.localStorage, now = () => Date.now() }) {
    this.base = url.replace(/\/+$/, "");
    this.anonKey = anonKey;
    this.fetch = fetch;
    this.storage = storage;
    this.now = now;
    this.refreshing = null;
    this.listeners = [];
    this.session = this._read();
  }

  get signedIn() {
    return Boolean(this.session?.refresh_token);
  }

  get email() {
    return this.session?.user?.email || null;
  }

  get userId() {
    return this.session?.user?.id || null;
  }

  // fn(signedIn) — called when signing in or out (including a session that can't be refreshed)
  onChange(fn) {
    this.listeners.push(fn);
  }

  _read() {
    try {
      const raw = this.storage?.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null; // private browsing or corrupted: signed out
    }
  }

  _save(body) {
    const before = this.signedIn;
    if (body?.access_token) {
      const expiresAt = body.expires_at ?? Math.floor(this.now() / 1000) + (body.expires_in ?? 3600);
      this.session = {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: expiresAt,
        user: { id: body.user?.id ?? null, email: body.user?.email ?? null },
      };
    } else {
      this.session = null;
    }
    try {
      if (this.session) this.storage?.setItem(SESSION_KEY, JSON.stringify(this.session));
      else this.storage?.removeItem(SESSION_KEY);
    } catch {
      // storage blocked: the session lasts until the page closes
    }
    if (before !== this.signedIn) this.listeners.forEach((fn) => fn(this.signedIn));
  }

  async _call(path, { method = "POST", body, token } = {}) {
    const headers = { "Content-Type": "application/json", apikey: this.anonKey };
    if (token) headers.Authorization = `Bearer ${token}`;
    let resp;
    try {
      resp = await this.fetch(`${this.base}/auth/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (err) {
      throw new AuthError(String(err)); // offline, DNS, etc.
    }
    const text = await resp.text();
    let out = null;
    try {
      out = text ? JSON.parse(text) : null;
    } catch {
      out = text;
    }
    if (!resp.ok) {
      // Supabase Auth says what went wrong in one of these, depending on the version
      const raw = [out?.error_code, out?.code, out?.msg, out?.message, out?.error_description, out?.error]
        .filter((x) => typeof x === "string").join(" ") || `HTTP ${resp.status}`;
      throw new AuthError(raw, resp.status);
    }
    return out;
  }

  async signUp(email, password) {
    if (String(password ?? "").length < MIN_PASSWORD) throw new AuthError("password should be at least", 400);
    const body = await this._call("signup", { body: { email: cleanEmail(email), password } });
    // With "Confirm email" off, signing up signs you straight in
    if (!body?.access_token) throw new AuthError("email not confirmed", 400);
    this._save(body);
  }

  async signIn(email, password) {
    this._save(await this._call("token?grant_type=password", { body: { email: cleanEmail(email), password } }));
  }

  async sendResetCode(email) {
    await this._call("recover", { body: { email: cleanEmail(email) } });
  }

  // The 6-digit code from the email signs you in, so the new password can be saved next.
  async verifyResetCode(email, code) {
    const token = String(code ?? "").replace(/\s+/g, "");
    this._save(await this._call("verify", { body: { type: "recovery", email: cleanEmail(email), token } }));
  }

  async setPassword(password) {
    if (String(password ?? "").length < MIN_PASSWORD) throw new AuthError("password should be at least", 400);
    const token = await this.token();
    if (!token) throw new AuthError("token has expired", 401);
    await this._call("user", { method: "PUT", body: { password }, token });
  }

  // One refresh at a time, even if several database calls ask at once.
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this._refresh().finally(() => (this.refreshing = null));
    }
    return this.refreshing;
  }

  async _refresh() {
    // Another tab may have refreshed already (each refresh token works once): use its session
    const latest = this._read();
    if (latest?.refresh_token && latest.refresh_token !== this.session?.refresh_token) {
      this.session = latest;
      if (!this._expiring()) return;
    }
    if (!this.session?.refresh_token) return;
    try {
      this._save(await this._call("token?grant_type=refresh_token", { body: { refresh_token: this.session.refresh_token } }));
    } catch (err) {
      // The server said no (signed out elsewhere, or a very old session): sign in again.
      // Offline: keep the session and try again next time.
      if (err.status >= 400 && err.status < 500) this._save(null);
      else throw err;
    }
  }

  _expiring() {
    return !this.session?.expires_at || this.session.expires_at - EARLY_S <= this.now() / 1000;
  }

  // The access token for the group database, or null when signed out.
  async token() {
    if (!this.signedIn) return null;
    if (this._expiring()) {
      try {
        await this.refresh();
      } catch {
        // offline: an unexpired token still works, an expired one is refused by the server anyway
      }
    }
    return this.session?.access_token ?? null;
  }

  // Ends the session on the server too, so the refresh token can't be used again.
  async signOut() {
    const token = this.session?.access_token;
    try {
      if (token) await this._call("logout", { body: {}, token });
    } catch {
      // signed out on this phone either way
    }
    this._save(null);
  }
}
