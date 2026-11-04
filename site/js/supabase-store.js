// Group state shared through Supabase, so everyone sees each other's votes, notes, scorecards and budgets.
// Same methods as LocalGroupStore. Every call goes through a database function that checks who's
// signed in (the Bearer token from auth.js) and that they're in the group (see supabase/schema.sql);
// nobody can read the tables directly.
import { emptyState } from "./group.js";
import { STATUSES } from "./logic.js";
import { cleanScorecard, isEmptyScorecard, putScorecard } from "./scorecard.js";

const FRIENDLY = [
  [/sign in first|jwt expired|invalid jwt|PGRST30[0-9]/i, "Sign in again to keep going."],
  [/not in this group/i, "You're not in this group any more. Pick another group or ask for a new invite link."],
  [/bad invite/i, "This invite link isn't valid. Ask your group for a new one."],
  [/name taken/i, "Someone in this group already has that name. Add your last initial, like \"Sam K\"."],
  [/group is full/i, "This group is full. Groups have at most 5 people."],
  [/too many groups/i, "You've already started 3 groups, the most anyone can. Leave one or join a friend's instead."],
  [/bad name/i, "Names need 1 to 20 characters (group names up to 40)."],
  [/invite taken/i, "Couldn't make an invite link. Try again."],
  // The page is newer than the database: someone needs to run the latest supabase/schema.sql
  [/could not find the function/i, "The group database needs an update before this works. Run the latest schema.sql in Supabase."],
];

export class GroupError extends Error {
  constructor(raw) {
    const match = FRIENDLY.find(([re]) => re.test(raw));
    super(match ? match[1] : "Couldn't reach the group database. Check your connection and try again.");
    this.raw = raw;
  }
}

const copy = (o) => JSON.parse(JSON.stringify(o));

const INVITE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

// A random 16-character invite code (96 bits), made on this phone. 64 characters, so every
// random byte maps evenly onto one.
export function makeInvite(cryptoObj = globalThis.crypto) {
  const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => INVITE_CHARS[b & 63]).join("");
}

// The server lists members as names, or as { name, claimed } (claimed: someone signed in as them).
const memberName = (m) => (typeof m === "string" ? m : m?.name);

export class SupabaseGroupStore {
  // group: the group's id (null until one is picked). auth: an Auth from auth.js.
  constructor({ url, anonKey, group = null, auth, fetch = globalThis.fetch?.bind(globalThis), pollMs = 30000, env = globalThis, crypto = globalThis.crypto }) {
    this.base = url.replace(/\/+$/, "");
    this.anonKey = anonKey;
    this.group = group;
    this.auth = auth;
    this.crypto = crypto;
    this.info = { id: group, name: "", invite: "", me: null };
    this.roster = []; // [{ name, claimed }] when the server says who has joined
    this.fetch = fetch;
    this.pollMs = pollMs;
    this.env = env;
    this.state = emptyState();
    this.members = [];
    this.shared = true;
    this.listeners = [];
    this.timer = null;
  }

