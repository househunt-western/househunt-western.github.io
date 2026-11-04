// Runs supabase/schema.sql on a real (in-memory) Postgres and calls it the way the web page
// will: as a signed-in person (Supabase's "authenticated" role plus their user id), who only
// gets the page's functions.
//   cd supabase && npm install && npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { emptyState } from "../../site/js/group.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const SCHEMA = read("../schema.sql");
const MIGRATE = read("../migrate-to-accounts.sql");
const SCHEMA_V1 = read("./fixtures/schema-v1.sql");
const KEY = "western_och:63747";
const INVITE = "maple-otter-42-lantern";

// Supabase makes these roles and its auth schema itself; a plain Postgres needs stand-ins.
// auth.uid() reads the signed-in user's id the same way Supabase does: from the request's token.
const SUPABASE_STANDINS = `
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text unique);
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
`;

async function blank() {
  const db = new PGlite();
  await db.exec(SUPABASE_STANDINS);
  return db;
}

async function fresh() {
  const db = await blank();
  await db.exec(SCHEMA);
  return db;
}

async function signUp(db, email) {
  return (await db.query("insert into auth.users (email) values ($1) returning id", [email])).rows[0].id;
}

// Run one statement as the web page would: signed in as `user`, or signed out when it's null.
async function as(db, user, sql, params = []) {
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user ?? ""]);
  await db.exec(user ? "set role authenticated" : "set role anon");
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec("reset role");
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  }
}

const one = async (db, user, sql, params) => Object.values((await as(db, user, sql, params)).rows[0])[0];
const startGroup = (db, user, name, me, invite = INVITE) =>
  one(db, user, "select create_group($1, $2, $3)", [name, me, invite]);
const join = (db, user, invite, name) => one(db, user, "select join_group($1, $2)", [invite, name]);
const state = (db, user, group) => one(db, user, "select get_group_state($1)", [group]);

// A group of four: Paxton started it, Jordan, Maya and Sam joined from the invite link.
async function crew() {
  const db = await fresh();
  const people = {};
  for (const name of ["Paxton", "Jordan", "Maya", "Sam"]) {
    people[name] = await signUp(db, `${name.toLowerCase()}@example.com`);
  }
  const group = await startGroup(db, people.Paxton, "Paxton's group", "Paxton");
  for (const name of ["Jordan", "Maya", "Sam"]) await join(db, people[name], INVITE, name);
  return { db, group, people };
}

test("schema can be run twice without errors", async () => {
  const { db, group, people } = await crew();
  await db.exec(SCHEMA);
  await as(db, people.Maya, "select group_vote($1, $2, $3)", [group, KEY, "like"]);
  await db.exec(SCHEMA);
  assert.deepEqual((await state(db, people.Maya, group)).votes, { [KEY]: { Maya: "like" } });
});

test("a new group's state has the page's emptyState() shape plus who's who", async () => {
  const db = await fresh();
  const me = await signUp(db, "paxton@example.com");
  const group = await startGroup(db, me, "  The   House  ", " Paxton ");
  assert.deepEqual(await state(db, me, group), {
    id: group, name: "The House", invite: INVITE, me: "Paxton", members: ["Paxton"], unclaimed: [], ...emptyState(),
  });
  assert.deepEqual(await one(db, me, "select my_groups()"), [{ id: group, name: "The House", me: "Paxton", size: 1 }]);
});

test("the page can't read or write tables directly", async () => {
  const { db, people } = await crew();
  for (const user of [null, people.Maya]) {
    for (const sql of [
      "select * from groups",
      "select * from group_members",
      "select * from votes",
      "select * from push_subs",
      "select * from scorecards",
      "select * from push_sent",
      "insert into votes (group_id, listing_key, member, vote) values (gen_random_uuid(), 'k', 'Maya', 'like')",
      "update group_members set user_id = null",
      "delete from notes",
    ]) {
      await assert.rejects(as(db, user, sql), /permission denied/, sql);
    }
  }
});

test("the page can't call helper functions", async () => {
  const { db, group, people } = await crew();
  await assert.rejects(as(db, people.Maya, "select _me($1)", [group]), /permission denied/);
  await assert.rejects(as(db, people.Maya, "select _clean_name('x')"), /permission denied/);
  await assert.rejects(as(db, people.Maya, "select _rating('{}'::jsonb, 'kitchen')"), /permission denied/);
});

