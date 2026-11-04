import { test } from "node:test";
import assert from "node:assert/strict";
import { GroupError, SupabaseGroupStore, makeInvite } from "../js/supabase-store.js";

// A stand-in for the Supabase server: records calls and answers like PostgREST would.
function fakeServer(handlers = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    const name = url.split("/rpc/")[1];
    const body = JSON.parse(init.body);
    calls.push({ url, name, body, headers: init.headers, method: init.method });
    const h = handlers[name];
    const out = typeof h === "function" ? h(body) : h;
    if (out instanceof Error) {
      return { ok: false, status: 400, text: async () => JSON.stringify({ code: "P0001", message: out.message }) };
    }
    return { ok: true, status: 200, text: async () => (out === undefined ? "" : JSON.stringify(out)) };
  };
  return { fetch, calls };
}

// Stands in for auth.js: hands out a fixed token, or null when signed out.
const signedIn = (token = "user-jwt") => ({ token: async () => token });
const GROUP = "6f1c0a9e-1111-4222-8333-944455556666";

const STATE = {
  id: GROUP,
  name: "Anna's group",
  invite: "AnnaInvite_2027-x",
  me: "Paxton",
  members: ["Paxton", "Jordan", "Maya", "Sam"],
  votes: { "western_och:1": { Jordan: "like" } },
  notes: {},
  status: {},
  budgets: { Jordan: 1100 },
};

const make = (handlers, { auth = signedIn(), group = GROUP } = {}) => {
  const server = fakeServer({ get_group_state: STATE, ...handlers });
  const store = new SupabaseGroupStore({
    url: "https://abc.supabase.co/", anonKey: "anon-key", group, auth, fetch: server.fetch, env: {},
  });
  return { store, calls: server.calls };
};

test("load calls get_group_state with the group and the signed-in person's token", async () => {
  const { store, calls } = make();
  const state = await store.load();
  assert.equal(calls[0].url, "https://abc.supabase.co/rest/v1/rpc/get_group_state");
  assert.equal(calls[0].method, "POST");
  assert.deepEqual(calls[0].body, { p_group: GROUP });
  assert.equal(calls[0].headers.apikey, "anon-key");
  assert.equal(calls[0].headers.Authorization, "Bearer user-jwt");
  assert.deepEqual(store.members, ["Paxton", "Jordan", "Maya", "Sam"]);
  assert.deepEqual(store.info, { id: GROUP, name: "Anna's group", invite: "AnnaInvite_2027-x", me: "Paxton" });
  assert.deepEqual(state.votes, STATE.votes);
  assert.equal(store.shared, true);
});

test("each change calls its function with the exact parameter names, and never says who I am", async () => {
  const { store, calls } = make({
    group_vote: undefined, group_set_status: undefined, group_add_note: true, group_set_budget: true,
    group_save_scorecard: undefined, save_push_sub: undefined,
  });
  await store.load();
  await store.vote("western_och:1", "Paxton", "like");
  await store.vote("western_och:1", "Paxton", null);
  await store.setStatus("western_och:1", "viewing", "Paxton");
  assert.equal(await store.addNote("western_och:1", "Paxton", "  call landlord  "), true);
  assert.equal(await store.setBudget("Paxton", "1150.4"), true);
  assert.equal(await store.saveScorecard("western_och:1", "Paxton", { ratings: { kitchen: 4 } }), true);
  const sub = { endpoint: "https://web.push.apple.com/abc", keys: { p256dh: "p", auth: "a" } };
  await store.savePushSub("Paxton", sub);
  const sent = calls.slice(1).map((c) => [c.name, c.body]);
  assert.deepEqual(sent.slice(0, 5), [
    ["group_vote", { p_group: GROUP, p_key: "western_och:1", p_vote: "like" }],
    ["group_vote", { p_group: GROUP, p_key: "western_och:1", p_vote: null }],
    ["group_set_status", { p_group: GROUP, p_key: "western_och:1", p_status: "viewing" }],
    ["group_add_note", { p_group: GROUP, p_key: "western_och:1", p_text: "call landlord" }],
    ["group_set_budget", { p_group: GROUP, p_amount: 1150 }],
  ]);
  assert.equal(sent[5][0], "group_save_scorecard");
  assert.deepEqual(Object.keys(sent[5][1]), ["p_group", "p_key", "p_card"]);
  assert.deepEqual(sent[6], ["save_push_sub", { p_group: GROUP, p_sub: sub }]);
  // The server works out the member from the token: no call sends p_member or the old p_code
  for (const c of calls) assert.ok(!("p_member" in c.body) && !("p_code" in c.body), c.name);
  // ...but my own changes still show under my name straight away
  assert.equal(store.state.status["western_och:1"].by, "Paxton");
  assert.equal(store.state.notes["western_och:1"][0].member, "Paxton");
  assert.equal(store.state.budgets.Paxton, 1150);
  assert.equal(store.state.scorecards["western_och:1"].Paxton.ratings.kitchen, 4);
});

