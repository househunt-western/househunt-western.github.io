import { CONFIG } from "./config.js";
import { LocalGroupStore, prefs, visitBaseline } from "./group.js";
import { Voting } from "./voting.js";
import { GroupError, SupabaseGroupStore } from "./supabase-store.js";
import { Auth, MIN_PASSWORD, cleanEmail } from "./auth.js";
import { captureInstallPrompt, currentInstallState, promptInstall } from "./install.js";
import { authHtml, forgotHtml, installHtml, iosStepsHtml, joinHtml, problemHtml, startHtml } from "./onboard-ui.js";
import {
  DEFAULT_FILTERS, STATUSES, budgetLabel, STATUS_LABELS, deckFor, filterListings, groupSummary, initials, isMatch,
  money, parseInviteInput, parseJoinHash, shareText, shortlist, sortListings, statusOf, votesFor, walkLabel, formatDate, costOf,
} from "./logic.js";
import { MIN_VOTES, budgetCheck, groupProfile, readiness, suggest } from "./recommend.js";
import { MAX_COMPARE, compareRows, togglePick } from "./compare.js";
import { cleanScorecard, scorecardSummary, scorecardsFor } from "./scorecard.js";
import { compareHtml, pickRow, scorecardFormHtml, scorecardGroupHtml } from "./viewing-ui.js";
import { mapPoints } from "./mapdata.js";
import { ALERTS_TEXT, alertsState, currentSubscription, isIos, isStandalone, pushSupported, turnOffAlerts, turnOnAlerts } from "./push.js";
import { legendHtml, renderMap } from "./map.js";
import { Deck } from "./swipe.js";
import {
  alsoListed, bulletList, dots, esc, num, safeUrl, factsGrid, fitLine, isNewFor, listRow, photoClass, photoInner, photoStyle, priceNote,
  reasonChips, voteAvatars,
} from "./ui.js";

const $ = (id) => document.getElementById(id);
// Chrome offers its one-tap install early, before the app has even loaded: catch it straight away
const installPrompt = captureInstallPrompt(window);
const PRACTICE_NAME = "You"; // practice mode (no group database) has one person: you
let members = [PRACTICE_NAME]; // the group's own list once signed in
let auth = null; // Auth (auth.js) when the group database is set up
let store; // SupabaseGroupStore when signed in to a group, LocalGroupStore (this phone only) otherwise
let voting; // casts and undoes my votes on whichever store is in use

const app = {
  listings: [],
  byKey: {},
  sample: false,
  lastRun: null,
  me: null, // my name in this group, from the server (so nobody can vote as someone else)
  groups: null, // my groups, for the Group tab's switcher (loaded when the tab opens)
  filters: { ...DEFAULT_FILTERS, ...prefs.get("filters", {}) },
  sort: prefs.get("sort", "cost"),
  homeView: prefs.get("homeView", "list"), // Home shows the listings as a "list" or a "map"
  tab: prefs.get("tab", "discover"),
  order: prefs.get("order", "suggested"), // the deck's order: "suggested" (once unlocked) or "newest"
  why: {}, // "why suggested" reasons for each card in the deck, by house key
  seen: null, // houses that were already here on my previous visit (null on a first visit)
  detailKey: null,
  scoreOpen: null, // the house whose scorecard form I have open
  scoreDrafts: prefs.get("scoreDrafts", {}), // my unsaved scorecards, by "me|house key"
  picking: false, // Shortlist: picking houses to compare
  picks: prefs.get("comparePicks", []), // houses picked to compare, in column order
  alertsOn: false, // this phone has a working push subscription (see push.js)
  alertsBusy: false,
};

// ---------- data ----------

async function fetchJson(url) {
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`${url}: ${resp.status}`);
  return resp.json();
}

async function loadListings() {
  const forceSample = new URLSearchParams(location.search).has("sample");
  if (!forceSample) {
    for (const url of CONFIG.dataUrls) {
      try {
        const data = await fetchJson(url);
        if (Array.isArray(data.listings) && data.listings.length) return { data, sample: false };
      } catch {
        // try the next location
      }
    }
  }
  return { data: await fetchJson(CONFIG.sampleUrl), sample: true };
}

// ---------- helpers ----------

function toast(msg) {
  const t = $("toast");
  // An open sheet sits in the browser's top layer, above everything else, so show the toast inside it.
  const host = document.querySelector("dialog[open]") || document.body;
  if (t.parentElement !== host) host.appendChild(t);
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 2200);
}

function myBudget() {
  return store.state.budgets[app.me] ?? CONFIG.defaultBudget;
}

function filterPills(id) {
  const f = app.filters;
  const pills = [
    f.groupSize ? `Group of ${f.groupSize}` : "Any size",
    budgetLabel(f.minBudget, f.maxBudget),
    f.maxWalk ? `Under ${f.maxWalk} min` : "Any walk",
  ];
  if (f.utilitiesOnly) pills.push("Utilities incl.");
  $(id).innerHTML =
    `<button class="pill on" type="button" data-filters><i class="ti ti-adjustments-horizontal" aria-hidden="true"></i> Filters</button>` +
    pills.map((p) => `<button class="pill" type="button" data-filters>${esc(p)}</button>`).join("");
}

// ---------- tabs ----------

function setTab(tab) {
  app.tab = tab;
  prefs.set("tab", tab);
  for (const s of document.querySelectorAll("#app > section")) s.hidden = s.id !== `tab-${tab}`;
  for (const b of document.querySelectorAll(".tabbar button")) b.classList.toggle("on", b.dataset.tab === tab);
  document.body.classList.toggle("on-discover", tab === "discover");
  $("page-title").textContent = $(`tab-${tab}`).dataset.title;
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (!store) return; // still signing in
  renderMe();
  renderBadge();
  if (app.tab === "discover") renderDiscover();
  if (app.tab === "shortlist") renderShortlist();
  if (app.tab === "home") renderHome();
  if (app.tab === "group") renderGroup();
}

function renderMe() {
  $("me-avatar").textContent = app.me ? initials(app.me) : "?";
  $("me-name").textContent = app.me || "";
}

function renderBadge() {
  const n = app.me ? deckFor(app.listings, store.state, app.me, app.filters).length : 0;
  $("deck-badge").hidden = n === 0;
  $("deck-badge").textContent = n > 99 ? "99+" : n;
}

// ---------- Discover (swipe) ----------

function cardFront(l, photoIndex) {
  const isNew = isNewFor(l, app.seen);
  return `
    <div class="photo ${photoClass(l, photoIndex)}" style="${photoStyle(l, photoIndex)}">
      ${photoInner(l, photoIndex)}${dots(l, photoIndex)}
      <span class="stamp like">Like</span><span class="stamp pass">Pass</span>
      ${l.neighbourhood ? `<span class="photo-tag">${esc(l.neighbourhood)}</span>` : ""}
      ${isNew ? '<span class="photo-tag new-tag">New</span>' : ""}
    </div>
    <div class="card-body">
      <div class="price-line"><span class="serif">${money(costOf(l))}</span><span class="muted small">${esc(priceNote(l))}</span></div>
      <div class="card-title">${esc(l.title)}</div>
      <div class="muted small">${num(l.bedrooms)} bed${l.baths ? ` · ${num(l.baths)} bath` : ""}${l.housing_type ? ` · ${esc(l.housing_type)}` : ""} · ${esc(formatDate(l.lease_start))}</div>
      <div class="muted small"><i class="ti ti-walk" aria-hidden="true"></i> ${esc(walkLabel(l))}</div>
      <div class="chips one-line" style="margin-top:4px">${cardChips(l).map((h) => `<span class="chip">${esc(h)}</span>`).join("")}</div>
      <div style="margin-top:auto;display:flex;justify-content:space-between;align-items:center;gap:8px">${fitLine(l, myBudget())}${voteAvatars(store.state, l.key)}</div>
    </div>`;
}

// Highlights for the card front, minus ones that repeat the walk or utilities lines above them.
function cardChips(l) {
  return (l.highlights || []).filter((h) => !/walk to|utilities included/i.test(h)).slice(0, 3);
}