test("signed out, you can only preview an invite", async () => {
  const { db, group } = await crew();
  assert.deepEqual(await one(db, null, "select group_preview($1)", [INVITE]), {
    name: "Paxton's group",
    members: ["Paxton", "Jordan", "Maya", "Sam"].map((name) => ({ name, claimed: true })),
    full: false,
  });
  assert.equal(await one(db, null, "select group_preview($1)", ["no-such-invite-here"]), null);
  for (const [sql, params] of [
    ["select my_groups()", []],
    ["select get_group_state($1)", [group]],
    ["select join_group($1, $2)", [INVITE, "Eve"]],
    ["select group_vote($1, $2, $3)", [group, KEY, "like"]],
  ]) {
    await assert.rejects(as(db, null, sql, params), /permission denied/, sql);
  }
});

test("a token without a user is told to sign in", async () => {
  const { db, group } = await crew();
  await db.exec("set role authenticated");
  try {
    await assert.rejects(db.query("select my_groups()"), /sign in first/);
    await assert.rejects(db.query("select get_group_state($1)", [group]), /sign in first/);
    await assert.rejects(db.query("select create_group('x', 'y', 'abcdefghijklmnop')"), /sign in first/);
  } finally {
    await db.exec("reset role");
  }
});

test("joining: names are unique (ignoring case), groups hold 5, joining twice is harmless", async () => {
  const { db, group, people } = await crew();
  const eve = await signUp(db, "eve@example.com");
  await assert.rejects(join(db, eve, INVITE, "maya"), /name taken/);
  await assert.rejects(join(db, eve, "wrong-invite-code", "Eve"), /bad invite/);
  await assert.rejects(join(db, eve, INVITE, "   "), /bad name/);
  await assert.rejects(join(db, eve, INVITE, "x".repeat(21)), /bad name/);
  assert.equal(await join(db, eve, INVITE, "Eve"), group);
  assert.equal(await join(db, eve, INVITE, "Someone else"), group); // already in: nothing changes
  assert.deepEqual((await state(db, eve, group)).members, ["Paxton", "Jordan", "Maya", "Sam", "Eve"]);
  assert.equal((await one(db, null, "select group_preview($1)", [INVITE])).full, true);
  const late = await signUp(db, "late@example.com");
  await assert.rejects(join(db, late, INVITE, "Late"), /group is full/);
  assert.equal(people.Paxton.length, 36);
});

test("starting groups: invites must be long and unused, and 3 groups each at most", async () => {
  const db = await fresh();
  const me = await signUp(db, "paxton@example.com");
  await assert.rejects(startGroup(db, me, "Ours", "Paxton", "short"), /bad invite/);
  await assert.rejects(startGroup(db, me, "Ours", "Paxton", "has spaces in it!"), /bad invite/);
  await assert.rejects(startGroup(db, me, "", "Paxton"), /bad name/);
  await startGroup(db, me, "One", "Paxton", "invite-number-0001");
  await assert.rejects(startGroup(db, me, "Two", "Paxton", "invite-number-0001"), /invite taken/);
  await startGroup(db, me, "Two", "Paxton", "invite-number-0002");
  await startGroup(db, me, "Three", "Paxton", "invite-number-0003");
  await assert.rejects(startGroup(db, me, "Four", "Paxton", "invite-number-0004"), /too many groups/);
  assert.deepEqual((await one(db, me, "select my_groups()")).map((g) => g.name).sort(), ["One", "Three", "Two"]);
});

test("groups are private: another group can't see or touch yours", async () => {
  const { db, group, people } = await crew();
  const zoe = await signUp(db, "zoe@example.com");
  const other = await startGroup(db, zoe, "Zoe's group", "Maya", "another-invite-2027"); // same first name is fine
  await as(db, people.Maya, "select group_vote($1, $2, $3)", [group, KEY, "like"]);
  await as(db, zoe, "select group_vote($1, $2, $3)", [other, KEY, "pass"]);

  for (const [sql, params] of [
    ["select get_group_state($1)", [group]],
    ["select group_vote($1, $2, $3)", [group, KEY, "pass"]],
    ["select group_add_note($1, $2, $3)", [group, KEY, "hi"]],
    ["select group_set_status($1, $2, $3)", [group, KEY, "rejected"]],
    ["select group_set_budget($1, $2)", [group, 900]],
    ["select group_save_scorecard($1, $2, $3)", [group, KEY, { ratings: { kitchen: 9 } }]],
    ["select save_push_sub($1, $2)", [group, { endpoint: "https://push.example/z" }]],
    ["select leave_group($1)", [group]],
  ]) {
    await assert.rejects(as(db, zoe, sql, params), /not in this group/, sql);
  }
  assert.deepEqual((await state(db, people.Maya, group)).votes, { [KEY]: { Maya: "like" } });
  assert.deepEqual((await state(db, zoe, other)).votes, { [KEY]: { Maya: "pass" } });
});

