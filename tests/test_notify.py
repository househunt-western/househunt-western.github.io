import base64
import json
import logging
import stat

import pytest
import requests
from pywebpush import WebPushException

from scraper import notify as nt

SITE = "https://me.github.io/london-housing/"
PRIVATE, PUBLIC = nt.new_keys()


def listing(i, cost=1000, **kw):
    base = dict(key=f"western_och:{i}", title=f"{i} Test St", url=f"https://offcampus.uwo.ca/Listings/Details/{i}",
                is_new=True, active=True, est_cost_per_person=cost, price_per_person=cost, utilities_included="yes",
                bedrooms=4, baths=2, walk_min_huron=12, walk_min_campus=10, lease_start="2027-05-01")
    base.update(kw)
    return base


G1, G2 = "11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222"


def phone(member, n=1, push="https://web.push.apple.com", group=G1):
    endpoint = f"{push}/{member.lower()}-{n}" + ("" if group == G1 else f"-{group[:2]}")
    return {"endpoint": endpoint, "group_id": group, "member": member,
            "subscription": {"endpoint": endpoint, "keys": {"p256dh": "p", "auth": "a"}}}


# ---------- a stand-in for Supabase's REST API ----------

class FakeResponse:
    def __init__(self, status=200, body=None):
        self.status_code = status
        self._body = body
        self.text = json.dumps(body) if body is not None else ""

    def json(self):
        if self._body is None:
            raise ValueError("no body")
        return self._body


class FakeSupabase:
    """Answers like PostgREST would, from in-memory tables. Set fail[table] = (status, message) to break one."""

    def __init__(self, push_subs=(), members=(), votes=(), push_sent=()):
        self.headers = {}
        self.tables = {"push_subs": list(push_subs), "group_members": list(members), "votes": list(votes),
                       "push_sent": list(push_sent)}
        self.fail = {}
        self.calls = []

    def _table(self, url):
        return url.rsplit("/rest/v1/", 1)[1]

    @staticmethod
    def _matches(row, filters):
        return all(str(row.get(col)) == value[3:] for col, value in filters.items())

    def get(self, url, params=None, timeout=None):
        table = self._table(url)
        self.calls.append(("GET", table, dict(params)))
        if table in self.fail:
            status, message = self.fail[table]
            return FakeResponse(status, {"message": message})
        params = dict(params)
        cols = params.pop("select").split(",")
        params.pop("order")
        limit, offset = params.pop("limit"), params.pop("offset")
        rows = [r for r in self.tables[table] if self._matches(r, params)]
        return FakeResponse(200, [{c: r.get(c) for c in cols} for r in rows[offset:offset + limit]])

    def post(self, url, json=None, headers=None, timeout=None):
        table = self._table(url)
        self.calls.append(("POST", table, json, headers))
        if table in self.fail:
            status, message = self.fail[table]
            return FakeResponse(status, {"message": message})
        pk = lambda r: (r["group_id"], r["kind"], r["listing_key"])  # push_sent's primary key
        have = {pk(r) for r in self.tables[table]}
        self.tables[table] += [r for r in json if pk(r) not in have]
        return FakeResponse(201)

    def delete(self, url, params=None, timeout=None):
        table = self._table(url)
        self.calls.append(("DELETE", table, dict(params)))
        self.tables[table] = [r for r in self.tables[table] if not self._matches(r, params)]
        return FakeResponse(204)


class FakePush:
    """Stands in for pywebpush.webpush. Like the real one, it writes 'aud' into the claims it's given."""

    def __init__(self, answers=None):
        self.sent = []
        self.answers = answers or {}  # endpoint -> HTTP status, or an exception to raise

    def __call__(self, subscription_info, data, vapid_private_key, vapid_claims, **kw):
        assert "aud" not in vapid_claims, "claims dict was reused from another phone"
        vapid_claims["aud"] = subscription_info["endpoint"].split("/")[2]
        answer = self.answers.get(subscription_info["endpoint"], 201)
        if isinstance(answer, Exception):
            raise answer
        if answer > 202:
            resp = FakeResponse(answer, {"reason": "BadJwtToken"})
            raise WebPushException(f"Push failed: {answer}", response=resp)
        self.sent.append({"endpoint": subscription_info["endpoint"], "payload": json.loads(data),
                          "claims": vapid_claims, "key": vapid_private_key, **kw})
        return FakeResponse(201)

    def to(self, member):
        return [s for s in self.sent if f"/{member.lower()}-" in s["endpoint"]]


