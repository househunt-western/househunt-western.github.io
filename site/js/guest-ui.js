// Looking around without an account: anyone can swipe and browse, saved on this phone. Listing
// links, matching with friends, notes and alerts need an account. The hook is "Your house type",
// a read of what you've liked, and the promise that your likes come with you into your group.
import { costOf, money, walkOf } from "./logic.js";
import { esc } from "./ui.js";

export const GUEST_NAME = "You"; // the one voter on this phone before signing up
export const GUEST_STORE_KEY = "lh_guest_v1";
export const HOOK_AT = 5; // votes before "Your house type" pops up

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A name for what someone has liked so far, from recommend.js's groupProfile for one person.
export function houseType(profile) {
  const price = profile?.sweetSpot?.median ?? null;
  const walk = profile?.maxWalk ?? null;
  const beds = profile?.bedrooms ?? null;
  if (!profile?.likes) return { name: "The Picky One", line: "Nothing's good enough yet. Fair: you'll live there all year." };
  if (walk !== null && walk <= 10) return { name: "The Roll-Out-of-Bed Walker", line: "Close to Huron wins. Ten minutes, tops." };
  if (price !== null && price <= 850) return { name: "The Bargain Hunter", line: "You'd rather keep the rent low and spend it on everything else." };
  if (beds !== null && beds >= 5) return { name: "The Big House Person", line: "The more people under one roof, the better." };
  if (price !== null && price >= 1100) return { name: "The Nice-Place Person", line: "You'll pay more for somewhere you actually like coming home to." };
  return { name: "The All-Rounder", line: "Fair price, fair walk, no drama." };
}

// Houses I haven't voted on that look like what I've liked: about my price and my walk.
export function fitsCount(listings, state, profile, me = GUEST_NAME) {
  const top = profile?.sweetSpot?.high;
  if (!top) return 0;
  const walk = profile.maxWalk;
  return listings.filter((l) => {
    if ((state.votes[l.key] || {})[me]) return false;
    const cost = costOf(l);
    const w = walkOf(l);
    return cost !== null && cost <= top + 50 && (walk === null || w === null || w <= walk + 5);
  }).length;
}

// The votes made before signing up that my group doesn't have from me yet: [{ key, vote }].
export function votesToBring(guestState, groupState, me, guestName = GUEST_NAME) {
  return Object.entries(guestState?.votes || {})
    .map(([key, v]) => ({ key, vote: v?.[guestName] }))
    .filter(({ key, vote }) => (vote === "like" || vote === "pass") && !(groupState.votes[key] || {})[me]);
}

function typeCard(profile, likes) {
  const type = houseType(profile);
  const chips = [
    profile?.bedrooms && `${profile.bedrooms} bed`,
    profile?.sweetSpot && `~${money(profile.sweetSpot.median)}/person`,
    profile?.maxWalk != null && `≤${profile.maxWalk} min walk`,
    ...(profile?.neighbourhoods || []),
  ].filter(Boolean);
  return `<div class="type-card">
      <div class="muted tiny">Your house type</div>
      <div class="serif type-name">${esc(type.name)}</div>
      <div class="small muted">${esc(type.line)}</div>
      ${chips.length ? `<div class="chips" style="justify-content:center;margin-top:10px">${chips.map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>` : ""}
      <div class="faint tiny" style="margin-top:8px">From your ${plural(likes, "like")}</div>
    </div>`;
}

const perks = `<ul class="perks">
    <li><i class="ti ti-heart-handshake" aria-hidden="true"></i><span><b>Matches.</b> Every house all of you like lights up, so you stop arguing in the group chat.</span></li>
    <li><i class="ti ti-external-link" aria-hidden="true"></i><span><b>The listing.</b> Open the real ad to message the landlord.</span></li>
    <li><i class="ti ti-notes" aria-hidden="true"></i><span><b>Viewings.</b> Notes, statuses and scorecards, shared with your group.</span></li>
    <li><i class="ti ti-bell" aria-hidden="true"></i><span><b>Alerts.</b> A ping when a new house fits all of you.</span></li>
  </ul>`;

// The pop-up after a few swipes. fits: how many more houses look like my type.
export function hookHtml({ profile, likes, fits }) {
  return `
    ${typeCard(profile, likes)}
    <h2 style="font-size:32px;margin-top:18px">Now find who matches</h2>
    <p class="muted">Start a group and send the link. Every house you all like becomes a match.${likes ? ` Your ${plural(likes, "like")} come with you.` : ""}</p>
    ${fits ? `<p class="small"><b>${plural(fits, "more house")}</b> on the list look like your type.</p>` : ""}
    <button class="btn btn-ink wide" type="button" data-guest="signup">Start a group</button>
    <button class="text-link" type="button" data-guest="close">Keep swiping</button>`;
}

// The Group tab before signing up.
export function guestGroupHtml({ profile, likes, votes }) {
  return `
    ${votes ? typeCard(profile, likes) : ""}
    <h2 class="serif" style="font-size:34px;margin:18px 0 4px">Better with your group</h2>
    <p class="muted small" style="margin-top:0">${votes
      ? `You've swiped ${plural(votes, "house")} on this phone. Make an account and they come with you.`
      : "Swipe on your own first if you like. Your votes come with you when you make an account."}</p>
    ${perks}
    <button class="btn btn-ink wide" type="button" data-guest="signup">Create account</button>
    <p class="small muted" style="text-align:center">Already have one? <button class="text-link" type="button" data-guest="signin">Sign in</button></p>
    <p class="muted tiny" style="text-align:center">Free. Takes about 20 seconds. Up to 5 people per group.</p>`;
}

// Where the group parts of a house's page would be.
export function guestDetailHtml() {
  return `
    <div class="locked">
      <i class="ti ti-lock" aria-hidden="true"></i>
      <div><b>Sign up to open the listing</b><div class="muted small">and to share notes, statuses and viewing scorecards with your group.</div></div>
    </div>
    <button class="btn btn-ink wide" type="button" data-guest="signup" style="margin-top:10px">Create account</button>`;
}

// The Shortlist before signing up: my own likes, and what a group would add.
export function guestShortlistNote(likes) {
  return `<div class="banner"><i class="ti ti-users" aria-hidden="true"></i> ${likes ? "Your likes, saved on this phone." : "Houses you like collect here."} With a group, the houses you <b>all</b> like go to the top as matches. <button class="text-link" type="button" data-guest="signup">Start a group</button></div>`;
}