function cardBack(l) {
  const { likes, passes } = votesFor(store.state, l.key);
  const who = [
    likes.length ? `${likes.map(esc).join(", ")} liked it` : "",
    passes.length ? `${passes.map(esc).join(", ")} passed` : "",
  ].filter(Boolean).join(" · ") || "Nobody has voted yet";
  const why = app.why[l.key];
  return `
    <div class="card-back">
      <div><div class="muted small">Rundown</div><div class="serif" style="font-size:30px;line-height:1.15">${esc(l.title)}</div></div>
      ${why?.length ? `<div><div class="muted small"><i class="ti ti-sparkles" aria-hidden="true"></i> Why suggested</div>${reasonChips(why)}</div>` : ""}
      ${bulletList(l)}
      <div class="muted small">${esc(l.neighbourhood || "")}${l.lease_term_months ? ` · ${num(l.lease_term_months)}-month lease` : ""} · utilities ${esc({ yes: "included", no: "extra", unknown: "not stated" }[l.utilities_included])}${l.amenities?.length ? `<br>${l.amenities.map(esc).join(" · ")}` : ""}</div>
      <div class="small">${who}</div>
      <div class="row-btns" style="margin-top:auto">
        <button class="btn" type="button" data-open="${esc(l.key)}">More</button>
        <button class="btn btn-ink" type="button" data-share="${esc(l.key)}"><i class="ti ti-share" aria-hidden="true"></i> Share</button>
      </div>
      <div class="faint tiny" style="text-align:center">Tap anywhere else to flip back</div>
    </div>`;
}

const deck = new Deck($("deck"), {
  renderFront: cardFront,
  renderBack: cardBack,
  onVote: (l, vote) => castVote(l, vote, { fromDeck: true }),
});

// Who still needs to vote before suggestions unlock, as a short line for the pill and a longer one for the toast.
function lockedText(ready) {
  const mine = ready.needs.find((n) => n.member === app.me);
  const others = ready.needs.filter((n) => n.member !== app.me);
  if (mine) {
    return {
      short: `${mine.more} more vote${mine.more === 1 ? "" : "s"} to unlock suggestions`,
      long: `Vote on ${mine.more} more house${mine.more === 1 ? "" : "s"} to unlock suggestions.${others.length ? ` ${others.map((n) => n.member).join(", ")} still need${others.length === 1 ? "s" : ""} to vote too.` : ""}`,
    };
  }
  return {
    short: `Suggestions: waiting on ${others.length === 1 ? others[0].member : `${others.length} friends`}`,
    long: `Suggestions unlock once everyone has ${MIN_VOTES} votes. Waiting on ${others.map((n) => `${n.member} (${n.more} more)`).join(", ")}.`,
  };
}

function orderPill(ready, suggested) {
  const pill = (icon, text) => `<button class="pill" type="button" data-order><i class="ti ti-${icon}" aria-hidden="true"></i> ${esc(text)}</button>`;
  if (!ready.ready) return pill("lock", lockedText(ready).short);
  return suggested ? pill("sparkles", "Suggested for us") : pill("clock", "Newest first");
}

function toggleOrder() {
  const ready = readiness(store.state, members);
  if (!ready.ready) return toast(lockedText(ready).long);
  app.order = app.order === "suggested" ? "newest" : "suggested";
  prefs.set("order", app.order);
  deck.show([]); // start the deck over in the new order
  render();
  toast(app.order === "suggested" ? "Best fits for the whole group first" : "Newest houses first");
}

function renderDiscover() {
  filterPills("discover-pills");
  const ready = readiness(store.state, members);
  const suggested = app.order === "suggested" && ready.ready;
  $("discover-pills").firstElementChild.insertAdjacentHTML("afterend", orderPill(ready, suggested));
  let items = deckFor(app.listings, store.state, app.me, app.filters);
  app.why = {};
  if (suggested) {
    const ranked = suggest(items, app.listings, store.state, members);
    app.why = Object.fromEntries(ranked.map((r) => [r.listing.key, r.reasons]));
    items = ranked.map((r) => r.listing);
    // Every vote re-ranks the deck. Don't swap the card I'm looking at (or the one peeking out
    // under it, which comes next after a swipe): the first card from the current deck stays on top.
    const keep = deck.items.find((x) => items.some((l) => l.key === x.key));
    if (keep) items = [keep, ...items.filter((l) => l.key !== keep.key)];
  }
  if (deck.top?.key !== items[0]?.key || deck.items.length !== items.length) deck.show(items);
  // At the end of the deck only Undo stays, so the last swipe can still be taken back on a phone
  $("deck-actions").hidden = !items.length && !voting.canUndo;
  for (const id of ["btn-pass", "btn-info", "btn-like"]) $(id).hidden = !items.length;
  $("deck-hint").hidden = !items.length;
  if (!items.length) {
    const total = filterListings(app.listings, app.filters).length;
    $("deck").innerHTML = total
      ? '<div class="empty"><span class="serif">You\'re caught up</span>You\'ve voted on every house that fits your filters. New ones show up here as they\'re found.</div>'
      : '<div class="empty"><span class="serif">Nothing fits yet</span>No houses match these filters. Try a bigger budget or a longer walk.<br><br><button class="btn" type="button" data-filters>Change filters</button></div>';
  }
}

async function castVote(l, vote, { fromDeck = false } = {}) {
  if (!app.me) return;
  // If saving fails, this throws and the error handler below shows a message
  const result = await voting.cast(l.key, app.me, vote);
  if (!result) return; // this house's vote is still saving
  if (result.match) showMatch(l);
  else if (fromDeck) $("deck-hint").textContent = vote === "like" ? `Liked ${l.title}` : `Passed on ${l.title}`;
  render();
}

async function undoLast() {
  const last = await voting.undo(app.me);
  if (!last) return toast("Nothing to undo");
  deck.show([]); // force a fresh deck so the undone card comes back on top
  render();
  const l = app.byKey[last.key];
  if (l && deck.top?.key !== l.key) {
    deck.show([l, ...deck.items.filter((x) => x.key !== l.key)]);
  }
  $("deck-hint").textContent = "Undone";
}

function showMatch(l) {
  $("match-photo").setAttribute("style", photoStyle(l));
  $("match-photo").className = `match-photo ${photoClass(l)}`;
  $("match-photo").innerHTML = photoInner(l);
  $("match-text").textContent = `Everyone liked ${l.title}. It's moved to the top of your shortlist. Someone should contact the landlord.`;
  $("match").hidden = false;
  $("match-open").onclick = () => {
    $("match").hidden = true;
    openDetail(l.key);
  };
}

// ---------- Shortlist ----------

function renderShortlist() {
  const items = shortlist(app.listings, store.state, members);
  if (app.picking) return renderPicking(items);
  $("shortlist").innerHTML = items.length
    ? compareStart(items) + items.map((l) => {
        const match = isMatch(store.state, l.key, members);
        return (match ? '<div class="chip good" style="align-self:flex-start;margin-top:10px">Match: everyone liked it</div>' : "") +
          listRow(l, store.state, { members, showLikes: true });
      }).join("")
    : '<div class="empty"><span class="serif">No likes yet</span>Swipe right on houses you like in Discover and they\'ll collect here.</div>';
}

// ---------- Home ----------