test("signed out, nothing is sent and the page is told to sign in", async () => {
  const { store, calls } = make({}, { auth: signedIn(null) });
  await assert.rejects(store.load(), (err) => err instanceof GroupError && err.raw === "sign in first" && /Sign in/.test(err.message));
  await assert.rejects(store.myGroups(), { raw: "sign in first" });
  assert.equal(calls.length, 0);
});

test("group calls need a group picked first", async () => {
  const { store, calls } = make({}, { group: null });
  await assert.rejects(store.load(), { raw: "not in this group" });
  assert.equal(calls.length, 0);
});

test("a vote shows instantly, and is put back if saving fails", async () => {
  let release;
  const { store } = make({ group_vote: () => new Promise((r) => (release = r)) });
  await store.load();
  const pending = store.vote("western_och:2", "Sam", "like");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(store.state.votes["western_och:2"].Sam, "like"); // before the server answers
  release(undefined);
  await pending;

  const failing = make({ group_vote: new Error("not in this group") });
  await failing.store.load();
  await assert.rejects(failing.store.vote("western_och:2", "Sam", "like"), GroupError);
  assert.equal(failing.store.state.votes["western_och:2"], undefined);
});

test("server errors become friendly messages", async () => {
  const cases = {
    "sign in first": /Sign in again/,
    "JWT expired": /Sign in again/,
    "not in this group": /not in this group any more/,
    "bad invite": /invite link isn't valid/,
    "name taken": /already has that name/,
    "group is full": /at most 5 people/,
    "too many groups": /already started 3 groups/,
    "bad name": /1 to 20 characters/,
    "invite taken": /Couldn't make an invite link/,
  };
  for (const [raw, friendly] of Object.entries(cases)) {
    const { store } = make({ get_group_state: new Error(raw) });
    await assert.rejects(store.load(), (err) => err instanceof GroupError && err.raw === raw && friendly.test(err.message), raw);
  }
  const offline = new SupabaseGroupStore({ url: "https://x.supabase.co", anonKey: "k", group: GROUP, auth: signedIn(), fetch: async () => { throw new TypeError("Failed to fetch"); }, env: {} });
  await assert.rejects(offline.load(), { message: "Couldn't reach the group database. Check your connection and try again." });
});

test("empty notes and silly budgets never reach the server", async () => {
  const { store, calls } = make();
  await store.load();
  assert.equal(await store.addNote("k", "Paxton", "   "), false);
  assert.equal(await store.setBudget("Paxton", 99), false);
  assert.equal(await store.setBudget("Paxton", "lots"), false);
  await assert.rejects(store.vote("k", "Paxton", "love"));
  await assert.rejects(store.setStatus("k", "bought", "Paxton"));
  assert.equal(calls.length, 1); // only the load
});

test("refresh tells the page only when a friend changed something", async () => {
  let state = STATE;
  const server = fakeServer({ get_group_state: () => state });
  const store = new SupabaseGroupStore({ url: "https://x.supabase.co", anonKey: "k", group: GROUP, auth: signedIn(), fetch: server.fetch, env: {} });
  await store.load();
  const heard = [];
  store.onChange((s, info) => heard.push(info));
  await store.refresh();
  assert.deepEqual(heard, []);
  state = { ...STATE, votes: { ...STATE.votes, "western_och:9": { Maya: "like" } } };
  await store.refresh();
  assert.deepEqual(heard, [{ remote: true }]);
  assert.equal(store.state.votes["western_och:9"].Maya, "like");
  state = { ...state, members: [...STATE.members, "Lilly"] }; // someone joined
  await store.refresh();
  assert.equal(heard.length, 2);
  assert.ok(store.members.includes("Lilly"));
});

test("polling refreshes on a timer and when the app comes back on screen", async () => {
  let loads = 0;
  const server = fakeServer({ get_group_state: () => (loads++, STATE) });
  const listeners = {};
  let intervalFn = null;
  const env = {
    setInterval: (fn, ms) => ((intervalFn = fn), assert.equal(ms, 30000), 7),
    clearInterval: (id) => assert.equal(id, 7),
    document: {
      visibilityState: "visible",
      addEventListener: (t, fn) => (listeners[t] = fn),
      removeEventListener: (t) => delete listeners[t],
    },
  };
  const store = new SupabaseGroupStore({ url: "https://x.supabase.co", anonKey: "k", group: GROUP, auth: signedIn(), fetch: server.fetch, env });
  await store.load();
  store.startPolling();
  intervalFn();
  listeners.visibilitychange();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(loads, 3);
  store.stopPolling();
  assert.equal(listeners.visibilitychange, undefined);
});