test("votes: like, change to pass, clear, and always as yourself", async () => {
  const { db, group, people } = await crew();
  const vote = (who, v) => as(db, people[who], "select group_vote($1, $2, $3)", [group, KEY, v]);
  await vote("Maya", "like");
  await vote("Sam", "like");
  await vote("Maya", "pass");
  assert.deepEqual((await state(db, people.Sam, group)).votes, { [KEY]: { Maya: "pass", Sam: "like" } });
  await vote("Maya", null);
  assert.deepEqual((await state(db, people.Sam, group)).votes, { [KEY]: { Sam: "like" } });
  await assert.rejects(vote("Maya", "love"), /bad vote/);
});

test("notes: trimmed, empty ignored, capped at 500, kept in order", async () => {
  const { db, group, people } = await crew();
  const note = (who, t) => one(db, people[who], "select group_add_note($1, $2, $3)", [group, KEY, t]);
  assert.equal(await note("Maya", "  too far from Huron  "), true);
  assert.equal(await note("Sam", "   "), false);
  assert.equal(await note("Sam", null), false);
  assert.equal(await note("Sam", "x".repeat(600)), true);
  const notes = (await state(db, people.Maya, group)).notes[KEY];
  assert.deepEqual(notes.map((n) => [n.member, n.text.length]), [["Maya", 18], ["Sam", 500]]);
  assert.equal(notes[0].text, "too far from Huron");
  assert.ok(notes[0].at);
});

test("status: one per house per group, last update wins, bad status rejected", async () => {
  const { db, group, people } = await crew();
  const set = (who, s) => as(db, people[who], "select group_set_status($1, $2, $3)", [group, KEY, s]);
  await set("Maya", "interested");
  await set("Sam", "viewing");
  const s = (await state(db, people.Maya, group)).status[KEY];
  assert.equal(s.status, "viewing");
  assert.equal(s.by, "Sam");
  assert.ok(s.at);
  await assert.rejects(set("Sam", "maybe"), /check constraint|violates/);
});

test("budgets: same limits and rounding as the page", async () => {
  const { db, group, people } = await crew();
  const budget = (who, n) => one(db, people[who], "select group_set_budget($1, $2)", [group, n]);
  assert.equal(await budget("Maya", 1199.6), true);
  assert.equal(await budget("Sam", 299), false);
  assert.equal(await budget("Sam", 5001), false);
  assert.equal(await budget("Sam", null), false);
  assert.deepEqual((await state(db, people.Sam, group)).budgets, { Maya: 1200 });
});

test("push subscriptions: need https, same phone updates instead of duplicating", async () => {
  const { db, group, people } = await crew();
  const sub = (who, s) => as(db, people[who], "select save_push_sub($1, $2)", [group, s]);
  const phone = { endpoint: "https://push.example/abc", keys: { p256dh: "x", auth: "y" } };
  await sub("Maya", phone);
  await sub("Sam", phone); // phone handed to a friend
  const { rows } = await db.query("select group_id, member, subscription from push_subs");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member, "Sam");
  assert.equal(rows[0].group_id, group);
  assert.equal(rows[0].subscription.keys.auth, "y");
  await assert.rejects(sub("Maya", { endpoint: "http://insecure" }), /https endpoint/);
  await assert.rejects(sub("Maya", {}), /https endpoint/);
});

test("scorecards: saved per person, replaced on save, and shaped like the page's", async () => {
  const { db, group, people } = await crew();
  const save = (who, card) => one(db, people[who], "select group_save_scorecard($1, $2, $3)", [group, KEY, card]);
  assert.equal(await save("Maya", {
    ratings: { kitchen: 4, damp: 2, noise: null, sauna: 5 }, // unknown items are ignored
    lease_ok: true, deposit_asked: false, note: "  basement bedroom is tiny  ",
  }), true);
  assert.equal(await save("Sam", { ratings: { kitchen: 2 }, deposit_asked: true }), true);
  const cards = (await state(db, people.Maya, group)).scorecards[KEY];
  assert.deepEqual(Object.keys(cards).sort(), ["Maya", "Sam"]);
  const { at, ...maya } = cards.Maya;
  assert.ok(at);
  assert.deepEqual(maya, {
    ratings: { kitchen: 4, damp: 2 }, lease_ok: true, deposit_asked: false, note: "basement bedroom is tiny",
  });
  assert.deepEqual(cards.Sam.ratings, { kitchen: 2 });
  assert.equal(cards.Sam.lease_ok, null);
  assert.equal(cards.Sam.deposit_asked, true);
  assert.equal(cards.Sam.note, "");

  // Saving again replaces the whole card (Maya's damp rating is gone)
  assert.equal(await save("Maya", { ratings: { kitchen: 5 }, note: "x".repeat(600) }), true);
  const again = (await state(db, people.Maya, group)).scorecards[KEY].Maya;
  assert.deepEqual(again.ratings, { kitchen: 5 });
  assert.equal(again.lease_ok, null);
  assert.equal(again.note.length, 500);
});