function renderHome() {
  const sum = groupSummary(app.listings, store.state, members, store.state.budgets, app.filters);
  const lo = 700, hi = 1400;
  const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  let hero;
  if (sum.sweetSpot) {
    const vs = sum.ceiling
      ? (sum.sweetSpot.median <= sum.ceiling
        ? `<span class="good"><i class="ti ti-arrow-down-right" aria-hidden="true"></i> ${money(sum.ceiling - sum.sweetSpot.median)} under the group ceiling</span>`
        : `<span class="warn"><i class="ti ti-arrow-up-right" aria-hidden="true"></i> ${money(sum.sweetSpot.median - sum.ceiling)} over the group ceiling</span>`)
      : '<span class="muted">Set budgets in Group to see the ceiling</span>';
    hero = `
      <div class="hero-label">Group sweet spot · per person</div>
      <div class="hero-number serif">${money(sum.sweetSpot.median)}</div>
      <div class="hero-sub">${vs}</div>
      <div class="range">
        <div class="range-track">
          <div class="range-band" style="left:${pct(sum.sweetSpot.low)}%;width:${Math.max(2, pct(sum.sweetSpot.high) - pct(sum.sweetSpot.low))}%"></div>
          ${sum.ceiling ? `<div class="range-mark" style="left:${pct(sum.ceiling)}%" title="Group ceiling"></div>` : ""}
        </div>
        <div class="range-labels"><span>${money(lo)}</span><span>Likes ${money(sum.sweetSpot.low)}–${money(sum.sweetSpot.high)}</span><span class="${sum.ceiling ? "warn" : ""}">${sum.ceiling ? `Ceiling ${money(sum.ceiling)}` : money(hi)}</span></div>
      </div>`;
  } else {
    hero = `
      <div class="hero-label">Houses that fit your filters</div>
      <div class="hero-number count">${sum.matching}</div>
      <div class="hero-sub muted">Like ${Math.max(0, 3 - sum.likedCount)} more to see your group's price sweet spot.</div>`;
  }
  $("summary").innerHTML = `${hero}
    <div class="stats">
      <button class="stat" type="button" data-scroll="listings"><div class="muted tiny">Matching</div><div class="count">${sum.matching}</div></button>
      <button class="stat" type="button" data-tab-go="shortlist"><div class="muted tiny">Shortlist</div><div class="count">${sum.shortlist}</div></button>
      <button class="stat" type="button" data-tab-go="shortlist"><div class="muted tiny">Viewings</div><div class="count">${sum.viewings}</div></button>
    </div>`;
  filterPills("home-pills");
  $("sort").value = app.sort;
  const items = sortListings(filterListings(app.listings, app.filters), app.sort, store.state)
    .filter((l) => statusOf(store.state, l.key) !== "rejected");
  $("list-count").textContent = `${items.length} listing${items.length === 1 ? "" : "s"}`;

  const onMap = app.homeView === "map";
  for (const b of document.querySelectorAll("[data-view]")) b.classList.toggle("on", b.dataset.view === app.homeView);
  $("sort").hidden = onMap;
  $("listings").hidden = onMap;
  $("map-wrap").hidden = !onMap;
  if (onMap) {
    renderHomeMap();
    return;
  }
  $("listings").innerHTML = items.length
    ? items.map((l) => listRow(l, store.state, { members, isNew: isNewFor(l, app.seen) })).join("")
    : '<div class="empty"><span class="serif">No matches</span>Loosen the filters to see more.</div>';
}

function renderHomeMap() {
  const { points, missing } = mapPoints(app.listings, app.filters, store.state, { budget: myBudget(), members });
  $("map-legend").innerHTML = legendHtml();
  $("map-note").textContent = missing.length
    ? `${points.length} on the map. ${missing.length} more ${missing.length === 1 ? "has" : "have"} no exact address (for example an intersection), so ${missing.length === 1 ? "it's" : "they're"} only in the List.`
    : `${points.length} on the map. Colours compare each place with your budget (${money(myBudget())}).`;
  renderMap($("map"), points, app.byKey).catch((err) => {
    $("map-note").textContent = err.message;
  });
}

function setHomeView(view) {
  app.homeView = view;
  prefs.set("homeView", view);
  renderHome();
}

// ---------- Group ----------

// Budget reality check: what each person said vs the prices they've actually liked.
function budgetReality() {
  const check = budgetCheck(app.listings, store.state, members);
  const profile = groupProfile(app.listings, store.state, members);
  const lo = 700, hi = 1400; // same scale as the Home tab's range bar
  const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const bar = (r, stated) => `<div class="range mini"><div class="range-track">
      <div class="range-band" style="left:${pct(r.low)}%;width:${Math.max(2, pct(r.high) - pct(r.low))}%"></div>
      ${stated ? `<div class="range-mark" style="left:${pct(stated)}%"></div>` : ""}
    </div></div>`;
  const spot = check.sweetSpot;
  return `
    <div class="section-head"><h2>Budget reality check</h2></div>
    <p class="muted small" style="margin-top:4px">What each of you said vs what you've actually liked. The bar is the price range of your likes; the tick is your budget.</p>
    <div class="stats two">
      <div class="stat"><div class="muted tiny">Realistic ceiling</div><span class="serif money">${check.ceiling ? money(check.ceiling) : "–"}</span><div class="faint tiny">${check.ceilingBy.length ? `Lowest budget: ${esc(check.ceilingBy.join(", "))}` : "Set budgets above"}</div></div>
      <div class="stat"><div class="muted tiny">Group sweet spot</div><span class="serif money">${spot ? money(spot.median) : "–"}</span><div class="faint tiny">${spot ? `Most likes: ${money(spot.low)}–${money(spot.high)}` : "Needs 3 likes"}</div></div>
    </div>
    ${check.flags.map((f) => `<div class="banner warn"><i class="ti ti-alert-triangle" aria-hidden="true"></i> The sweet spot is ${money(f.by)} over ${esc(f.member)}'s budget of ${money(f.budget)}. Worth talking about before you book viewings.</div>`).join("")}
    <div>
      ${check.people.map((p) => `<div class="group-row top">
          <span class="avatar">${esc(initials(p.member))}</span>
          <span style="flex:1;min-width:0"><span style="display:block;font-weight:500">${esc(p.member)}</span><span class="muted small ${p.revealed?.over ? "warn" : ""}">${esc(p.line)}</span>${p.revealed ? bar(p.revealed, p.stated) : ""}</span>
        </div>`).join("")}
    </div>
    ${profile.summary ? `<p class="muted small"><i class="ti ti-sparkles" aria-hidden="true"></i> Your likes so far: <b>${esc(profile.summary)}</b></p>` : ""}`;
}

function renderGroup() {
  const rejected = app.listings.filter((l) => statusOf(store.state, l.key) === "rejected");
  const voteCount = (m) => Object.values(store.state.votes).filter((v) => v[m]).length;
  const roster = store.shared && store.roster.length ? store.roster : members.map((name) => ({ name, claimed: true }));
  const others = (app.groups || []).filter((g) => g.id !== store.group);
  $("group").innerHTML = `
    ${store.shared ? "" : '<div class="banner"><b>Practice mode.</b> Votes, notes and budgets are saved on this phone only, because the group database (Supabase) isn\'t set up in config.js.</div>'}
    ${store.shared ? `<div class="group-title"><h2 class="serif">${esc(store.info.name)}</h2><span class="muted small">${members.length} of 5 people</span></div>` : ""}
    <div class="section-head" style="margin-top:0"><h2>Members</h2><span class="muted small">Max budget / person</span></div>
    <div>
      ${roster.map(({ name: m, claimed }) => {
        const b = store.state.budgets[m];
        const mine = m === app.me;
        const votes = voteCount(m);
        const sub = claimed
          ? `${votes} vote${votes === 1 ? "" : "s"}`
          : `Invited, hasn't joined yet${votes ? ` · ${votes} vote${votes === 1 ? "" : "s"}` : ""}`;
        return `<div class="group-row">
          <span class="avatar ${claimed ? "" : "pending"}">${esc(initials(m))}</span>
          <span style="flex:1;min-width:0"><span style="display:block;font-weight:500">${esc(m)}${mine ? ' <span class="faint small">(you)</span>' : ""}</span><span class="muted tiny">${esc(sub)}</span></span>
          ${mine
            ? `<form id="budget-form" style="text-align:right"><input class="budget-input" id="budget-input" inputmode="numeric" value="${b ?? ""}" placeholder="${CONFIG.defaultBudget}" aria-label="Your max budget per person"><div class="field-error" id="budget-error"></div></form>`
            : `<span class="serif" style="font-size:22px">${b ? money(b) : '<span class="faint small" style="font-family:var(--sans)">Not set</span>'}</span>`}
        </div>`;
      }).join("")}
    </div>
    ${store.shared ? `
      ${members.length < 5 ? '<p class="muted small">Send the invite link to the rest of your group. Each of you signs up and joins with your own first name.</p>' : ""}
      <button class="btn btn-ink wide" type="button" id="share-invite"><i class="ti ti-share" aria-hidden="true"></i> Share invite link</button>
      <div class="invite" style="margin-top:10px"><code>${esc(inviteUrl())}</code><button class="pill" type="button" id="copy-invite">Copy</button></div>` : ""}

    ${budgetReality()}

    ${alertsSection()}

    <div class="section-head"><h2>Add to Home Screen</h2></div>
    ${homeScreenHelp()}

    ${store.shared ? `
      <div class="section-head"><h2>Your groups</h2></div>
      ${others.length ? `<div class="gate-groups">${others.map((g) => `<button class="gate-group" type="button" data-switch-group="${esc(g.id)}">
          <span><span class="gate-group-name">${esc(g.name)}</span><span class="muted small">You're ${esc(g.me)} · ${Number(g.size) || 1} ${Number(g.size) === 1 ? "person" : "people"}</span></span>
          <span class="pill">Switch</span></button>`).join("")}</div>` : '<p class="muted small" style="margin-top:4px">This is your only group. You can be in more than one, for example with different friends.</p>'}
      <button class="btn wide" type="button" id="start-another" style="margin-top:10px"><i class="ti ti-plus" aria-hidden="true"></i> Start another group</button>
      <p class="muted small">Got an invite to another group? Paste the link. On iPhone, tapping a link opens Safari instead of the Home Screen app, so paste it here.</p>
      ${joinForm()}` : ""}

    <div class="section-head"><h2>Hidden houses</h2><span class="muted small">${rejected.length}</span></div>
    <div class="list">${rejected.map((l) => listRow(l, store.state, { members })).join("") || '<p class="muted small">Houses marked "Rejected" go here.</p>'}</div>

    <div class="section-head"><h2>Data</h2></div>
    <p class="muted small" style="margin-top:4px">${app.sample ? "Showing sample houses until the scraper's first run." : `Last updated ${esc(new Date(app.lastRun).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }))}.`}</p>

    ${store.shared ? `
      <div class="section-head"><h2>Account</h2></div>
      <p class="muted small" style="margin-top:4px">Signed in as ${esc(auth.email || "you")}.</p>
      <div class="row-btns">
        <button class="btn" type="button" id="leave-group">Leave group</button>
        <button class="btn" type="button" id="sign-out">Sign out</button>
      </div>` : ""}`;
  if (store.shared && !app.groups) loadGroupExtras();
}

const inviteUrl = () => `${location.origin}${location.pathname}#join=${store.info.invite}`;

// My other groups and who has joined, fetched once when the Group tab first opens.
async function loadGroupExtras() {
  app.groups = [];
  try {
    [app.groups] = await Promise.all([directory().myGroups(), store.loadRoster()]);
  } catch (err) {
    console.warn("Couldn't load your groups", err); // the tab works without them
  }
  if (app.tab === "group") renderGroup();
}

function homeScreenHelp() {
  const state = currentInstallState(installPrompt);
  if (state === "installed") return '<p class="muted small" style="margin-top:4px"><i class="ti ti-circle-check" aria-hidden="true"></i> You\'re using the Home Screen app.</p>';
  if (state === "android-prompt") {
    return `<p class="muted small" style="margin-top:4px">It opens like an app, and alerts come straight to your phone.</p>
      <button class="btn btn-ink" type="button" id="install-app"><i class="ti ti-download" aria-hidden="true"></i> Install House Hunt</button>`;
  }
  if (state === "ios-safari") return `<p class="muted small" style="margin-top:4px">It opens like an app, and it's the only way alerts reach an iPhone.</p>${iosStepsHtml()}`;
  return '<p class="muted small" style="margin-top:4px">On iPhone: open this page in Safari, tap <i class="ti ti-share" aria-hidden="true"></i> Share (or the ⋯ menu, then Share), then <b>Add to Home Screen</b>. On Android: in Chrome, tap ⋮, then <b>Add to Home screen</b>.</p>';
}

async function shareInvite() {
  const url = inviteUrl();
  if (navigator.share) {
    try {
      await navigator.share({ title: "House Hunt", text: `Join ${store.info.name} on House Hunt, so we can pick a house together:`, url });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return; // they closed the share sheet
    }
  }
  copyInvite();
}

async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteUrl());
    toast("Invite link copied. Paste it in your group chat");
  } catch {
    toast("Couldn't copy. Long-press the link instead");
  }
}