@pytest.fixture
def site_config(tmp_path):
    path = tmp_path / "config.js"
    path.write_text(f'export const CONFIG = {{\n  vapidPublicKey: "{PUBLIC}",\n}};\n')
    return path


@pytest.fixture
def data_file(tmp_path):
    def write(listings):
        path = tmp_path / "listings.json"
        path.write_text(json.dumps({"last_run": "2026-10-23T11:00:00Z", "listings": listings}))
        return path
    return write


ENV = {"SUPABASE_URL": "https://abc.supabase.co", "SUPABASE_SERVICE_KEY": "sb_secret_x",
       "VAPID_PRIVATE_KEY": PRIVATE, "SITE_URL": SITE}
MEMBERS = [{"group_id": G1, "name": "Paxton", "budget_max": 1100, "position": 1},
           {"group_id": G1, "name": "Charlie", "budget_max": None, "position": 2},
           {"group_id": G1, "name": "Jack", "budget_max": 900, "position": 3}]


def member(name, group, budget=None, position=1):
    return {"group_id": group, "name": name, "budget_max": budget, "position": position}


def likes(key, *names, group=G1):
    return [{"group_id": group, "listing_key": key, "member": n, "vote": "like"} for n in names]


def run(db, push, data_path, site_config, *argv, env=ENV):
    return nt.main(["--data", str(data_path), *argv], env=env, send=push, session=db, site_config=site_config)


# ---------- choosing what to send ----------

def test_fits_uses_budget_or_default_and_a_walk_limit():
    assert nt.fits(listing(1, cost=1200), None)  # default budget is $1,200
    assert not nt.fits(listing(1, cost=1201), None)
    assert nt.fits(listing(1, cost=900), 900)
    assert not nt.fits(listing(1, cost=950), 900)
    assert not nt.fits(listing(1, walk_min_huron=46), 1500)
    assert nt.fits(listing(1, walk_min_huron=None, walk_min_campus=40), 1500)
    assert nt.fits(listing(1, walk_min_huron=None, walk_min_campus=None), 1500)  # unknown walk: same as the site
    assert not nt.fits(listing(1, est_cost_per_person=None, price_per_person=None), 1500)


def test_one_new_house_names_it_and_several_get_one_summary():
    one = nt.new_houses_alert([listing(5, cost=850, title="12  Oxford\nSt")], SITE)
    assert one.title == "New house: $850/person"
    assert one.body == "12 Oxford St · 4 bed · 2 bath · 12 min walk to Huron · May 1"
    assert one.url == SITE + "?tab=discover"
    assert one.tag == "new-houses"

    many = nt.new_houses_alert([listing(1, cost=1000), listing(2, cost=800), listing(3, cost=900)], SITE)
    assert many.title == "3 new houses fit your budget"
    assert many.body == "From $800/person (2 Test St). Tap to swipe through them."


def test_alert_links_never_carry_the_invite_code():
    invite = SITE + "#join=secret-group-code"
    assert nt.link(invite, "shortlist") == SITE + "?tab=shortlist"
    assert nt.site_base(invite + "?x=1") == SITE.rstrip("/") + "/"
    assert "secret" not in nt.Settings.from_env({**ENV, "SITE_URL": invite}).subject
    assert nt.link(None, "discover") == "./?tab=discover"  # sw.js resolves it to the site


def test_match_alerts_name_the_house_or_list_a_few():
    one = nt.match_alert([listing(7, cost=950, title="88 Huron St")], SITE)
    assert one.title == "Everyone liked 88 Huron St"
    assert one.body == "$950/person · 4 bed · 2 bath · 12 min walk to Huron · May 1. Time to book a viewing?"
    assert one.url == SITE + "?tab=shortlist"
    many = nt.match_alert([listing(i, cost=1000 - i) for i in range(1, 6)], SITE)
    assert many.title == "Everyone liked 5 houses"
    assert many.body == "5 Test St, 4 Test St, 3 Test St and 2 more. They're at the top of your Shortlist."