  // Calls a database function. Group calls (the default) send this group's id as p_group.
  async rpc(name, params = {}, { inGroup = true, signedOut = false } = {}) {
    if (inGroup && !this.group) throw new GroupError("not in this group");
    const token = await this.auth?.token();
    if (!token && !signedOut) throw new GroupError("sign in first");
    const headers = { "Content-Type": "application/json", apikey: this.anonKey };
    // The signed-in person's token. Without one, the publishable key goes in apikey only:
    // Supabase's newer publishable keys aren't JWTs, so they can't go in a Bearer header.
    if (token) headers.Authorization = `Bearer ${token}`;
    let resp;
    try {
      resp = await this.fetch(`${this.base}/rest/v1/rpc/${name}`, {
        method: "POST",
        headers,
        body: JSON.stringify(inGroup ? { p_group: this.group, ...params } : params),
      });
    } catch (err) {
      throw new GroupError(String(err)); // offline, DNS, etc.
    }
    const text = await resp.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    if (!resp.ok) throw new GroupError(body?.message || `HTTP ${resp.status}`);
    return body;
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  _notify(info) {
    this.listeners.forEach((fn) => fn(this.state, info));
  }

  _apply(s) {
    const list = Array.isArray(s?.members) ? s.members : [];
    this.members = list.map(memberName).filter(Boolean);
    this.roster = list.some((m) => typeof m === "object")
      ? list.map((m) => ({ name: memberName(m), claimed: m?.claimed !== false })).filter((m) => m.name)
      : this.roster.filter((m) => this.members.includes(m.name));
    this.info = { id: s?.id ?? this.group, name: s?.name ?? "", invite: s?.invite ?? "", me: s?.me ?? null };
    this.state = {
      votes: s?.votes || {},
      notes: s?.notes || {},
      status: s?.status || {},
      budgets: s?.budgets || {},
      scorecards: s?.scorecards || {},
    };
  }

  async load() {
    this._apply(await this.rpc("get_group_state"));
    return this.state;
  }

  // Who has joined, for the Group tab: [{ name, claimed }]. Names added before accounts existed
  // stay unclaimed until that person signs in and taps their name.
  async loadRoster() {
    if (this.info.invite && (!this.roster.length || this.roster.length !== this.members.length)) {
      const preview = await this.groupPreview(this.info.invite);
      if (preview?.members) this.roster = preview.members.map((m) => ({ name: memberName(m), claimed: Boolean(m.claimed) }));
    }
    return this.roster;
  }

  // ---------- picking a group (no group needed yet) ----------

  // What an invite link opens: { name, members: [{ name, claimed }], full }, or null if it's not valid.
  // Works signed out too, so the sign-up screen can say whose group it is.
  groupPreview(invite) {
    return this.rpc("group_preview", { p_invite: invite }, { inGroup: false, signedOut: true });
  }

  // My groups: [{ id, name, me, size }]
  async myGroups() {
    return (await this.rpc("my_groups", {}, { inGroup: false })) || [];
  }

  // Start a group with me in it. Returns { id, invite }. A clash with an existing invite code
  // is near impossible, but gets a fresh code anyway.
  async createGroup(name, myName) {
    for (let tries = 0; ; tries++) {
      const invite = makeInvite(this.crypto);
      try {
        const id = await this.rpc("create_group", { p_name: name.trim(), p_my_name: myName.trim(), p_invite: invite }, { inGroup: false });
        this.group = id;
        return { id, invite };
      } catch (err) {
        if (!/invite taken/i.test(err.raw || "") || tries >= 2) throw err;
      }
    }
  }

  // Join with an invite: claims my old name if it's unclaimed, otherwise adds me. Returns the group id.
  async joinGroup(invite, myName) {
    const id = await this.rpc("join_group", { p_invite: invite, p_name: myName.trim() }, { inGroup: false });
    this.group = id;
    return id;
  }

  async leaveGroup() {
    await this.rpc("leave_group");
    this.stopPolling();
    this.group = null;
  }

  // Fetch the latest from the group; tell the page only if something changed.
  async refresh() {
    const before = JSON.stringify([this.members, this.info, this.state]);
    await this.load();
    if (JSON.stringify([this.members, this.info, this.state]) !== before) this._notify({ remote: true });
  }

  // Check for friends' changes every 30 s while the app is on screen, and right away when it comes back.
  startPolling() {
    this.stopPolling();
    const tick = () => {
      if (this.env.document?.visibilityState === "hidden") return; // app in the background: skip
      this.refresh().catch(() => {}); // a missed refresh just waits for the next one
    };
    this.timer = this.env.setInterval?.(tick, this.pollMs);
    this._onVisible = () => {
      if (this.env.document?.visibilityState === "visible") tick();
    };
    this.env.document?.addEventListener?.("visibilitychange", this._onVisible);
  }

  stopPolling() {
    if (this.timer) this.env.clearInterval?.(this.timer);
    this.timer = null;
    if (this._onVisible) this.env.document?.removeEventListener?.("visibilitychange", this._onVisible);
  }

  // Votes and status change on screen instantly, then save; if saving fails they're put back.
  async _optimistic(change, call) {
    const before = copy(this.state);
    change(this.state);
    this._notify({ remote: false });
    try {
      await call();
    } catch (err) {
      this.state = before;
      this._notify({ remote: false });
      throw err;
    }
  }

  async vote(key, member, vote) {
    if (vote !== null && vote !== "like" && vote !== "pass") throw new Error(`bad vote ${vote}`);
    await this._optimistic(
      (s) => {
        const votes = { ...(s.votes[key] || {}) };
        if (vote === null) delete votes[member];
        else votes[member] = vote;
        s.votes[key] = votes;
      },
      () => this.rpc("group_vote", { p_key: key, p_vote: vote }),
    );
  }

  async setStatus(key, status, member) {
    if (!STATUSES.includes(status)) throw new Error(`bad status ${status}`);
    await this._optimistic(
      (s) => {
        s.status[key] = { status, by: member, at: new Date().toISOString() };
      },
      () => this.rpc("group_set_status", { p_key: key, p_status: status }),
    );
  }

  async addNote(key, member, text) {
    const clean = (text || "").trim().slice(0, 500);
    if (!clean) return false;
    const ok = await this.rpc("group_add_note", { p_key: key, p_text: clean });
    if (ok) {
      this.state.notes[key] = [...(this.state.notes[key] || []), { member, text: clean, at: new Date().toISOString() }];
      this._notify({ remote: false });
    }
    return Boolean(ok);
  }

  async setBudget(member, amount) {
    const n = Math.round(Number(amount));
    if (!Number.isFinite(n) || n < 300 || n > 5000) return false;
    const ok = await this.rpc("group_set_budget", { p_amount: n });
    if (ok) {
      this.state.budgets[member] = n;
      this._notify({ remote: false });
    }
    return Boolean(ok);
  }

  // Shows on screen instantly; put back if saving fails. Returns true if saved, false if it was empty.
  async saveScorecard(key, member, card) {
    const clean = cleanScorecard(card); // throws on a rating that isn't 1–5
    await this._optimistic(
      (s) => putScorecard(s, key, member, clean),
      () => this.rpc("group_save_scorecard", { p_key: key, p_card: clean }),
    );
    return !isEmptyScorecard(clean);
  }

  // This phone's push address (from push.js), so the daily job can send alerts to it. The server
  // files it under whoever is signed in; member is only here to match LocalGroupStore.
  async savePushSub(member, sub) {
    await this.rpc("save_push_sub", { p_sub: sub });
  }
}