async function leaveGroup() {
  const ok = confirm(`Leave ${store.info.name}? Your votes, notes and scorecards in it are deleted, and you'd need the invite link to come back.`);
  if (!ok) return;
  try {
    await store.leaveGroup();
  } catch (err) {
    return toast(err.message);
  }
  prefs.set("group", null);
  location.reload();
}

async function signOut() {
  prefs.set("group", null); // the next person to sign in on this phone has their own groups
  await auth.signOut(); // auth.onChange reloads the page, back to the sign-in screen
  return new Promise(() => {}); // nothing else happens on this page
}

async function installFromButton() {
  if (await promptInstall(installPrompt)) toast("Installed. Open House Hunt from your Home Screen");
  render();
}

// Start another group (from the Group tab). It opens straight away.
async function startAnother(button) {
  button.disabled = true;
  let groups = app.groups || [];
  try {
    groups = await directory().myGroups();
  } catch {
    // the picker just shows fewer groups
  }
  button.disabled = false;
  const picked = await startScreen(directory(), groups, { canCancel: true });
  if (picked.invite) prefs.set("invite", picked.invite);
  else if (picked.id && picked.id !== store.group) prefs.set("group", picked.id);
  else return hideGate();
  location.reload();
}

// ---------- phone alerts ----------

function alertsNow() {
  return alertsState({
    hasKey: Boolean(CONFIG.vapidPublicKey),
    supported: pushSupported(window),
    ios: isIos(navigator),
    standalone: isStandalone(window),
    shared: store.shared,
    me: app.me,
    permission: pushSupported(window) ? Notification.permission : "default",
    subscribed: app.alertsOn,
  });
}

function alertsSection() {
  const state = alertsNow();
  const button = {
    off: `<button class="btn btn-ink" type="button" id="alerts-on" ${app.alertsBusy ? "disabled" : ""}><i class="ti ti-bell" aria-hidden="true"></i> Turn on alerts</button>`,
    on: `<button class="btn" type="button" id="alerts-off" ${app.alertsBusy ? "disabled" : ""}>Turn off on this phone</button>`,
  }[state] || "";
  return `
    <div class="section-head"><h2>Phone alerts</h2>${state === "on" ? '<span class="good small"><i class="ti ti-bell-ringing" aria-hidden="true"></i> On</span>' : ""}</div>
    <p class="muted small" style="margin-top:4px">${esc(ALERTS_TEXT[state])}</p>
    ${button}`;
}

// Check whether this phone is subscribed, and keep the saved address filed under the right name.
async function syncAlerts() {
  if (!CONFIG.vapidPublicKey) return;
  try {
    const sub = await currentSubscription({ win: window, key: CONFIG.vapidPublicKey });
    app.alertsOn = Boolean(sub);
    const saved = sub && `${sub.endpoint}|${store.group}|${app.me}`;
    if (sub && store.shared && app.me && prefs.get("alertsSaved") !== saved) {
      await store.savePushSub(app.me, sub.toJSON());
      prefs.set("alertsSaved", saved);
    }
  } catch (err) {
    console.warn("Couldn't check phone alerts", err); // the button still works
  }
  if (app.tab === "group") renderGroup();
}

async function alertsOn() {
  app.alertsBusy = true;
  renderGroup();
  try {
    const result = await turnOnAlerts({
      win: window,
      key: CONFIG.vapidPublicKey,
      save: (sub) => store.savePushSub(app.me, sub),
    });
    app.alertsOn = result.ok;
    if (result.ok) {
      prefs.set("alertsSaved", `${result.sub.endpoint}|${store.group}|${app.me}`);
      toast("Alerts on. You'll hear about new houses here");
    } else if (result.permission === "denied") {
      toast("Alerts are blocked. See the steps on this page");
    }
  } catch (err) {
    console.error(err);
    toast(err instanceof GroupError ? err.message : "Couldn't turn on alerts. Try again in a minute");
  }
  app.alertsBusy = false;
  renderGroup();
}

async function alertsOff() {
  app.alertsBusy = true;
  renderGroup();
  try {
    await turnOffAlerts({ win: window });
    app.alertsOn = false;
    prefs.set("alertsSaved", null);
    toast("Alerts off on this phone");
  } catch (err) {
    console.error(err);
    toast("Couldn't turn off alerts. Try again");
  }
  app.alertsBusy = false;
  renderGroup();
}