def test_a_match_is_everyone_liking_a_listed_house_not_yet_announced():
    houses = [listing(1), listing(2), listing(3, active=False), listing(4)]
    votes = (likes("western_och:1", "A", "B") + likes("western_och:2", "A") + likes("western_och:3", "A", "B")
             + likes("western_och:4", "A", "B"))
    found = nt.new_matches(houses, ["A", "B"], votes, already_sent={"western_och:4"})
    assert [l["key"] for l in found] == ["western_och:1"]
    assert nt.new_matches(houses, [], votes, set()) == []


def test_plan_gives_each_person_one_alert_within_their_own_budget():
    data = {"listings": [listing(1, cost=850), listing(2, cost=1050), listing(3, cost=1150), listing(4, is_new=False)]}
    subs = [phone("Paxton", 1), phone("Paxton", 2), phone("Charlie"), phone("Jack")]
    sends, match_keys = nt.plan(data, MEMBERS, subs, likes=[], already_sent=set(), site_url=SITE)
    by = {s.member: s for s in sends}
    assert by["Paxton"].alert.title == "2 new houses fit your budget"  # $1,100 budget
    assert len(by["Paxton"].phones) == 2  # both of Paxton's phones
    assert by["Charlie"].alert.title == "3 new houses fit your budget"  # no budget set: $1,200 default
    assert by["Jack"].alert.title == "New house: $850/person"  # $900 budget
    assert match_keys == []


def test_plan_skips_people_with_nothing_new_and_sends_matches_to_everyone():
    data = {"listings": [listing(1, cost=1150, is_new=False), listing(2, cost=1150)]}
    subs = [phone("Paxton"), phone("Jack")]
    votes = likes("western_och:1", "Paxton", "Charlie", "Jack")
    sends, match_keys = nt.plan(data, MEMBERS, subs, votes, set(), SITE)
    assert [(s.member, s.alert.tag) for s in sends] == [("Paxton", "match"), ("Jack", "match")]
    assert match_keys == [(G1, "western_och:1")]
    # votes couldn't be read: no match alerts at all
    assert nt.plan(data, MEMBERS, subs, None, set(), SITE) == ([], [])


# ---------- sending ----------

def test_pusher_sends_json_for_the_service_worker_with_fresh_claims_each_time():
    push = FakePush()
    pusher = nt.Pusher(PRIVATE, SITE, push)
    alert = nt.Alert("Title", "Body", SITE + "?tab=discover", "new-houses")
    assert pusher.push(phone("Paxton")["subscription"], alert) == "sent"
    assert pusher.push(phone("Jack", push="https://fcm.googleapis.com")["subscription"], alert) == "sent"
    assert push.sent[0]["payload"] == {"title": "Title", "body": "Body", "url": SITE + "?tab=discover", "tag": "new-houses"}
    assert [s["claims"]["aud"] for s in push.sent] == ["web.push.apple.com", "fcm.googleapis.com"]
    assert push.sent[0]["claims"]["sub"] == SITE
    assert push.sent[0]["ttl"] == nt.TTL_SECONDS
    assert push.sent[0]["headers"] == {"Urgency": "normal", "Topic": "new-houses"}


def test_pusher_sorts_out_gone_phones_from_real_failures(caplog):
    gone, broken, offline = phone("A"), phone("B"), phone("C")
    push = FakePush({gone["endpoint"]: 410, broken["endpoint"]: 403,
                     offline["endpoint"]: requests.ConnectionError("no network")})
    pusher = nt.Pusher(PRIVATE, SITE, push)
    alert = nt.test_alert(SITE)
    assert pusher.push(gone["subscription"], alert) == "gone"
    assert pusher.push(phone("A", push="https://fcm.googleapis.com")["subscription"], alert) == "sent"
    with caplog.at_level(logging.WARNING, logger="notify"):
        assert pusher.push(broken["subscription"], alert) == "failed"
        assert pusher.push(offline["subscription"], alert) == "failed"
    assert "403" in caplog.text and "BadJwtToken" in caplog.text
    assert "no network" in caplog.text


# ---------- the whole run ----------

