import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth, AuthError } from "../js/auth.js";

// localStorage stand-in
function memoryStorage(init = {}) {
  const data = { ...init };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => (data[k] = String(v)),
    removeItem: (k) => delete data[k],
  };
}

// A stand-in for Supabase Auth: records calls, answers from handlers keyed by path.
function fakeAuthServer(handlers = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const path = url.split("/auth/v1/")[1];
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, path, method: init.method, headers: init.headers, body });
    const h = handlers[path];
    const out = typeof h === "function" ? h(body, init) : h;
    if (out?.status >= 400) return { ok: false, status: out.status, text: async () => JSON.stringify(out.body) };
    return { ok: true, status: 200, text: async () => (out === undefined ? "" : JSON.stringify(out)) };
  };
  return { fetch, calls };
}

const NOW = 1_800_000_000_000; // ms
const session = (n = 1, expiresIn = 3600) => ({
  access_token: `access-${n}`, refresh_token: `refresh-${n}`, expires_in: expiresIn, expires_at: NOW / 1000 + expiresIn,
  token_type: "bearer", user: { id: "user-uuid", email: "anna@example.com", aud: "authenticated" },
});

const make = (handlers, { storage = memoryStorage(), now = () => NOW } = {}) => {
  const server = fakeAuthServer(handlers);
  const auth = new Auth({ url: "https://abc.supabase.co/", anonKey: "anon-key", fetch: server.fetch, storage, now });
  return { auth, calls: server.calls, storage };
};

test("sign up sends email and password, and keeps the session in lh_session", async () => {
  const { auth, calls, storage } = make({ signup: session(1) });
  assert.equal(auth.signedIn, false);
  assert.equal(await auth.token(), null);
  const heard = [];
  auth.onChange((x) => heard.push(x));
  await auth.signUp("  Anna@Example.com ", "longenough");
  assert.equal(calls[0].url, "https://abc.supabase.co/auth/v1/signup");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { email: "anna@example.com", password: "longenough" });
  assert.equal(calls[0].headers.apikey, "anon-key");
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.equal(auth.signedIn, true);
  assert.equal(auth.email, "anna@example.com");
  assert.equal(auth.userId, "user-uuid");
  assert.equal(await auth.token(), "access-1");
  const saved = JSON.parse(storage.data.lh_session);
  assert.deepEqual(Object.keys(saved).sort(), ["access_token", "expires_at", "refresh_token", "user"]);
  assert.equal(saved.refresh_token, "refresh-1");
  assert.deepEqual(heard, [true]);
});

test("a short password is refused before anything is sent", async () => {
  const { auth, calls } = make({ signup: session(1) });
  await assert.rejects(auth.signUp("a@b.co", "short"), (err) => err instanceof AuthError && /at least 8/.test(err.message));
  assert.equal(calls.length, 0);
});

test("sign up with email confirmation still on explains instead of half signing in", async () => {
  const { auth } = make({ signup: { id: "user-uuid", email: "a@b.co", confirmation_sent_at: "now" } });
  await assert.rejects(auth.signUp("a@b.co", "longenough"), /confirmed/);
  assert.equal(auth.signedIn, false);
});