async function saveBudget(e) {
  e.preventDefault();
  const input = $("budget-input");
  const ok = await store.setBudget(app.me, input.value.replace(/[$,\s]/g, ""));
  if (!ok) {
    $("budget-error").textContent = "Enter a monthly amount between $300 and $5,000.";
    return;
  }
  toast("Budget saved");
  render();
}

// ---------- Detail sheet ----------

function openDetail(key) {
  const l = app.byKey[key];
  if (!l) return;
  app.detailKey = key;
  renderDetail();
  const dlg = $("detail-sheet");
  if (!dlg.open) dlg.showModal();
  $("detail").scrollTop = 0;
}

function renderDetail() {
  const l = app.byKey[app.detailKey];
  if (!l) return;
  const myVote = (store.state.votes[l.key] || {})[app.me];
  const status = statusOf(store.state, l.key);
  const notes = store.state.notes[l.key] || [];
  $("detail").innerHTML = `
    <div class="sheet-grab"></div>
    <div class="photo ${photoClass(l)}" style="${photoStyle(l)}">${photoInner(l)}${l.images?.length > 1 ? `<span class="photo-tag">${l.images.length} photos</span>` : ""}</div>
    <div class="price-line"><span class="serif" style="font-size:44px">${money(costOf(l))}</span><span class="muted small">${esc(priceNote(l))}</span></div>
    <div class="card-title" style="font-size:18px">${esc(l.title)}</div>
    <div style="margin-top:4px">${fitLine(l, myBudget())}</div>
    ${factsGrid(l)}
    ${alsoListed(l)}
    <h3>Rundown</h3>
    ${bulletList(l)}
    ${l.amenities?.length ? `<div class="chips" style="margin-top:8px">${l.amenities.map((a) => `<span class="chip">${esc(a)}</span>`).join("")}</div>` : ""}

    <h3>Your vote</h3>
    <div class="row-btns">
      <button class="btn ${myVote === "pass" ? "btn-ink" : ""}" type="button" data-vote="pass"><i class="ti ti-x" aria-hidden="true"></i> Pass</button>
      <button class="btn ${myVote === "like" ? "btn-ink" : ""}" type="button" data-vote="like"><i class="ti ti-heart" aria-hidden="true"></i> Like</button>
    </div>
    <div class="small muted" style="margin-top:8px;display:flex;gap:8px;align-items:center">${voteAvatars(store.state, l.key) || "No votes yet"}</div>

    <h3>Status</h3>
    <div class="seg">${STATUSES.map((s) => `<button class="pill ${s === status ? "on" : ""}" type="button" data-status="${s}">${STATUS_LABELS[s]}</button>`).join("")}</div>
    ${store.state.status[l.key]?.by ? `<div class="faint tiny" style="margin-top:6px">Set by ${esc(store.state.status[l.key].by)}</div>` : ""}

    <h3>Viewing notes</h3>
    <div id="scorecard">${scorecardSection(l)}</div>

    <h3>Notes</h3>
    ${notes.map((n) => `<div class="note"><span class="avatar">${esc(initials(n.member))}</span><span><span class="faint tiny" style="display:block">${esc(n.member)} · ${esc(new Date(n.at).toLocaleDateString("en-CA", { month: "short", day: "numeric" }))}</span>${esc(n.text)}</span></div>`).join("") || '<p class="muted small">No notes yet. Add things like "basement rooms are tiny" or "landlord replied fast".</p>'}
    <form class="note-form" id="note-form">
      <input id="note-input" maxlength="500" placeholder="Landlord said viewings are Saturday" aria-label="Add a note">
      <button class="btn btn-ink" type="submit" style="padding:9px 16px">Add</button>
    </form>
    <div class="field-error" id="note-error"></div>

    <div class="row-btns" style="margin-top:18px">
      <button class="btn" type="button" data-share="${esc(l.key)}"><i class="ti ti-share" aria-hidden="true"></i> Share</button>
      ${safeUrl(l.url) ? `<a class="btn btn-ink" href="${esc(safeUrl(l.url))}" target="_blank" rel="noopener noreferrer" style="text-decoration:none">Open listing <i class="ti ti-external-link" aria-hidden="true"></i></a>` : ""}
    </div>`;
}