test("scorecards: an empty card removes mine; bad ratings are refused", async () => {
  const { db, group, people } = await crew();
  const save = (who, card) => one(db, people[who], "select group_save_scorecard($1, $2, $3)", [group, KEY, card]);
  await save("Maya", { ratings: { kitchen: 4 } });
  assert.equal(await save("Maya", { ratings: { kitchen: null }, lease_ok: null, note: "   " }), false);
  assert.equal(await save("Sam", null), false);
  assert.deepEqual((await state(db, people.Maya, group)).scorecards, {});

  for (const bad of [0, 6, 3.5, "4", true]) {
    await assert.rejects(save("Maya", { ratings: { heating: bad } }), /bad rating for heating/, String(bad));
  }
  // "yes" isn't true: only real true/false count, anything else is left blank
  await save("Maya", { ratings: { kitchen: 3 }, lease_ok: "yes" });
  assert.equal((await state(db, people.Maya, group)).scorecards[KEY].Maya.lease_ok, null);
});

test("leaving a group takes my votes with me; the last one out deletes the group", async () => {
  const db = await fresh();
  const pax = await signUp(db, "paxton@example.com");
  const sam = await signUp(db, "sam@example.com");
  const group = await startGroup(db, pax, "Ours", "Paxton");
  await join(db, sam, INVITE, "Sam");
  await as(db, sam, "select group_vote($1, $2, $3)", [group, KEY, "like"]);
  await as(db, sam, "select group_set_status($1, $2, $3)", [group, KEY, "interested"]);
  await as(db, sam, "select group_save_scorecard($1, $2, $3)", [group, KEY, { ratings: { noise: 1 } }]);
  await as(db, sam, "select leave_group($1)", [group]);
  const s = await state(db, pax, group);
  assert.deepEqual(s.members, ["Paxton"]);
  assert.deepEqual(s.votes, {});
  assert.deepEqual(s.scorecards, {});
  assert.equal(s.status[KEY].by, null); // the status stays; who set it is forgotten
  assert.deepEqual(await one(db, sam, "select my_groups()"), []);
  await as(db, pax, "select leave_group($1)", [group]);
  assert.equal((await db.query("select count(*)::int as n from groups")).rows[0].n, 0);
});

test("the daily job's secret key can do what alerts need, but can't read invites, emails or notes", async () => {
  const { db, group, people } = await crew();
  await as(db, people.Maya, "select group_vote($1, $2, $3)", [group, KEY, "like"]);
  await as(db, people.Maya, "select save_push_sub($1, $2)", [group, { endpoint: "https://push.example/abc" }]);
  await db.exec("set role service_role");
  try {
    assert.equal((await db.query("select endpoint, group_id, member from push_subs")).rows.length, 1);
    assert.equal((await db.query("select group_id, name, budget_max from group_members")).rows.length, 4);
    assert.deepEqual((await db.query("select group_id, listing_key, member from votes where vote = 'like'")).rows,
      [{ group_id: group, listing_key: KEY, member: "Maya" }]);
    // a match announced twice is ignored (what the job's "ignore duplicates" insert does)
    const remember = "insert into push_sent (group_id, kind, listing_key) values ($1, 'match', $2) on conflict do nothing";
    await db.query(remember, [group, KEY]);
    await db.query(remember, [group, KEY]);
    assert.equal((await db.query("select * from push_sent")).rows.length, 1);
    // a phone that turned alerts off gets removed
    await db.query("delete from push_subs where endpoint = 'https://push.example/abc'");
    assert.equal((await db.query("select * from push_subs")).rows.length, 0);
    for (const sql of [
      "select invite_code from groups",
      "select * from notes",
      "select user_id from group_members",
      "insert into votes (group_id, listing_key, member, vote) values (gen_random_uuid(), 'k', 'Maya', 'like')",
    ]) {
      await assert.rejects(db.query(sql), /permission denied/, sql);
    }
  } finally {
    await db.exec("reset role");
  }
});