test("sign in uses the password grant; wrong passwords get a friendly message", async () => {
  const { auth, calls } = make({
    "token?grant_type=password": (body) => (body.password === "right-password"
      ? session(2)
      : { status: 400, body: { error: "invalid_grant", error_description: "Invalid login credentials" } }),
  });
  await assert.rejects(auth.signIn("anna@example.com", "wrong-password"), (err) => {
    assert.ok(err instanceof AuthError);
    assert.equal(err.status, 400);
    assert.match(err.message, /don't match/);
    return true;
  });
  await auth.signIn("anna@example.com", "right-password");
  assert.equal(calls[1].url, "https://abc.supabase.co/auth/v1/token?grant_type=password");
  assert.deepEqual(calls[1].body, { email: "anna@example.com", password: "right-password" });
  assert.equal(await auth.token(), "access-2");
});

test("Supabase's different error shapes all become friendly text", async () => {
  const cases = [
    [{ code: 422, error_code: "user_already_exists", msg: "User already registered" }, /already an account/],
    [{ code: 422, error_code: "weak_password", msg: "Password should be at least 8 characters." }, /at least 8/],
    [{ code: 429, error_code: "over_email_send_rate_limit", msg: "email rate limit exceeded" }, /Too many tries/],
    [{ code: 400, error_code: "email_address_invalid", msg: "Email address is invalid" }, /doesn't look right/],
    [{ message: "something new" }, /Something went wrong/],
  ];
  for (const [body, friendly] of cases) {
    const { auth } = make({ signup: { status: body.code || 400, body } });
    await assert.rejects(auth.signUp("a@b.co", "longenough"), friendly, JSON.stringify(body));
  }
  const offline = new Auth({ url: "https://x.supabase.co", anonKey: "k", storage: memoryStorage(), fetch: async () => { throw new TypeError("Failed to fetch"); } });
  await assert.rejects(offline.signIn("a@b.co", "longenough"), /Couldn't connect/);
});

test("forgot password: email a code, verify it, then save the new password with the new session", async () => {
  const { auth, calls } = make({
    recover: {},
    verify: (body) => (body.token === "123456" ? session(3) : { status: 403, body: { error_code: "otp_expired", msg: "Token has expired or is invalid" } }),
    user: { id: "user-uuid", email: "anna@example.com" },
  });
  await auth.sendResetCode(" Anna@example.com");
  assert.equal(calls[0].url, "https://abc.supabase.co/auth/v1/recover");
  assert.deepEqual(calls[0].body, { email: "anna@example.com" });
  assert.equal(auth.signedIn, false);

  await assert.rejects(auth.verifyResetCode("anna@example.com", "111111"), /wrong or has run out/);
  await auth.verifyResetCode("anna@example.com", " 123 456 ");
  assert.deepEqual(calls[2].body, { type: "recovery", email: "anna@example.com", token: "123456" });
  assert.equal(auth.signedIn, true);

  await auth.setPassword("brand-new-password");
  assert.equal(calls[3].url, "https://abc.supabase.co/auth/v1/user");
  assert.equal(calls[3].method, "PUT");
  assert.deepEqual(calls[3].body, { password: "brand-new-password" });
  assert.equal(calls[3].headers.Authorization, "Bearer access-3");
});

test("the token is refreshed shortly before it runs out, once even when asked twice at once", async () => {
  let clock = NOW;
  let refreshes = 0;
  const storage = memoryStorage();
  const { auth, calls } = make({
    "token?grant_type=password": session(1, 3600),
    "token?grant_type=refresh_token": () => (refreshes++, { ...session(2, 3600), expires_at: clock / 1000 + 3600 }),
  }, { storage, now: () => clock });
  await auth.signIn("anna@example.com", "longenough");
  clock += 3000 * 1000; // 50 minutes later: still 10 minutes left
  assert.equal(await auth.token(), "access-1");
  clock += 560 * 1000; // 40 seconds left: refresh first
  const [a, b] = await Promise.all([auth.token(), auth.token()]);
  assert.equal(a, "access-2");
  assert.equal(b, "access-2");
  assert.equal(refreshes, 1);
  const call = calls.find((c) => c.path === "token?grant_type=refresh_token");
  assert.deepEqual(call.body, { refresh_token: "refresh-1" });
  assert.equal(JSON.parse(storage.data.lh_session).refresh_token, "refresh-2");
});

test("a session saved on this phone is picked up on the next visit", async () => {
  const storage = memoryStorage({ lh_session: JSON.stringify({ ...session(5), expires_in: undefined }) });
  const { auth, calls } = make({}, { storage });
  assert.equal(auth.signedIn, true);
  assert.equal(auth.email, "anna@example.com");
  assert.equal(await auth.token(), "access-5");
  assert.equal(calls.length, 0);
  const broken = make({}, { storage: memoryStorage({ lh_session: "{not json" }) });
  assert.equal(broken.auth.signedIn, false);
});

test("another tab's newer session is used instead of spending a refresh token twice", async () => {
  const storage = memoryStorage({ lh_session: JSON.stringify({ ...session(1), expires_at: NOW / 1000 + 10 }) });
  const { auth, calls } = make({ "token?grant_type=refresh_token": session(9) }, { storage });
  // The other tab refreshed and saved
  storage.setItem("lh_session", JSON.stringify({ ...session(2), expires_at: NOW / 1000 + 3600 }));
  assert.equal(await auth.token(), "access-2");
  assert.equal(calls.length, 0);
});

test("a refused refresh signs out; being offline keeps the session for later", async () => {
  const expiring = () => memoryStorage({ lh_session: JSON.stringify({ ...session(1), expires_at: NOW / 1000 + 5 }) });
  const refused = make({ "token?grant_type=refresh_token": { status: 400, body: { error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" } } }, { storage: expiring() });
  const heard = [];
  refused.auth.onChange((x) => heard.push(x));
  assert.equal(await refused.auth.token(), null);
  assert.equal(refused.auth.signedIn, false);
  assert.equal(refused.storage.data.lh_session, undefined);
  assert.deepEqual(heard, [false]);

  const storage = expiring();
  const offline = new Auth({ url: "https://x.supabase.co", anonKey: "k", storage, now: () => NOW, fetch: async () => { throw new TypeError("Failed to fetch"); } });
  assert.equal(await offline.token(), "access-1"); // still valid for 5 seconds: try it
  assert.equal(offline.signedIn, true);
});

test("sign out tells the server, then forgets the session even if the server can't be reached", async () => {
  const storage = memoryStorage({ lh_session: JSON.stringify(session(1)) });
  const { auth, calls } = make({ logout: undefined }, { storage });
  await auth.signOut();
  assert.equal(calls[0].url, "https://abc.supabase.co/auth/v1/logout");
  assert.equal(calls[0].headers.Authorization, "Bearer access-1");
  assert.equal(auth.signedIn, false);
  assert.equal(storage.data.lh_session, undefined);

  const offline = new Auth({ url: "https://x.supabase.co", anonKey: "k", storage: memoryStorage({ lh_session: JSON.stringify(session(1)) }), now: () => NOW, fetch: async () => { throw new TypeError("offline"); } });
  await offline.signOut();
  assert.equal(offline.signedIn, false);
});