async function share(key) {
  const l = app.byKey[key];
  if (!l) return;
  const text = shareText(l);
  if (navigator.share) {
    try {
      await navigator.share({ title: l.title, text, url: l.url });
      return;
    } catch (err) {
      if (err?.name === "AbortError") return; // they closed the share sheet
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied. Paste it in your group chat");
  } catch {
    toast("Couldn't share. Long-press the listing link instead");
  }
}

// ---------- Viewing scorecard (on the detail sheet) ----------

// My answers stay a draft on this phone (even through a reload) until I tap Save.
const draftKey = (key) => `${app.me}|${key}`;
const savedCard = (key) => scorecardsFor(store.state, key)[app.me];
const myCard = (key) => app.scoreDrafts[draftKey(key)] ?? savedCard(key) ?? cleanScorecard();

function setDraft(key, card) {
  const { [draftKey(key)]: _, ...rest } = app.scoreDrafts;
  // Back to exactly what's saved (or to blank, with nothing saved): no longer a draft
  let same = false;
  try {
    same = JSON.stringify(cleanScorecard(card)) === JSON.stringify(cleanScorecard(savedCard(key) ?? {}));
  } catch {
    // a rating that isn't 1–5 can't happen from the buttons; keep it as a draft if it does
  }
  app.scoreDrafts = same ? rest : { ...rest, [draftKey(key)]: card };
  prefs.set("scoreDrafts", app.scoreDrafts);
}

function scorecardSection(l) {
  const summary = scorecardSummary(scorecardsFor(store.state, l.key), members);
  const saved = savedCard(l.key);
  const dirty = Boolean(app.scoreDrafts[draftKey(l.key)]);
  const intro = summary.people.length
    ? ""
    : '<p class="muted small" style="margin-top:0">Rate the house during or after a viewing. Everyone fills in their own, and the group\'s averages show up here.</p>';
  const mine = app.me && (app.scoreOpen === l.key || dirty)
    ? scorecardFormHtml(myCard(l.key), { dirty, saved: Boolean(saved) })
    : `<button class="btn" type="button" data-score-open style="width:100%;margin-top:10px"><i class="ti ti-clipboard-check" aria-hidden="true"></i> ${saved ? "Edit your scorecard" : "Fill in your scorecard"}</button>`;
  return intro + scorecardGroupHtml(summary) + mine;
}

function renderScorecard() {
  const l = app.byKey[app.detailKey];
  if (l && $("scorecard")) $("scorecard").innerHTML = scorecardSection(l);
}

// Typing the note doesn't redraw the form (that would close the phone's keyboard): just the buttons.
function syncScoreButtons(key) {
  const box = $("scorecard");
  const dirty = Boolean(app.scoreDrafts[draftKey(key)]);
  box.querySelector("[data-score-save]").disabled = !dirty;
  box.querySelector("[data-score-cancel]").textContent = dirty ? "Discard changes" : "Close";
  box.querySelector("[data-score-unsaved]").hidden = !dirty;
}

async function saveMyScorecard(l, button) {
  const draft = app.scoreDrafts[draftKey(l.key)];
  if (!draft) return;
  button.disabled = true;
  let saved;
  try {
    saved = await store.saveScorecard(l.key, app.me, draft);
  } catch (err) {
    button.disabled = false;
    toast(err instanceof GroupError ? err.message : "Couldn't save that. Check your answers and try again.");
    return; // the draft stays, so nothing typed is lost
  }
  setDraft(l.key, savedCard(l.key) ?? {});
  app.scoreOpen = null;
  renderDetail();
  toast(saved ? "Scorecard saved" : "Your scorecard was removed");
}

async function onScorecardClick(e) {
  const t = e.target.closest("[data-score],[data-check],[data-score-open],[data-score-cancel],[data-score-save]");
  const l = app.byKey[app.detailKey];
  if (!t || !l) return;
  if (!app.me) return;
  if (t.dataset.scoreSave !== undefined) return saveMyScorecard(l, t);
  if (t.dataset.scoreOpen !== undefined) app.scoreOpen = l.key;
  else if (t.dataset.scoreCancel !== undefined) {
    setDraft(l.key, savedCard(l.key) ?? {});
    app.scoreOpen = null;
  } else {
    const card = cleanScorecard(myCard(l.key));
    card.note = $("score-note")?.value ?? card.note; // keep the note exactly as typed
    if (t.dataset.score) {
      const v = Number(t.dataset.value);
      if (card.ratings[t.dataset.score] === v) delete card.ratings[t.dataset.score]; // tap again to clear
      else card.ratings[t.dataset.score] = v;
    } else {
      const v = t.dataset.value === "yes";
      card[t.dataset.check] = card[t.dataset.check] === v ? null : v;
    }
    setDraft(l.key, card);
  }
  renderScorecard();
}

// Redraw without losing what's being typed: put the focus and cursor back in the same box.
function keepTyping(box, draw) {
  const el = document.activeElement;
  const id = el && box.contains(el) && el.id && /^(INPUT|TEXTAREA)$/.test(el.tagName) ? el.id : null;
  const typed = id && { value: el.value, start: el.selectionStart, end: el.selectionEnd };
  draw();
  const again = id && document.getElementById(id);
  if (!again) return;
  again.value = typed.value;
  again.focus({ preventScroll: true });
  again.setSelectionRange?.(typed.start, typed.end);
}

// ---------- Compare (from the Shortlist) ----------

function compareStart(items) {
  if (items.length < 2) return "";
  return `<div class="compare-start"><span class="muted small">${items.length} houses</span><button class="pill" type="button" data-compare-start><i class="ti ti-layout-columns" aria-hidden="true"></i> Compare</button></div>`;
}

function setPicks(picks) {
  app.picks = picks;
  prefs.set("comparePicks", picks);
}

function renderPicking(items) {
  const onList = new Set(items.map((l) => l.key));
  if (app.picks.some((k) => !onList.has(k))) setPicks(app.picks.filter((k) => onList.has(k)));
  const n = app.picks.length;
  $("shortlist").innerHTML = `
    <p class="small" style="margin:0 0 4px"><b>Pick 2 or 3 houses</b> to see side by side.</p>
    ${items.map((l) => pickRow(l, app.picks.indexOf(l.key) + 1)).join("")}
    <div class="compare-bar">
      <button class="btn" type="button" data-compare-done>Done</button>
      <button class="btn btn-ink" type="button" data-compare-go ${n >= 2 ? "" : "disabled"}>${n >= 2 ? `Compare ${n}` : `Pick ${2 - n} more`}</button>
    </div>`;
}

function renderCompare() {
  const houses = app.picks.map((k) => app.byKey[k]).filter(Boolean);
  $("compare").innerHTML = `<div class="sheet-grab"></div>
    <h2 class="serif" style="font-size:30px;margin:0 0 10px">Compare</h2>
    ${compareHtml(houses, compareRows(houses, store.state, members))}`;
}

function onShortlistClick(e) {
  const t = e.target.closest("[data-pick],[data-compare-start],[data-compare-done],[data-compare-go]");
  if (!t) return;
  if (t.dataset.compareGo !== undefined) {
    renderCompare();
    $("compare-sheet").showModal();
    $("compare-sheet").scrollTop = 0;
    return;
  }
  if (t.dataset.pick) {
    const next = togglePick(app.picks, t.dataset.pick);
    if (next.full) return toast(`Compare up to ${MAX_COMPARE} houses at a time. Tap one to drop it first.`);
    setPicks(next.picks);
  } else {
    app.picking = t.dataset.compareStart !== undefined;
  }
  renderShortlist();
}

function bindViewing() {
  $("detail").addEventListener("click", onScorecardClick);
  $("detail").addEventListener("input", (e) => {
    if (e.target.id !== "score-note" || !app.detailKey) return;
    setDraft(app.detailKey, { ...cleanScorecard(myCard(app.detailKey)), note: e.target.value });
    syncScoreButtons(app.detailKey);
  });
  $("detail-sheet").addEventListener("close", () => (app.scoreOpen = null));
  $("shortlist").addEventListener("click", onShortlistClick);
}

// ---------- Filters ----------

function openFilters() {
  const f = app.filters;
  $("f-size").innerHTML = [null, 2, 3, 4, 5].map((n) =>
    `<button class="pill ${f.groupSize === n ? "on" : ""}" type="button" data-size="${n ?? ""}">${n ? n : "Any"}</button>`).join("");
  $("f-walk").innerHTML = [15, 30, 45, 60, 0].map((n) =>
    `<button class="pill ${f.maxWalk === n ? "on" : ""}" type="button" data-walk="${n}">${n ? `${n} min` : "Any"}</button>`).join("");
  $("f-min").value = f.minBudget;
  $("f-max").value = f.maxBudget;
  $("f-util").checked = f.utilitiesOnly;
  updateBudgetOut();
  $("filter-sheet").showModal();
}

function updateBudgetOut() {
  const lo = Number($("f-min").min), hi = Number($("f-min").max);
  const a = Number($("f-min").value), b = Number($("f-max").value);
  $("f-budget-out").textContent = budgetLabel(a, b);
  $("f-fill").style.left = `${((a - lo) / (hi - lo)) * 100}%`;
  $("f-fill").style.width = `${((b - a) / (hi - lo)) * 100}%`;
}

function setFilters(patch) {
  app.filters = { ...app.filters, ...patch };
  prefs.set("filters", app.filters);
  render();
}

// ---------- invite links ----------

// Keep the invite from a #join= link (or the old single-group code) until it's been used, even
// through signing up. Returns true if there was one.
function rememberInvite() {
  const fromHash = parseJoinHash(location.hash);
  const old = prefs.get("code"); // before accounts: Anna's group's code, which is now its invite
  if (old) prefs.set("code", null);
  const invite = fromHash || old;
  if (!invite) return false;
  prefs.set("invite", invite);
  // On iPhone the link stays in the address bar until they've joined, so Add to Home Screen
  // keeps it and the Home Screen app knows which group to open.
  if (currentInstallState(installPrompt) !== "ios-safari") stripJoinHash();
  return true;
}

function stripJoinHash() {
  if (parseJoinHash(location.hash)) history.replaceState(null, "", location.pathname + location.search);
}

// Paste an invite link to join another group (Group tab). The join screen takes it from there.
function joinForm() {
  return `<form class="join-form" data-join-form>
      <input name="invite" placeholder="Paste invite link" aria-label="Invite link" autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="go">
      <button class="btn btn-ink" type="submit" style="padding:9px 16px">Join</button>
    </form>
    <div class="field-error" data-join-error></div>`;
}

async function joinWithInvite(form) {
  const error = form.parentElement.querySelector("[data-join-error]");
  const invite = parseInviteInput(form.elements.invite.value);
  if (!invite) {
    error.textContent = "That's not an invite link. Copy the whole link from your group chat (it ends in #join=…).";
    return;
  }
  // Check it first, so a typo shows here instead of on a screen you'd have to back out of
  const button = form.querySelector("button");
  button.disabled = true;
  try {
    if (!(await directory().groupPreview(invite))) throw new GroupError("bad invite");
  } catch (err) {
    error.textContent = err.message;
    button.disabled = false;
    return;
  }
  prefs.set("invite", invite);
  location.reload();
}

// ---------- before the app: sign in, pick a group, Home Screen ----------

// A store for the calls that don't need a group yet (my groups, invites, starting one)
const directory = () => new SupabaseGroupStore({ ...CONFIG.supabase, auth });

let gateWaiter = null;

function showGate(html) {
  $("gate-inner").innerHTML = html;
  $("gate").hidden = false;
  $("gate").scrollTop = 0;
}

function hideGate() {
  $("gate").hidden = true;
  gateWaiter = null;
}

// The next thing done on the gate screen: a form sent ({ form, data }) or a button tapped
// ({ action } for data-gate, { claim } for a name, { group } for one of my groups).
function nextAction() {
  return new Promise((resolve) => (gateWaiter = resolve));
}

function bindGate() {
  const send = (a) => {
    const fn = gateWaiter;
    gateWaiter = null;
    fn?.(a);
  };
  $("gate").addEventListener("submit", (e) => {
    e.preventDefault();
    send({ form: e.target.id, data: Object.fromEntries(new FormData(e.target)) });
  });
  $("gate").addEventListener("click", (e) => {
    const b = e.target.closest("[data-gate],[data-claim],[data-pick-group]");
    if (b) send({ action: b.dataset.gate, claim: b.dataset.claim, group: b.dataset.pickGroup });
  });
  $("gate").addEventListener("input", (e) => {
    const box = e.target.closest("form")?.parentElement;
    for (const el of box?.querySelectorAll("[data-gate-error],[data-paste-error]") || []) el.textContent = "";
  });
}

// Greys out the screen's buttons while a request is out, so a double tap can't send it twice.
async function busy(work) {
  const buttons = [...$("gate").querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    return await work();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

// Sign up, sign in, or reset a forgotten password. Resolves once signed in.
async function signInScreen(dir, invite) {
  const preview = invite ? await dir.groupPreview(invite).catch(() => null) : null;
  let email = prefs.get("email") || "";
  // Returning (this phone signed in before, or it's the Home Screen app): sign in. New: sign up.
  let mode = email || currentInstallState(installPrompt) === "installed" ? "signin" : "signup";
  let message = "";
  let verified = false; // the reset code worked; only the new password is left to save
  for (;;) {
    if (mode === "signup" || mode === "signin") showGate(authHtml({ mode, preview, email, message }));
    else showGate(forgotHtml({ step: mode === "forgot" ? "email" : "code", email, message }));
    const a = await nextAction();
    message = "";
    if (a.action === "resend") {
      try {
        await busy(() => auth.sendResetCode(email));
        toast("New code sent");
      } catch (err) {
        message = err.message;
      }
      continue;
    }
    if (a.action) {
      mode = a.action; // signin, signup or forgot
      continue;
    }
    email = cleanEmail(a.data.email ?? email);
    const password = a.data.password ?? "";
    if (!email) {
      message = "Type your email.";
      continue;
    }
    if (a.form !== "gate-forgot-email" && password.length < MIN_PASSWORD) {
      message = mode === "signin" && !password ? "Type your password." : `Use at least ${MIN_PASSWORD} characters for your password.`;
      continue;
    }
    try {
      await busy(async () => {
        if (a.form === "gate-auth" && mode === "signup") await auth.signUp(email, password);
        else if (a.form === "gate-auth") await auth.signIn(email, password);
        else if (a.form === "gate-forgot-email") await auth.sendResetCode(email);
        else {
          if (!verified) await auth.verifyResetCode(email, a.data.code);
          verified = true;
          await auth.setPassword(password);
        }
      });
    } catch (err) {
      message = err.message;
      continue;
    }
    prefs.set("email", email);
    if (a.form === "gate-forgot-email") {
      mode = "code";
      continue;
    }
    if (a.form === "gate-forgot-code") toast("Password changed");
    return;
  }
}

// Joining from an invite. Resolves { id } once in the group, or { id: null } to skip it.
async function joinScreen(dir, invite, groups) {
  const preview = await dir.groupPreview(invite);
  if (!preview) return { id: null, message: "That invite link isn't valid any more. Ask your group for a new one." };
  // Opened the link again after joining: just open the group
  for (const g of groups.filter((x) => x.name === preview.name)) {
    const probe = new SupabaseGroupStore({ ...CONFIG.supabase, auth, group: g.id });
    if (await probe.load().then(() => probe.info.invite === invite, () => false)) return { id: g.id };
  }
  let message = "";
  for (;;) {
    showGate(joinHtml({ preview, message }));
    const a = await nextAction();
    if (a.action === "skip-invite") return { id: null, startNew: preview.full };
    const name = (a.claim ?? a.data?.name ?? "").trim();
    if (!name) {
      message = "Type your first name.";
      continue;
    }
    try {
      return { id: await busy(() => dir.joinGroup(invite, name)) };
    } catch (err) {
      message = err.message;
    }
  }
}

// Pick one of my groups, start one, or paste an invite. Resolves { id }, { invite }, or { id: null } (cancelled).
async function startScreen(dir, groups, { canCancel = false, pasteMessage = "" } = {}) {
  let message = "";
  for (;;) {
    showGate(startHtml({ groups, message, pasteMessage, canCancel }));
    const a = await nextAction();
    message = pasteMessage = "";
    if (a.group) return { id: a.group };
    if (a.action === "cancel") return { id: null };
    if (a.action === "signout") return signOut();
    if (a.form === "gate-paste") {
      const invite = parseInviteInput(a.data.invite);
      if (invite) return { invite };
      pasteMessage = "That's not an invite link. Copy the whole link from your group chat (it ends in #join=…).";
      continue;
    }
    const group = (a.data?.group || "").trim();
    const name = (a.data?.name || "").trim();
    if (!group || !name) {
      message = !group ? "Give your group a name." : "Type your first name.";
      continue;
    }
    try {
      return { id: (await busy(() => dir.createGroup(group, name))).id };
    } catch (err) {
      message = err.message;
    }
  }
}

// Signed in and into a group, by the shortest way: the group this phone used last, an invite
// waiting to be used, my only group, or the picker.
async function openGroup(shared) {
  for (;;) {
    try {
      if (!auth.signedIn) await signInScreen(shared, prefs.get("invite"));
      let invite = prefs.get("invite");
      const last = prefs.get("group");
      if (last && !invite) {
        shared.group = last;
        try {
          await shared.load();
          if (shared.info.me) return;
        } catch (err) {
          if (!/not in this group/i.test(err.raw || "")) throw err;
        }
      }
      const groups = await shared.myGroups();
      let id = null;
      let pasteMessage = "";
      let pick = false; // show the picker even with one group
      while (!id) {
        if (invite) {
          const joined = await joinScreen(shared, invite, groups);
          prefs.set("invite", null);
          stripJoinHash();
          invite = null;
          id = joined.id;
          pasteMessage = joined.message || "";
          pick = Boolean(joined.startNew || joined.message);
        } else if (groups.length === 1 && !pick) {
          id = groups[0].id;
        } else {
          const picked = await startScreen(shared, groups, { pasteMessage });
          pasteMessage = "";
          invite = picked.invite || null;
          id = picked.id || null;
        }
      }
      shared.group = id;
      prefs.set("group", id);
      await shared.load();
      return;
    } catch (err) {
      if (/sign in first|jwt/i.test(err.raw || "")) {
        await auth.signOut(); // the sign-in ran out: sign in again
        continue;
      }
      console.error(err);
      showGate(problemHtml(err.message));
      if ((await nextAction()).action === "signout") return signOut();
    }
  }
}

// On a phone browser, once: offer the Home Screen. Android installs in one tap; iPhone gets the steps.
async function installStep() {
  const state = currentInstallState(installPrompt);
  if (prefs.get("installStep") === "done" || (state !== "ios-safari" && state !== "android-prompt")) return;
  showGate(installHtml(state));
  for (;;) {
    const a = await nextAction();
    if (a.action === "install") {
      if (await promptInstall(installPrompt)) toast("Installed. Next time, open House Hunt from your Home Screen");
      break;
    }
    if (a.action === "skip-install") break;
  }
  prefs.set("installStep", "done");
}

// ---------- events ----------

function bindEvents() {
  document.querySelector(".tabbar").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (b) setTab(b.dataset.tab);
  });

  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-open],[data-share],[data-filters],[data-order],[data-tab-go],[data-scroll],[data-close],[data-view]");
    if (!t) return;
    if (t.dataset.open !== undefined) openDetail(t.dataset.open);
    else if (t.dataset.view) setHomeView(t.dataset.view);
    else if (t.dataset.share !== undefined) share(t.dataset.share);
    else if (t.dataset.filters !== undefined) openFilters();
    else if (t.dataset.order !== undefined) toggleOrder();
    else if (t.dataset.tabGo) setTab(t.dataset.tabGo);
    else if (t.dataset.scroll) $(t.dataset.scroll).scrollIntoView({ behavior: "smooth" });
    else if (t.dataset.close !== undefined) t.closest("dialog")?.close();
  });

  // A join link opened while the app is already open only changes the #part, without reloading
  window.addEventListener("hashchange", () => {
    if (rememberInvite()) location.reload(); // the join screen comes up on the way back in
  });

  // Saving to the group failed (offline, bad link...): explain, and redraw with what's really saved.
  window.addEventListener("unhandledrejection", (e) => {
    if (!(e.reason instanceof GroupError)) return;
    e.preventDefault();
    toast(e.reason.message);
    deck.show([]); // a swiped card may be mid-flight off screen: rebuild so it comes back
    render();
  });

  $("me-chip").onclick = () => setTab("group");
  $("btn-like").onclick = () => deck.swipe("like");
  $("btn-pass").onclick = () => deck.swipe("pass");
  $("btn-info").onclick = () => deck.flip();
  $("btn-undo").onclick = undoLast;
  $("match-keep").onclick = () => ($("match").hidden = true);

  document.addEventListener("keydown", (e) => {
    if (app.tab !== "discover" || document.querySelector("dialog[open]") || !$("gate").hidden) return;
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "ArrowRight") deck.swipe("like");
    else if (e.key === "ArrowLeft") deck.swipe("pass");
    else if (e.key === " " || e.key === "Enter") { e.preventDefault(); deck.flip(); }
    else if (e.key === "z" && (e.metaKey || e.ctrlKey)) undoLast();
  });

  $("sort").onchange = (e) => {
    app.sort = e.target.value;
    prefs.set("sort", app.sort);
    render();
  };

  // Detail sheet actions
  $("detail").addEventListener("click", async (e) => {
    const v = e.target.closest("[data-vote]");
    const s = e.target.closest("[data-status]");
    const l = app.byKey[app.detailKey];
    if (!l) return;
    if (v) {
      if (!app.me) return;
      const current = (store.state.votes[l.key] || {})[app.me];
      const next = current === v.dataset.vote ? null : v.dataset.vote; // tap again to clear
      if (next) await castVote(l, next);
      else { await store.vote(l.key, app.me, null); render(); }
      renderDetail();
    } else if (s) {
      if (!app.me) return;
      await store.setStatus(l.key, s.dataset.status, app.me);
      render();
      renderDetail();
    }
  });
  $("detail").addEventListener("submit", async (e) => {
    if (e.target.id !== "note-form") return;
    e.preventDefault();
    if (!app.me) return;
    const ok = await store.addNote(app.detailKey, app.me, $("note-input").value);
    if (!ok) {
      $("note-error").textContent = "Write something first.";
      return;
    }
    renderDetail();
  });
  $("detail").addEventListener("input", (e) => {
    if (e.target.id === "note-input") $("note-error").textContent = "";
  });
  $("detail-sheet").addEventListener("close", () => (app.detailKey = null));

  // Paste-to-join, in the banner and on the Group tab
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-join-form]");
    if (!form) return;
    e.preventDefault();
    joinWithInvite(form);
  });
  document.addEventListener("input", (e) => {
    const form = e.target.closest("[data-join-form]");
    if (form) form.parentElement.querySelector("[data-join-error]").textContent = "";
  });

  // Group tab
  $("group").addEventListener("submit", (e) => {
    if (e.target.id === "budget-form") saveBudget(e);
  });
  $("group").addEventListener("input", (e) => {
    if (e.target.id === "budget-input") $("budget-error").textContent = "";
  });
  $("group").addEventListener("change", (e) => {
    if (e.target.id === "budget-input") e.target.form.requestSubmit();
  });
  $("group").addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.id === "alerts-on") alertsOn();
    else if (t.id === "alerts-off") alertsOff();
    else if (t.id === "share-invite") shareInvite();
    else if (t.id === "copy-invite") copyInvite();
    else if (t.id === "install-app") installFromButton();
    else if (t.id === "start-another") startAnother(t);
    else if (t.id === "leave-group") leaveGroup();
    else if (t.id === "sign-out") signOut();
    else if (t.dataset.switchGroup) {
      prefs.set("group", t.dataset.switchGroup);
      location.reload();
    }
  });

  // Filters
  $("f-size").addEventListener("click", (e) => {
    const b = e.target.closest("[data-size]");
    if (!b) return;
    setFilters({ groupSize: b.dataset.size ? Number(b.dataset.size) : null });
    for (const x of $("f-size").children) x.classList.toggle("on", x === b);
  });
  $("f-walk").addEventListener("click", (e) => {
    const b = e.target.closest("[data-walk]");
    if (!b) return;
    setFilters({ maxWalk: Number(b.dataset.walk) });
    for (const x of $("f-walk").children) x.classList.toggle("on", x === b);
  });
  for (const id of ["f-min", "f-max"]) {
    $(id).addEventListener("input", () => {
      let a = Number($("f-min").value), b = Number($("f-max").value);
      if (a > b) {
        if (id === "f-min") $("f-max").value = b = a;
        else $("f-min").value = a = b;
      }
      updateBudgetOut();
    });
    $(id).addEventListener("change", () => setFilters({ minBudget: Number($("f-min").value), maxBudget: Number($("f-max").value) }));
  }
  $("f-util").onchange = (e) => setFilters({ utilitiesOnly: e.target.checked });
  $("f-reset").onclick = () => {
    setFilters({ ...DEFAULT_FILTERS, groupSize: members.length >= 2 && members.length <= 5 ? members.length : null });
    openFilters();
  };
  // Tap outside a sheet closes it
  for (const dlg of document.querySelectorAll("dialog.sheet")) {
    dlg.addEventListener("click", (e) => {
      if (e.target === dlg) dlg.close();
    });
  }
  bindViewing();
  bindGate();
  // Chrome's install offer can arrive after the Group tab is drawn
  installPrompt.listeners.push(() => app.tab === "group" && store && renderGroup());
}

