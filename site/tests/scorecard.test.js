import { test } from "node:test";
import assert from "node:assert/strict";
import { LocalGroupStore } from "../js/group.js";
import { GroupError, SupabaseGroupStore } from "../js/supabase-store.js";
import {
  RATINGS, andList, cleanScorecard, formatScore, isEmptyScorecard, putScorecard, scorecardSummary,
} from "../js/scorecard.js";

class MemoryStorage {
  constructor() { this.data = {}; }
  getItem(k) { return k in this.data ? this.data[k] : null; }
  setItem(k, v) { this.data[k] = String(v); }
}

const card = (ratings, extra = {}) => ({ ratings, lease_ok: null, deposit_asked: null, note: "", ...extra });

test("cleanScorecard keeps known 1–5 ratings, real yes/no, and a trimmed note", () => {
  const clean = cleanScorecard({
    ratings: { kitchen: 4, damp: 1, noise: null, sauna: 5 },
    lease_ok: true, deposit_asked: "yes", note: `  ${"x".repeat(600)}  `, extra: 1,
  });
  assert.deepEqual(clean.ratings, { kitchen: 4, damp: 1 });
  assert.equal(clean.lease_ok, true);
  assert.equal(clean.deposit_asked, null); // only a real true/false counts
  assert.equal(clean.note.length, 500);
  assert.deepEqual(Object.keys(clean), ["ratings", "lease_ok", "deposit_asked", "note"]);
  for (const bad of [0, 6, 3.5, "4", true]) {
    assert.throws(() => cleanScorecard({ ratings: { heating: bad } }), /bad rating for heating/, String(bad));
  }
  assert.deepEqual(cleanScorecard(), card({}));
  assert.deepEqual(cleanScorecard(null), card({}));
});

test("an empty scorecard is one with no ratings, no yes/no answers and no note", () => {
  assert.equal(isEmptyScorecard(cleanScorecard({ note: "   " })), true);
  assert.equal(isEmptyScorecard(cleanScorecard({ ratings: { kitchen: 1 } })), false);
  assert.equal(isEmptyScorecard(cleanScorecard({ lease_ok: false })), false);
  assert.equal(isEmptyScorecard(cleanScorecard({ note: "smelled damp" })), false);
});

test("summary: per-item averages count only the people who answered", () => {
  const cards = {
    Tyler: card({ kitchen: 2, noise: 3 }),
    Paxton: card({ kitchen: 4, noise: 4, damp: 5 }),
    Jack: card({ kitchen: 5 }),
  };
  const s = scorecardSummary(cards, ["Paxton", "Charlie", "Xavier", "Jack", "Tyler"]);
  assert.deepEqual(s.people, ["Paxton", "Jack", "Tyler"]); // group order, and only people with a card
  const item = (id) => s.items.find((i) => i.id === id);
  assert.equal(item("kitchen").average, 3.7); // (4 + 5 + 2) / 3 = 3.67, one decimal
  assert.equal(item("kitchen").count, 3);
  assert.equal(item("noise").average, 3.5); // Jack didn't rate noise
  assert.equal(item("damp").average, 5);
  assert.equal(item("heating").average, null);
  assert.equal(item("heating").count, 0);
  assert.deepEqual(item("noise").answers, [
    { member: "Paxton", value: 4 }, { member: "Jack", value: null }, { member: "Tyler", value: 3 },
  ]);
  // Overall: every rated item counts the same, (3.7 + 5 + 3.5) / 3
  assert.equal(s.overall, 4.1);
  assert.equal(s.items.length, RATINGS.length);
});

test("summary: yes/no answers, the damage-deposit flag, and notes", () => {
  const cards = {
    Paxton: card({}, { lease_ok: true, deposit_asked: false, note: "Big backyard", at: "2026-10-23T18:00:00Z" }),
    Charlie: card({}, { lease_ok: false, deposit_asked: true }),
    Xavier: card({ landlord: 2 }, { lease_ok: true }),
  };
  const s = scorecardSummary(cards, ["Paxton", "Charlie", "Xavier"]);
  const lease = s.checks.find((c) => c.id === "lease_ok");
  assert.deepEqual(lease.yes, ["Paxton", "Xavier"]);
  assert.deepEqual(lease.no, ["Charlie"]);
  assert.deepEqual(s.depositAsked, ["Charlie"]);
  assert.deepEqual(s.notes, [{ member: "Paxton", note: "Big backyard", at: "2026-10-23T18:00:00Z" }]);
  assert.equal(s.overall, 2);
});

test("summary: no cards, and cards from someone no longer in the group", () => {
  const none = scorecardSummary({}, ["Paxton"]);
  assert.deepEqual(none.people, []);
  assert.equal(none.overall, null);
  assert.deepEqual(none.depositAsked, []);
  const old = scorecardSummary({ Zed: card({ kitchen: 3 }), Paxton: card({ kitchen: 5 }) }, ["Paxton"]);
  assert.deepEqual(old.people, ["Paxton", "Zed"]);
  assert.equal(old.items[2].average, 4);
});

test("andList joins names the way people write them", () => {
  assert.equal(andList([]), "");
  assert.equal(andList(["Charlie"]), "Charlie");
  assert.equal(andList(["Charlie", "Jack"]), "Charlie and Jack");
  assert.equal(andList(["Paxton", "Charlie", "Jack"]), "Paxton, Charlie and Jack");
});

test("formatScore shows one decimal, or a dash", () => {
  assert.equal(formatScore(4), "4.0");
  assert.equal(formatScore(3.7), "3.7");
  assert.equal(formatScore(null), "–");
});