def test_daily_run_sends_alerts_removes_gone_phones_and_remembers_matches(site_config, data_file, caplog):
    path = data_file([listing(1, cost=850), listing(2, cost=1150, is_new=False)])
    gone = phone("Charlie")
    db = FakeSupabase(push_subs=[phone("Paxton"), gone, phone("Jack")], members=MEMBERS,
                      votes=likes("western_och:2", "Paxton", "Charlie", "Jack"))
    push = FakePush({gone["endpoint"]: 410})
    with caplog.at_level(logging.INFO, logger="notify"):
        assert run(db, push, path, site_config) == 0

    titles = {(s["endpoint"].rsplit("/", 1)[1], s["payload"]["title"]) for s in push.sent}
    assert titles == {("paxton-1", "New house: $850/person"), ("jack-1", "New house: $850/person"),
                      ("paxton-1", "Everyone liked 2 Test St"), ("jack-1", "Everyone liked 2 Test St")}
    assert [r["endpoint"] for r in db.tables["push_subs"]] == [phone("Paxton")["endpoint"], phone("Jack")["endpoint"]]
    assert db.tables["push_sent"] == [{"group_id": G1, "kind": "match", "listing_key": "western_och:2"}]
    assert "1 phone(s) had turned alerts off" in caplog.text
    # The public run log has counts, not the houses the group agreed on or phone addresses
    assert "2 Test St" not in caplog.text and "web.push.apple.com" not in caplog.text

    # The same day again: nothing is new and the match was already announced
    push2 = FakePush()
    assert run(db, push2, data_file([listing(1, is_new=False), listing(2, is_new=False)]), site_config) == 0
    assert push2.sent == []


def test_a_match_nobody_received_is_tried_again_next_run(site_config, data_file):
    path = data_file([listing(2, is_new=False)])
    p = phone("Paxton")
    db = FakeSupabase(push_subs=[p], members=MEMBERS[:1], votes=likes("western_och:2", "Paxton"))
    assert run(db, FakePush({p["endpoint"]: 500}), path, site_config) == 1  # failures show on the run page
    assert db.tables["push_sent"] == []
    push = FakePush()
    assert run(db, push, path, site_config) == 0
    assert [s["payload"]["tag"] for s in push.sent] == ["match"]


def test_new_house_alerts_still_go_out_before_the_schema_update(site_config, data_file, caplog):
    path = data_file([listing(1, cost=850)])
    db = FakeSupabase(push_subs=[phone("Paxton")])
    db.fail = {"group_members": (403, "permission denied for table group_members"),
               "votes": (403, "permission denied for table votes")}
    push = FakePush()
    with caplog.at_level(logging.WARNING, logger="notify"):
        assert run(db, push, path, site_config) == 0
    assert [s["payload"]["title"] for s in push.sent] == ["New house: $850/person"]
    assert "Skipping match alerts" in caplog.text and "supabase/schema.sql" in caplog.text


def test_nothing_set_up_yet_is_fine_and_says_what_is_missing(site_config, data_file, caplog):
    with caplog.at_level(logging.INFO, logger="notify"):
        assert run(FakeSupabase(), FakePush(), data_file([listing(1)]), site_config,
                   env={"SITE_URL": SITE, "SUPABASE_URL": "https://abc.supabase.co"}) == 0
    assert "missing: SUPABASE_SERVICE_KEY, VAPID_PRIVATE_KEY" in caplog.text


def test_nobody_subscribed_sends_nothing(site_config, data_file, caplog):
    push = FakePush()
    with caplog.at_level(logging.INFO, logger="notify"):
        assert run(FakeSupabase(members=MEMBERS), push, data_file([listing(1)]), site_config) == 0
    assert push.sent == []
    assert "Nobody has turned on phone alerts yet" in caplog.text


def test_a_private_key_that_does_not_match_the_site_is_caught_before_sending(site_config, data_file, caplog):
    other_private, _ = nt.new_keys()
    push = FakePush()
    db = FakeSupabase(push_subs=[phone("Paxton")])
    assert run(db, push, data_file([listing(1)]), site_config, env={**ENV, "VAPID_PRIVATE_KEY": other_private}) == 1
    assert "doesn't match vapidPublicKey" in caplog.text
    assert run(db, push, data_file([listing(1)]), site_config, env={**ENV, "VAPID_PRIVATE_KEY": "not a key"}) == 1
    assert "isn't a valid key" in caplog.text
    assert push.sent == [] and db.calls == []