// ---------- start ----------

// Signed in to a group through Supabase, or practice mode (this phone only) without it.
async function connectStore() {
  const sb = CONFIG.supabase;
  if (!sb?.url || !sb?.anonKey) {
    const local = new LocalGroupStore();
    await local.load();
    app.me = PRACTICE_NAME;
    hideGate();
    return local;
  }
  auth = new Auth(sb);
  // Signed out in another tab, or the sign-in couldn't be renewed: back to the sign-in screen
  auth.onChange((signedIn) => !signedIn && location.reload());
  const shared = new SupabaseGroupStore({ ...sb, auth });
  await openGroup(shared);
  await installStep();
  hideGate();
  shared.startPolling();
  members = shared.members;
  app.me = shared.info.me;
  return shared;
}

// A tapped alert opens ?tab=shortlist or ?tab=discover. Take it, then tidy the address.
function handleTabLink() {
  const params = new URLSearchParams(location.search);
  const tab = params.get("tab");
  if (!tab) return;
  if (document.getElementById(`tab-${tab}`)) app.tab = tab;
  params.delete("tab");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
}

async function start() {
  rememberInvite();
  handleTabLink();
  bindEvents();
  // The service worker shows phone alerts (sw.js). It caches nothing, so it never serves stale pages.
  if (pushSupported(window)) navigator.serviceWorker.register("sw.js").catch((err) => console.warn("No service worker", err));
  const listings = loadListings().catch((err) => ({ err })); // download while signing in
  store = await connectStore();
  voting = new Voting(store, () => members);
  store.onChange((state, info) => {
    if (store.shared) {
      members = store.members; // someone joined or left
      app.me = store.info.me;
    }
    if (info?.remote) render(); // someone else's change (another tab, or the group database)
    if (app.detailKey && $("detail-sheet").open) keepTyping($("detail"), renderDetail);
    if ($("compare-sheet").open) renderCompare();
  });

  // First visit: default the group-size filter to the number of people in the group.
  if (!prefs.get("filters") && members.length >= 2 && members.length <= 5) {
    app.filters.groupSize = members.length;
  }

  try {
    const { data, sample, err } = await listings;
    if (err) throw err;
    app.listings = data.listings.filter((l) => l && l.key);
    app.byKey = Object.fromEntries(app.listings.map((l) => [l.key, l]));
    // "New for me" = not here on my previous visit (tracked by house, so no date or time-zone mix-ups)
    app.seen = visitBaseline(app.listings.map((l) => l.key));
    app.sample = sample;
    app.lastRun = data.last_run;
    if (sample) {
      $("data-banner").hidden = false;
      $("data-banner").textContent = "These are sample houses. Real listings appear here after the scraper's first run.";
    }
  } catch (err) {
    $("data-banner").hidden = false;
    $("data-banner").textContent = "Couldn't load listings. Check your connection and refresh.";
    console.error(err);
  }

  setTab(app.tab);
  syncAlerts();
}

start();