test("polling skips refreshes while the app is in the background", async () => {
  let loads = 0;
  const server = fakeServer({ get_group_state: () => (loads++, STATE) });
  let intervalFn = null;
  const doc = { visibilityState: "hidden", addEventListener() {}, removeEventListener() {} };
  const env = { setInterval: (fn) => ((intervalFn = fn), 1), clearInterval() {}, document: doc };
  const store = new SupabaseGroupStore({ url: "https://x.supabase.co", anonKey: "k", group: GROUP, auth: signedIn(), fetch: server.fetch, env });
  await store.load();
  store.startPolling();
  intervalFn();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(loads, 1); // only the first load
  doc.visibilityState = "visible";
  intervalFn();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(loads, 2);
});

// ---------- groups: preview, mine, create, join, leave ----------

test("an invite can be previewed signed out, with just the publishable key", async () => {
  const preview = { name: "Anna's group", members: [{ name: "Anna", claimed: false }], full: false };
  const { store, calls } = make({ group_preview: preview }, { auth: signedIn(null), group: null });
  assert.deepEqual(await store.groupPreview("AnnaInvite_2027-x"), preview);
  assert.deepEqual(calls[0].body, { p_invite: "AnnaInvite_2027-x" }); // no p_group
  assert.equal(calls[0].headers.Authorization, undefined); // publishable keys aren't JWTs
  assert.equal(calls[0].headers.apikey, "anon-key");
  const bad = make({ group_preview: null }, { auth: signedIn(null), group: null });
  assert.equal(await bad.store.groupPreview("nope-nope-nope"), null);
});

test("my_groups, create_group, join_group and leave_group send the contract's parameters", async () => {
  const mine = [{ id: GROUP, name: "Anna's group", me: "Paxton", size: 4 }];
  const { store, calls } = make(
    { my_groups: mine, create_group: "new-group-id", join_group: GROUP, leave_group: undefined },
    { group: null },
  );
  assert.deepEqual(await store.myGroups(), mine);
  assert.deepEqual(calls[0].body, {});

  const made = await store.createGroup("  Our house ", " Paxton ");
  assert.equal(made.id, "new-group-id");
  assert.equal(store.group, "new-group-id");
  assert.deepEqual(Object.keys(calls[1].body), ["p_name", "p_my_name", "p_invite"]);
  assert.equal(calls[1].body.p_name, "Our house");
  assert.equal(calls[1].body.p_my_name, "Paxton");
  assert.equal(calls[1].body.p_invite, made.invite);
  assert.match(made.invite, /^[A-Za-z0-9_-]{16}$/);

  assert.equal(await store.joinGroup("AnnaInvite_2027-x", " Anna "), GROUP);
  assert.deepEqual(calls[2].body, { p_invite: "AnnaInvite_2027-x", p_name: "Anna" });
  assert.equal(store.group, GROUP);

  await store.leaveGroup();
  assert.deepEqual(calls[3], { ...calls[3], name: "leave_group", body: { p_group: GROUP } });
  assert.equal(store.group, null);
  for (const c of calls) assert.equal(c.headers.Authorization, "Bearer user-jwt", c.name);
});

test("a clashing invite code gets a fresh one; other errors don't retry", async () => {
  let tries = 0;
  const { store, calls } = make({ create_group: () => (++tries < 2 ? new Error("invite taken") : "gid") }, { group: null });
  assert.equal((await store.createGroup("Our house", "Paxton")).id, "gid");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].body.p_invite, calls[1].body.p_invite);

  const capped = make({ create_group: new Error("too many groups") }, { group: null });
  await assert.rejects(capped.store.createGroup("Fourth", "Paxton"), { raw: "too many groups" });
  assert.equal(capped.calls.length, 1);
  const always = make({ create_group: new Error("invite taken") }, { group: null });
  await assert.rejects(always.store.createGroup("x", "y"), { raw: "invite taken" });
  assert.equal(always.calls.length, 3); // gives up after 3 codes
});

