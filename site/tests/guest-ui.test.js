import { test } from "node:test";
import assert from "node:assert/strict";
import { GUEST_NAME, fitsCount, guestDetailHtml, guestGroupHtml, hookHtml, houseType, votesToBring } from "../js/guest-ui.js";
import { authHtml } from "../js/onboard-ui.js";

test("votes made before signing up come along, without overwriting votes already in the group", () => {
  const guest = { votes: { a: { [GUEST_NAME]: "like" }, b: { [GUEST_NAME]: "pass" }, c: { [GUEST_NAME]: "like" }, d: {} } };
  const group = { votes: { c: { Anna: "pass" }, b: { Anna: "like", Julie: "like" } } };
  assert.deepEqual(votesToBring(guest, group, "Julie"), [{ key: "a", vote: "like" }, { key: "c", vote: "like" }]);
  assert.deepEqual(votesToBring({ votes: {} }, group, "Julie"), []);
  assert.deepEqual(votesToBring(null, group, "Julie"), []);
});

test("house type: named from what was liked, and a fallback when nothing was", () => {
  assert.equal(houseType({ likes: 0 }).name, "The Picky One");
  assert.equal(houseType({ likes: 4, maxWalk: 8, sweetSpot: { median: 1000 } }).name, "The Roll-Out-of-Bed Walker");
  assert.equal(houseType({ likes: 4, maxWalk: 20, sweetSpot: { median: 800 } }).name, "The Bargain Hunter");
  assert.equal(houseType({ likes: 4, maxWalk: 20, sweetSpot: { median: 1000 }, bedrooms: 5 }).name, "The Big House Person");
  assert.equal(houseType({ likes: 4, maxWalk: 20, sweetSpot: { median: 950 }, bedrooms: 4 }).name, "The All-Rounder");
});

test("houses that fit my type: unvoted, about my price and walk", () => {
  const listings = [
    { key: "a", price_per_person: 900, walk_min_huron: 10 },
    { key: "b", price_per_person: 1400, walk_min_huron: 10 },
    { key: "c", price_per_person: 900, walk_min_huron: 40 },
    { key: "d", price_per_person: 900, walk_min_huron: 10 },
  ];
  const state = { votes: { d: { [GUEST_NAME]: "like" } } };
  const profile = { sweetSpot: { high: 950 }, maxWalk: 15 };
  assert.equal(fitsCount(listings, state, profile), 1); // only a: b costs too much, c is too far, d is voted
  assert.equal(fitsCount(listings, state, { likes: 0 }), 0);
});

test("the guest screens push toward an account, and other text is escaped", () => {
  const hook = hookHtml({ profile: { likes: 3, neighbourhoods: ['<img src=x>'], sweetSpot: { median: 900 } }, likes: 3, fits: 12 });
  assert.match(hook, /data-guest="signup"/);
  assert.match(hook, /Your 3 likes come with you/);
  assert.match(hook, /12 more houses/);
  assert.ok(!hook.includes("<img"));
  assert.match(guestGroupHtml({ profile: { likes: 0 }, likes: 0, votes: 0 }), /data-guest="signin"/);
  assert.match(guestDetailHtml(), /Sign up to open the listing/);
});

test("the sign-in screen can go back to looking around", () => {
  assert.match(authHtml({ browse: true }), /data-gate="browse"/);
  assert.ok(!authHtml({}).includes('data-gate="browse"'));
});