// ---------- moving the old one-group database ----------

const OLD_CODE = "cHb7-old-group-code";

async function oldDatabase() {
  const db = await blank();
  await db.exec(SCHEMA_V1);
  await db.query("select setup_group($1, $2)", [OLD_CODE, ["Anna", "Julie", "Piper"]]);
  const old = (sql, params) => as(db, null, sql, [OLD_CODE, ...params]);
  await old("select group_vote($1, $2, $3, $4)", [KEY, "Anna", "like"]);
  await old("select group_vote($1, $2, $3, $4)", [KEY, "Julie", "pass"]);
  await old("select group_vote($1, $2, $3, $4)", ["other:1", "Anna", "like"]);
  await old("select group_add_note($1, $2, $3, $4)", [KEY, "Julie", "nice porch"]);
  await old("select group_set_status($1, $2, $3, $4)", [KEY, "interested", "Anna"]);
  await old("select group_set_budget($1, $2, $3)", ["Piper", 1100]);
  await old("select group_save_scorecard($1, $2, $3, $4)", [KEY, "Piper", { ratings: { kitchen: 4 } }]);
  await old("select save_push_sub($1, $2, $3)", ["Anna", { endpoint: "https://push.example/anna" }]);
  await db.query("insert into push_sent (kind, listing_key) values ('match', $1)", [KEY]);
  return db;
}

test("migration: the old group moves over whole, and friends claim their names", async () => {
  const db = await oldDatabase();
  await db.exec(MIGRATE);
  await db.exec(SCHEMA);
  await assert.rejects(db.query("select adopt_old_group('not-the-old-code', 'x')"), /not the old group code/);
  const { rows } = await db.query("select adopt_old_group($1, $2) as msg", [OLD_CODE, "Anna's group"]);
  assert.equal(rows[0].msg, 'Moved 3 people and 3 votes into "Anna\'s group"');

  // The old link's code is now the invite, and nobody has claimed a name yet
  assert.deepEqual(await one(db, null, "select group_preview($1)", [OLD_CODE]), {
    name: "Anna's group",
    members: ["Anna", "Julie", "Piper"].map((name) => ({ name, claimed: false })),
    full: false,
  });
  const anna = await signUp(db, "anna@example.com");
  const group = await join(db, anna, OLD_CODE, "anna"); // claiming ignores case
  const s = await state(db, anna, group);
  assert.equal(s.me, "Anna");
  assert.deepEqual(s.unclaimed, ["Julie", "Piper"]);
  assert.deepEqual(s.votes, { [KEY]: { Anna: "like", Julie: "pass" }, "other:1": { Anna: "like" } });
  assert.equal(s.notes[KEY][0].text, "nice porch");
  assert.equal(s.status[KEY].by, "Anna");
  assert.deepEqual(s.budgets, { Piper: 1100 });
  assert.deepEqual(s.scorecards[KEY].Piper.ratings, { kitchen: 4 });
  assert.deepEqual((await db.query("select member from push_subs")).rows, [{ member: "Anna" }]);
  assert.deepEqual((await db.query("select group_id, listing_key from push_sent")).rows, [{ group_id: group, listing_key: KEY }]);

  // Someone else can't take Anna's name now, but can take an unclaimed one
  const other = await signUp(db, "other@example.com");
  await assert.rejects(join(db, other, OLD_CODE, "Anna"), /name taken/);
  await join(db, other, OLD_CODE, "Julie");
  assert.deepEqual((await state(db, anna, group)).unclaimed, ["Piper"]);

  // The old tables and functions are gone, and running it all again is harmless
  assert.equal((await db.query("select to_regclass('v1.settings') as t")).rows[0].t, null);
  assert.equal((await db.query("select to_regproc('setup_group') as f")).rows[0].f, null);
  await db.exec(MIGRATE);
  await db.exec(SCHEMA);
  await assert.rejects(db.query("select adopt_old_group($1, 'again')", [OLD_CODE]), /nothing to move/);
  assert.equal((await state(db, anna, group)).votes[KEY].Anna, "like");
});

test("migration: the page can't run the move", async () => {
  const db = await oldDatabase();
  await db.exec(MIGRATE);
  await db.exec(SCHEMA);
  await assert.rejects(as(db, null, "select adopt_old_group($1, 'x')", [OLD_CODE]), /permission denied/);
});