def test_dry_run_prints_and_sends_nothing_without_the_private_key(site_config, data_file, capsys):
    db = FakeSupabase(push_subs=[phone("Paxton")], members=MEMBERS)
    env = {k: v for k, v in ENV.items() if k != "VAPID_PRIVATE_KEY"}
    push = FakePush()
    assert run(db, push, data_file([listing(1, cost=850)]), site_config, "--dry-run", env=env) == 0
    assert "Paxton (1 phone(s)): New house: $850/person" in capsys.readouterr().out
    assert push.sent == [] and db.tables["push_sent"] == []


def test_test_alert_goes_to_one_person_or_everyone(site_config, data_file, caplog):
    db = FakeSupabase(push_subs=[phone("Paxton", 1), phone("Paxton", 2), phone("Jack")])
    push = FakePush()
    assert run(db, push, data_file([]), site_config, "--test", "paxton") == 0
    assert [s["endpoint"].rsplit("/", 1)[1] for s in push.sent] == ["paxton-1", "paxton-2"]
    assert push.sent[0]["payload"]["title"] == "Test alert"
    assert push.sent[0]["payload"]["url"] == SITE + "?tab=group"

    push = FakePush()
    assert run(db, push, data_file([]), site_config, "--test", "everyone") == 0
    assert len(push.sent) == 3

    assert run(db, FakePush(), data_file([]), site_config, "--test", "Tyler") == 1
    assert "People with alerts on: Jack, Paxton" in caplog.text


def test_supabase_client_pages_through_rows_and_sends_the_key():
    db = FakeSupabase(votes=[{"group_id": G1, "listing_key": f"k{i}", "member": "A", "vote": "like"} for i in range(2500)])
    client = nt.Supabase("https://abc.supabase.co/", "sb_secret_x", session=db)
    assert len(client.likes()) == 2500
    assert [c[2]["offset"] for c in db.calls] == [0, 1000, 2000]
    assert db.headers == {"apikey": "sb_secret_x"}  # new-style keys aren't JWTs: no Bearer header
    legacy = nt.Supabase("https://abc.supabase.co", "eyJhbGciOi.legacy.jwt", session=FakeSupabase())
    assert legacy.http.headers["Authorization"] == "Bearer eyJhbGciOi.legacy.jwt"
    db.fail = {"push_subs": (401, "Invalid API key")}
    with pytest.raises(nt.SupabaseError, match="401 Invalid API key"):
        client.push_subs()


# ---------- many groups ----------

def test_a_match_in_one_group_only_alerts_that_group(site_config, data_file):
    path = data_file([listing(1, is_new=False), listing(2, is_new=False)])
    db = FakeSupabase(push_subs=[phone("Anna", group=G1), phone("Julie", group=G1), phone("Bea", group=G2)],
                      members=[member("Anna", G1), member("Julie", G1, position=2), member("Bea", G2)],
                      votes=likes("western_och:1", "Anna", "Julie", group=G1)
                      + likes("western_och:2", "Anna", group=G1))  # only half of group 1: not a match
    push = FakePush()
    assert run(db, push, path, site_config) == 0
    assert sorted(s["endpoint"].rsplit("/", 1)[1] for s in push.sent) == ["anna-1", "julie-1"]
    assert {s["payload"]["title"] for s in push.sent} == {"Everyone liked 1 Test St"}
    assert db.tables["push_sent"] == [{"group_id": G1, "kind": "match", "listing_key": "western_och:1"}]


def test_push_sent_is_per_group(site_config, data_file):
    path = data_file([listing(1, is_new=False)])
    db = FakeSupabase(push_subs=[phone("Anna", group=G1), phone("Bea", group=G2)],
                      members=[member("Anna", G1), member("Bea", G2)],
                      votes=likes("western_och:1", "Anna", group=G1) + likes("western_och:1", "Bea", group=G2),
                      push_sent=[{"group_id": G1, "kind": "match", "listing_key": "western_och:1"}])
    push = FakePush()
    assert run(db, push, path, site_config) == 0
    # Group 1 already heard about it; group 2 matched on the same house and hasn't
    assert [s["endpoint"].rsplit("/", 1)[1] for s in push.sent] == ["bea-1-22"]
    assert {(r["group_id"], r["listing_key"]) for r in db.tables["push_sent"]} == {
        (G1, "western_och:1"), (G2, "western_och:1")}
    push2 = FakePush()
    assert run(db, push2, path, site_config) == 0
    assert push2.sent == []