test("invite codes are 16 characters from crypto.getRandomValues, using every allowed character", () => {
  let asked = 0;
  const fake = { getRandomValues: (arr) => (asked++, arr.forEach((_, i) => (arr[i] = i * 17)), arr) };
  const code = makeInvite(fake);
  assert.equal(asked, 1);
  assert.equal(code.length, 16);
  assert.match(code, /^[A-Za-z0-9_-]{16}$/);
  // Each byte picks one of 64 characters (low 6 bits): 0 → "A", 63 → "_"
  const edges = { getRandomValues: (arr) => arr.fill(0).fill(63, 8) };
  assert.equal(makeInvite(edges), "AAAAAAAA________");
  const real = new Set(Array.from({ length: 50 }, () => makeInvite()));
  assert.equal(real.size, 50);
});

test("who has joined: from the state when the server says, otherwise from the invite preview", async () => {
  const rich = make({
    get_group_state: { ...STATE, members: [{ name: "Anna", claimed: true }, { name: "Julie", claimed: false }] },
  });
  await rich.store.load();
  assert.deepEqual(rich.store.members, ["Anna", "Julie"]);
  assert.deepEqual(await rich.store.loadRoster(), [{ name: "Anna", claimed: true }, { name: "Julie", claimed: false }]);
  assert.equal(rich.calls.length, 1); // no preview needed

  const plain = make({
    group_preview: { name: "Anna's group", members: [{ name: "Paxton", claimed: true }, { name: "Jordan", claimed: true }, { name: "Maya", claimed: false }, { name: "Sam", claimed: true }], full: false },
  });
  await plain.store.load();
  const roster = await plain.store.loadRoster();
  assert.deepEqual(roster.find((m) => m.name === "Maya"), { name: "Maya", claimed: false });
  assert.deepEqual(plain.calls[1].body, { p_invite: "AnnaInvite_2027-x" });
});

// A tiny in-memory copy of supabase/schema.sql's functions, shared by several "phones".
// Each phone's token says who it is; the server works out their name in the group from that.
function groupServer() {
  const people = { "alex-token": "Alex", "bea-token": "Bea" };
  const db = { id: GROUP, name: "Us", invite: "us-invite-1234567", members: ["Alex", "Bea"], votes: {}, notes: {}, status: {}, budgets: {}, scorecards: {} };
  const fail = (status, message) => ({ ok: false, status, text: async () => JSON.stringify({ message }) });
  const ok = (v) => ({ ok: true, status: v === undefined ? 204 : 200, text: async () => (v === undefined ? "" : JSON.stringify(v)) });
  const fetch = async (url, init) => {
    const fn = url.split("/rpc/")[1];
    const p = JSON.parse(init.body);
    const me = people[(init.headers.Authorization || "").replace("Bearer ", "")];
    if (!me) return fail(401, "sign in first");
    if (p.p_group !== GROUP) return fail(403, "not in this group");
    if (fn === "get_group_state") return ok({ ...JSON.parse(JSON.stringify(db)), me });
    if (fn === "group_vote") {
      const v = (db.votes[p.p_key] ||= {});
      if (p.p_vote === null) delete v[me];
      else v[me] = p.p_vote;
      return ok(undefined); // void function: empty 204 body
    }
    if (fn === "group_set_status") {
      db.status[p.p_key] = { status: p.p_status, by: me, at: "now" };
      return ok(undefined);
    }
    return fail(404, `no function ${fn}`);
  };
  return { fetch, db };
}

const phone = (server, token, group = GROUP) =>
  new SupabaseGroupStore({ url: "https://x.supabase.co", anonKey: "sb_publishable_test", group, auth: signedIn(token), fetch: server.fetch, env: {} });

test("a vote from Alex's phone shows up in Bea's after a refresh, under Alex's name", async () => {
  const server = groupServer();
  const alex = phone(server, "alex-token");
  const bea = phone(server, "bea-token");
  await alex.load();
  await bea.load();
  assert.equal(alex.info.me, "Alex");
  assert.equal(bea.info.me, "Bea");
  assert.equal(bea.state.votes["western_och:1"], undefined);
  await alex.vote("western_och:1", alex.info.me, "like"); // the server answers 204 with no body
  await alex.setStatus("western_och:1", "contacted", alex.info.me);
  let heard = 0;
  bea.onChange(() => heard++);
  await bea.refresh();
  assert.deepEqual(bea.state.votes["western_och:1"], { Alex: "like" });
  assert.equal(bea.state.status["western_och:1"].by, "Alex");
  assert.equal(heard, 1);
});

test("someone outside the group is refused, not silently ignored", async () => {
  const server = groupServer();
  const stranger = phone(server, "alex-token", "someone-elses-group");
  await assert.rejects(stranger.load(), (err) => {
    assert.ok(err instanceof GroupError);
    assert.equal(err.raw, "not in this group");
    assert.match(err.message, /not in this group any more/);
    return true;
  });
  const nobody = phone(server, "made-up-token");
  await assert.rejects(nobody.load(), { raw: "sign in first" });
});