test("putScorecard adds, replaces and removes without touching other houses", () => {
  const state = { scorecards: { other: { Jack: card({ kitchen: 1 }) } } };
  putScorecard(state, "k", "Paxton", cleanScorecard({ ratings: { kitchen: 4 } }), "t1");
  putScorecard(state, "k", "Tyler", cleanScorecard({ lease_ok: true }), "t2");
  putScorecard(state, "k", "Paxton", cleanScorecard({ ratings: { heating: 2 } }), "t3");
  assert.deepEqual(state.scorecards.k.Paxton, { ...card({ heating: 2 }), at: "t3" });
  putScorecard(state, "k", "Tyler", cleanScorecard({}), "t4");
  assert.deepEqual(Object.keys(state.scorecards.k), ["Paxton"]);
  assert.deepEqual(state.scorecards.other.Jack.ratings, { kitchen: 1 });
  const bare = {}; // state saved by an older version of the app
  putScorecard(bare, "k", "Jack", cleanScorecard({ ratings: { noise: 5 } }), "t5");
  assert.equal(bare.scorecards.k.Jack.ratings.noise, 5);
});

test("this phone's store: save, replace, remove, and it survives a reload", async () => {
  const storage = new MemoryStorage();
  const s = new LocalGroupStore(storage);
  await s.load();
  assert.deepEqual(s.state.scorecards, {});
  assert.equal(await s.saveScorecard("k", "Paxton", { ratings: { kitchen: 4 }, note: " nice " }), true);
  assert.equal(s.state.scorecards.k.Paxton.note, "nice");
  assert.ok(s.state.scorecards.k.Paxton.at);
  await assert.rejects(s.saveScorecard("k", "Paxton", { ratings: { kitchen: 9 } }), /bad rating/);
  assert.equal(s.state.scorecards.k.Paxton.ratings.kitchen, 4); // the bad save changed nothing

  const again = new LocalGroupStore(storage);
  await again.load();
  assert.deepEqual(again.state.scorecards.k.Paxton.ratings, { kitchen: 4 });
  assert.equal(await again.saveScorecard("k", "Paxton", {}), false);
  assert.deepEqual(again.state.scorecards.k, {});

  // Saved by an older version of the app, before scorecards existed
  const old = new MemoryStorage();
  old.setItem("lh_group_v1", JSON.stringify({ votes: { k: { Jack: "like" } }, notes: {}, status: {}, budgets: {} }));
  const upgraded = new LocalGroupStore(old);
  await upgraded.load();
  assert.deepEqual(upgraded.state.scorecards, {});
  assert.equal(await upgraded.saveScorecard("k", "Jack", { lease_ok: true }), true);
});

// The group database, faked: answers like PostgREST would.
function fakeSupabase(handlers) {
  const calls = [];
  const fetch = async (url, init) => {
    const name = url.split("/rpc/")[1];
    const body = JSON.parse(init.body);
    calls.push({ name, body });
    const out = typeof handlers[name] === "function" ? await handlers[name](body) : handlers[name];
    if (out instanceof Error) return { ok: false, status: 404, text: async () => JSON.stringify({ message: out.message }) };
    return { ok: true, status: 200, text: async () => (out === undefined ? "" : JSON.stringify(out)) };
  };
  const auth = { token: async () => "user-jwt" };
  const store = new SupabaseGroupStore({ url: "https://x.supabase.co", anonKey: "k", group: "our-group", auth, fetch, env: {} });
  return { store, calls };
}

test("group store: sends the cleaned card, shows it at once, and puts it back if saving fails", async () => {
  let release;
  const { store, calls } = fakeSupabase({
    get_group_state: { members: ["Paxton"], votes: {}, notes: {}, status: {}, budgets: {}, scorecards: {} },
    group_save_scorecard: () => new Promise((r) => (release = r)),
  });
  await store.load();
  const pending = store.saveScorecard("western_och:1", "Paxton", { ratings: { kitchen: 4, sauna: 5 }, note: " ok " });
  assert.deepEqual(store.state.scorecards["western_och:1"].Paxton.ratings, { kitchen: 4 }); // before the server answers
  await new Promise((r) => setTimeout(r, 0)); // the call goes out once the sign-in token is ready
  release(true);
  assert.equal(await pending, true);
  assert.deepEqual(calls[1], {
    name: "group_save_scorecard",
    body: {
      p_group: "our-group", p_key: "western_och:1",
      p_card: { ratings: { kitchen: 4 }, lease_ok: null, deposit_asked: null, note: "ok" },
    },
  });

  const failing = fakeSupabase({
    get_group_state: { members: ["Paxton"], votes: {}, notes: {}, status: {}, budgets: {} }, // a database from before scorecards
    group_save_scorecard: new Error("Could not find the function public.group_save_scorecard(p_card, p_group, p_key) in the schema cache"),
  });
  await failing.store.load();
  assert.deepEqual(failing.store.state.scorecards, {});
  await assert.rejects(failing.store.saveScorecard("k", "Paxton", { ratings: { kitchen: 2 } }), (err) => {
    assert.ok(err instanceof GroupError);
    assert.match(err.message, /needs an update/);
    return true;
  });
  assert.deepEqual(failing.store.state.scorecards, {});
});

test("group store: a bad rating never reaches the server", async () => {
  const { store, calls } = fakeSupabase({ get_group_state: { members: ["Paxton"] } });
  await store.load();
  await assert.rejects(store.saveScorecard("k", "Paxton", { ratings: { noise: 0 } }), /bad rating/);
  assert.equal(calls.length, 1); // only the load
});