def test_the_same_name_in_two_groups_is_two_people(site_config, data_file):
    path = data_file([listing(1, cost=1000), listing(2, cost=1150, is_new=False)])
    sam1, sam2 = phone("Sam", group=G1), phone("Sam", group=G2)
    db = FakeSupabase(push_subs=[sam1, sam2],
                      members=[member("Sam", G1, budget=900), member("Sam", G2, budget=1500),
                               member("Lee", G2, position=2)],
                      votes=likes("western_och:2", "Sam", group=G1) + likes("western_och:2", "Sam", group=G2))
    push = FakePush()
    assert run(db, push, path, site_config) == 0
    got = {(s["endpoint"], s["payload"]["title"]) for s in push.sent}
    # Group 1's Sam has a $900 budget, so no new house; group 2's Sam has $1,500.
    # Group 1 is only Sam, so that's a match; group 2 also needs Lee's like.
    assert got == {(sam1["endpoint"], "Everyone liked 2 Test St"), (sam2["endpoint"], "New house: $1,000/person")}
    assert db.tables["push_sent"] == [{"group_id": G1, "kind": "match", "listing_key": "western_och:2"}]

    push = FakePush()
    assert run(db, push, data_file([]), site_config, "--test", "sam") == 0
    assert {s["endpoint"] for s in push.sent} == {sam1["endpoint"], sam2["endpoint"]}


def test_a_group_whose_phones_all_failed_gets_its_match_again(site_config, data_file):
    path = data_file([listing(1, is_new=False)])
    a, b = phone("Anna", group=G1), phone("Bea", group=G2)
    db = FakeSupabase(push_subs=[a, b], members=[member("Anna", G1), member("Bea", G2)],
                      votes=likes("western_och:1", "Anna", group=G1) + likes("western_och:1", "Bea", group=G2))
    assert run(db, FakePush({b["endpoint"]: 500}), path, site_config) == 1
    assert db.tables["push_sent"] == [{"group_id": G1, "kind": "match", "listing_key": "western_och:1"}]


def test_supabase_reads_and_writes_carry_the_group():
    db = FakeSupabase(members=MEMBERS, push_sent=[{"group_id": G1, "kind": "match", "listing_key": "k"}])
    client = nt.Supabase("https://abc.supabase.co", "sb_secret_x", session=db)
    assert client.members()[0] == {"group_id": G1, "name": "Paxton", "budget_max": 1100}
    assert client.sent_matches() == {(G1, "k")}
    client.remember_matches([(G2, "k")])
    assert db.calls[-1][2] == [{"group_id": G2, "kind": "match", "listing_key": "k"}]
    assert [c[1] for c in db.calls if c[0] == "GET"] == ["group_members", "push_sent"]


# ---------- keys ----------

def test_new_keys_pair_up_and_the_site_has_a_real_public_key():
    private, public = nt.new_keys()
    assert nt.public_key_of(nt.Vapid.from_string(private)) == public
    raw = base64.urlsafe_b64decode(public + "=")
    assert len(raw) == 65 and raw[0] == 4  # an uncompressed P-256 point, what browsers expect
    site_key = nt.site_public_key()  # the real site/js/config.js
    assert site_key and base64.urlsafe_b64decode(site_key + "=")[0] == 4


def test_new_keys_file_is_private_and_never_overwritten(tmp_path, caplog):
    path = tmp_path / "vapid-private-key.txt"
    with caplog.at_level(logging.INFO, logger="notify"):
        assert nt.main(["--new-keys", str(path)]) == 0
    private = path.read_text().strip()
    assert stat.S_IMODE(path.stat().st_mode) == 0o600
    assert nt.public_key_of(nt.Vapid.from_string(private)) in caplog.text
    assert private not in caplog.text
    assert nt.main(["--new-keys", str(path)]) == 1
    assert path.read_text().strip() == private
