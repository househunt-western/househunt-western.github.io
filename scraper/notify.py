"""Phone alerts (Web Push), sent after the daily scrape.

Each run it sends:
  * New houses: one alert per person about houses first seen this run that fit them: cost per
    person within their budget (or $1,200 if they haven't set one), and at most a 45-minute walk.
    Several houses become one summary alert, never a pile of them.
  * Matches: "Everyone liked {house}" to everyone in a group once all of that group liked it,
    once per house per group. Each group only hears about its own matches. Sent ones are
    remembered in Supabase (the push_sent table, per group), so a house is never announced twice.

Usage:
  .venv/bin/python -m scraper.notify                  # send (or say what's missing)
  .venv/bin/python -m scraper.notify --dry-run        # show what it would send, send nothing
  .venv/bin/python -m scraper.notify --test Paxton    # a test alert to every Paxton's phones, in any group ("everyone" = all)
  .venv/bin/python -m scraper.notify --new-keys FILE  # make a new key pair (docs/github-setup.md)

Settings come from environment variables (GitHub secrets in the daily run):
  SUPABASE_URL, SUPABASE_SERVICE_KEY   where the phones' push addresses are saved
  VAPID_PRIVATE_KEY   private half of the key pair; the public half is vapidPublicKey in site/js/config.js
  SITE_URL            where tapping an alert goes
  VAPID_SUBJECT       optional contact URL that Apple and Google see; defaults to SITE_URL
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Dict, List, Mapping, Optional, Set, Tuple
from urllib.parse import urlsplit, urlunsplit

import requests
from cryptography.hazmat.primitives import serialization
from py_vapid import Vapid
from py_vapid.utils import b64urlencode
from pywebpush import WebPushException, webpush

from alerts.email_digest import cost, facts, money, new_listings
from . import config

log = logging.getLogger("notify")

DEFAULT_BUDGET = 1200  # for anyone who hasn't set one; same as defaultBudget in site/js/config.js
MAX_WALK_MIN = 45  # same as the site's default "Max walk to Huron" filter
TTL_SECONDS = 24 * 60 * 60  # a phone that's off for a day still gets it; after that it's old news
SITE_CONFIG = config.ROOT / "site" / "js" / "config.js"


# ---------- what to send ----------

@dataclass
class Alert:
    title: str
    body: str
    url: str
    tag: str  # on the phone, a newer alert with the same tag replaces the older one

    def payload(self) -> str:
        """What site/sw.js receives and shows."""
        return json.dumps({"title": self.title, "body": self.body, "url": self.url, "tag": self.tag})


@dataclass
class Send:
    member: str
    alert: Alert
    phones: List[dict]  # rows from push_subs: {endpoint, group_id, member, subscription}
    group: Optional[str] = None  # group_id; never logged, the run log is public


def site_base(site_url: Optional[str]) -> Optional[str]:
    """The site's address alone. SITE_URL may be the invite link, and the #join= code must not
    end up in alerts or in what Apple and Google see."""
    if not site_url:
        return None
    s = urlsplit(site_url.strip())
    return urlunsplit((s.scheme, s.netloc, s.path or "/", "", ""))


def link(site_url: Optional[str], tab: str) -> str:
    """Opens the app on that tab. Relative when SITE_URL isn't set: sw.js resolves it to the site."""
    return f"{site_base(site_url) or './'}?tab={tab}"


def one_line(text) -> str:
    return " ".join(str(text or "").split())


def walk_min(l: dict) -> Optional[int]:
    return l.get("walk_min_huron") if l.get("walk_min_huron") is not None else l.get("walk_min_campus")


def fits(l: dict, budget: Optional[int]) -> bool:
    """The default filters for alerts: within this person's budget, and a reasonable walk.
    An unknown walk time doesn't rule a house out, same as on the site."""
    c = cost(l)
    walk = walk_min(l)
    return c is not None and c <= (budget or DEFAULT_BUDGET) and (walk is None or walk <= MAX_WALK_MIN)


def by_cost(houses: List[dict]) -> List[dict]:
    return sorted(houses, key=lambda l: cost(l) if cost(l) is not None else 10 ** 9)


def new_houses_alert(houses: List[dict], site_url: Optional[str]) -> Alert:
    first = by_cost(houses)[0]
    if len(houses) == 1:
        return Alert(title=f"New house: {money(cost(first))}/person",
                     body=" · ".join(p for p in [one_line(first.get("title")), facts(first)] if p),
                     url=link(site_url, "discover"), tag="new-houses")
    return Alert(title=f"{len(houses)} new houses fit your budget",
                 body=f"From {money(cost(first))}/person ({one_line(first.get('title'))}). Tap to swipe through them.",
                 url=link(site_url, "discover"), tag="new-houses")


def match_alert(houses: List[dict], site_url: Optional[str]) -> Alert:
    houses = by_cost(houses)
    if len(houses) == 1:
        h = houses[0]
        return Alert(title=f"Everyone liked {one_line(h.get('title'))}",
                     body=" · ".join(p for p in [f"{money(cost(h))}/person", facts(h)] if p) + ". Time to book a viewing?",
                     url=link(site_url, "shortlist"), tag="match")
    names = ", ".join(one_line(h.get("title")) for h in houses[:3])
    if len(houses) > 3:
        names += f" and {len(houses) - 3} more"
    return Alert(title=f"Everyone liked {len(houses)} houses",
                 body=f"{names}. They're at the top of your Shortlist.",
                 url=link(site_url, "shortlist"), tag="match")


def test_alert(site_url: Optional[str]) -> Alert:
    return Alert(title="Test alert", body="Alerts work on this phone. New houses and matches will show up like this.",
                 url=link(site_url, "group"), tag="test")


def new_matches(listings: List[dict], members: List[str], likes: List[dict], already_sent: Set[str]) -> List[dict]:
    """Listed houses that every member liked and that haven't been announced yet.
    Same rule as isMatch() in site/js/logic.js."""
    if not members:
        return []
    liked_by: Dict[str, Set[str]] = {}
    for v in likes:
        liked_by.setdefault(v["listing_key"], set()).add(v["member"])
    everyone = set(members)
    return by_cost([l for l in listings
                    if l.get("active", True) and l.get("key") not in already_sent
                    and everyone <= liked_by.get(l.get("key"), set())])


def plan(data: dict, members: List[dict], subs: List[dict], likes: Optional[List[dict]],
         already_sent: Set[Tuple[str, str]], site_url: Optional[str]) -> Tuple[List[Send], List[Tuple[str, str]]]:
    """Who gets which alert, and which (group_id, listing_key) matches they announce. Sends nothing.
    A name is only unique within its group, so people are (group_id, name) throughout.
    likes=None means the votes couldn't be read, so there are no match alerts this run."""
    phones_of: Dict[Tuple[str, str], List[dict]] = {}
    for s in subs:
        phones_of.setdefault((s.get("group_id"), s["member"]), []).append(s)
    budgets = {(m.get("group_id"), m["name"]): m.get("budget_max") for m in members}
    new = new_listings(data)

    sends = []
    for (group, member), phones in phones_of.items():
        mine = [l for l in new if fits(l, budgets.get((group, member)))]
        if mine:
            sends.append(Send(member, new_houses_alert(mine, site_url), phones, group))

    matched: List[Tuple[str, str]] = []
    if likes is not None:
        names_in: Dict[str, List[str]] = {}
        for m in members:
            names_in.setdefault(m.get("group_id"), []).append(m["name"])
        for group, names in names_in.items():
            found = new_matches(data.get("listings", []), names,
                                [v for v in likes if v.get("group_id") == group],
                                {key for g, key in already_sent if g == group})
            if not found:
                continue
            alert = match_alert(found, site_url)
            sends += [Send(member, alert, phones, g) for (g, member), phones in phones_of.items() if g == group]
            matched += [(group, l["key"]) for l in found]
    return sends, matched


# ---------- Supabase ----------

class SupabaseError(Exception):
    def __init__(self, status: int, message: str):
        super().__init__(f"{status} {message}")
        self.status = status


class Supabase:
    """The few reads and writes the daily job needs, through Supabase's REST API with the secret key."""

    PAGE = 1000  # Supabase returns at most 1,000 rows per request

    def __init__(self, url: str, key: str, session: Optional[requests.Session] = None):
        self.base = url.rstrip("/") + "/rest/v1/"
        self.http = session or requests.Session()
        self.http.headers.update({"apikey": key})
        if key.startswith("eyJ"):  # the legacy service_role key is a JWT, which also goes here
            self.http.headers["Authorization"] = f"Bearer {key}"

    @staticmethod
    def _ok(resp: requests.Response) -> requests.Response:
        if resp.status_code >= 300:
            try:
                message = resp.json().get("message") or resp.text
            except ValueError:
                message = resp.text
            raise SupabaseError(resp.status_code, str(message)[:200])
        return resp

    def rows(self, table: str, select: str, order: str, **filters) -> List[dict]:
        out: List[dict] = []
        while True:
            params = {"select": select, "order": order, "limit": self.PAGE, "offset": len(out), **filters}
            batch = self._ok(self.http.get(self.base + table, params=params, timeout=30)).json()
            out.extend(batch)
            if len(batch) < self.PAGE:
                return out

    def push_subs(self) -> List[dict]:
        return self.rows("push_subs", "endpoint,group_id,member,subscription", "created_at")

    def members(self) -> List[dict]:
        return self.rows("group_members", "group_id,name,budget_max", "group_id,position")

    def likes(self) -> List[dict]:
        return self.rows("votes", "group_id,listing_key,member", "group_id,listing_key,member", vote="eq.like")

    def sent_matches(self) -> Set[Tuple[str, str]]:
        """(group_id, listing_key) of matches already announced."""
        return {(r["group_id"], r["listing_key"])
                for r in self.rows("push_sent", "group_id,listing_key", "group_id,listing_key", kind="eq.match")}

    def remember_matches(self, matches: List[Tuple[str, str]]) -> None:
        self._ok(self.http.post(self.base + "push_sent",
                                json=[{"group_id": g, "kind": "match", "listing_key": k} for g, k in matches],
                                headers={"Prefer": "resolution=ignore-duplicates,return=minimal"}, timeout=30))

    def forget_phone(self, endpoint: str) -> None:
        self._ok(self.http.delete(self.base + "push_subs", params={"endpoint": f"eq.{endpoint}"}, timeout=30))


SCHEMA_HINT = ("If it mentions a missing table or column, or 'permission denied', the database is behind: run "
               "supabase/migrate-to-accounts.sql (or the latest supabase/schema.sql on a fresh install) "
               "in Supabase's SQL editor.")


# ---------- keys and sending ----------

def public_key_of(vapid: Vapid) -> str:
    raw = vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    return b64urlencode(raw)


def new_keys() -> Tuple[str, str]:
    """(private, public), both as one line of base64url text."""
    v = Vapid()
    v.generate_keys()
    private = b64urlencode(v.private_key.private_numbers().private_value.to_bytes(32, "big"))
    return private, public_key_of(v)


def site_public_key(path: Path = SITE_CONFIG) -> Optional[str]:
    """The public key phones subscribe with (vapidPublicKey in site/js/config.js)."""
    m = re.search(r"""vapidPublicKey:\s*["']([A-Za-z0-9_-]+)["']""", path.read_text()) if path.exists() else None
    return m.group(1) if m else None


class Pusher:
    def __init__(self, private_key: str, subject: str, send: Callable = webpush):
        self.vapid = Vapid.from_string(private_key)
        self.subject = subject
        self.send = send

    def push(self, subscription: dict, alert: Alert) -> str:
        """'sent', 'gone' (that phone turned alerts off, or the app was removed) or 'failed'."""
        try:
            self.send(subscription_info=subscription, data=alert.payload(), vapid_private_key=self.vapid,
                      # A fresh dict every time: pywebpush writes the phone's push service into it,
                      # and a reused one would be sent to Google with Apple's address (or the reverse).
                      vapid_claims={"sub": self.subject},
                      ttl=TTL_SECONDS, timeout=30, headers={"Urgency": "normal", "Topic": alert.tag})
            return "sent"
        except WebPushException as err:
            status = getattr(err.response, "status_code", None)
            if status in (404, 410):
                return "gone"
            detail = one_line(getattr(err.response, "text", "") or err.message)[:200]
            log.warning("  The push service refused it (%s): %s", status or "no answer", detail)
            return "failed"
        except requests.RequestException as err:
            log.warning("  Couldn't reach the push service: %s", err)
            return "failed"


def deliver(sends: List[Send], pusher: Pusher, db: Supabase) -> Tuple[Dict[str, int], Set[Tuple[Optional[str], str]]]:
    """Send everything; remove phones the push service says are gone. Returns the counts, and the
    (group_id, tag) of each kind of alert that reached at least one phone in that group. Logs counts only: the run log is
    public, and which houses the group matched on is the group's business."""
    counts = {"sent": 0, "gone": 0, "failed": 0}
    reached: Set[Tuple[Optional[str], str]] = set()
    gone: Set[str] = set()
    for s in sends:
        results = []
        for phone in s.phones:
            if phone["endpoint"] in gone:
                continue
            result = pusher.push(phone["subscription"], s.alert)
            results.append(result)
            counts[result] += 1
            if result == "sent":
                reached.add((s.group, s.alert.tag))
            if result == "gone":
                gone.add(phone["endpoint"])
                try:
                    db.forget_phone(phone["endpoint"])
                except (SupabaseError, requests.RequestException) as err:
                    log.warning("  Couldn't remove a phone that turned alerts off: %s", err)
        kind = {"new-houses": "new houses", "match": "match", "test": "test"}.get(s.alert.tag, s.alert.tag)
        log.info("%s: %s alert, %d of %d phone(s) reached", s.member, kind, results.count("sent"), len(s.phones))
    return counts, reached


# ---------- running it ----------

@dataclass
class Settings:
    supabase_url: Optional[str]
    supabase_key: Optional[str]
    private_key: Optional[str]
    site_url: Optional[str]
    subject: Optional[str]

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Settings":
        def get(name: str) -> Optional[str]:
            return (env.get(name) or "").strip() or None

        site_url = get("SITE_URL")
        return cls(supabase_url=get("SUPABASE_URL"), supabase_key=get("SUPABASE_SERVICE_KEY"),
                   private_key=get("VAPID_PRIVATE_KEY"), site_url=site_url,
                   subject=get("VAPID_SUBJECT") or site_base(site_url))

    def missing(self, sending: bool = True) -> List[str]:
        needed = {"SUPABASE_URL": self.supabase_url, "SUPABASE_SERVICE_KEY": self.supabase_key}
        if sending:
            needed.update({"VAPID_PRIVATE_KEY": self.private_key, "SITE_URL or VAPID_SUBJECT": self.subject})
        return [name for name, value in needed.items() if not value]


def write_new_keys(path: Path) -> int:
    """Saves the private key to a new file (only you can read it) and prints the public key."""
    private, public = new_keys()
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        log.error("%s already exists. Pick another file name: replacing the keys means everyone "
                  "has to turn alerts on again.", path)
        return 1
    with os.fdopen(fd, "w") as f:
        f.write(private + "\n")
    log.info("Saved the private key to %s. Never commit it: it goes in the VAPID_PRIVATE_KEY GitHub secret.", path)
    log.info("Public key, for vapidPublicKey in site/js/config.js:\n%s", public)
    return 0


def run_test(who: str, subs: List[dict], pusher: Pusher, db: Supabase, site_url: Optional[str]) -> int:
    everyone = who.strip().lower() in ("", "everyone", "all")
    phones = subs if everyone else [s for s in subs if s["member"].lower() == who.strip().lower()]
    if not phones:
        log.error("No phones have alerts on for %s. People with alerts on: %s", who,
                  ", ".join(sorted({s["member"] for s in subs})))
        return 1
    alert = test_alert(site_url)
    people: Dict[Tuple[str, str], List[dict]] = {}  # the same name can be in two groups
    for p in phones:
        people.setdefault((p["member"], p.get("group_id") or ""), []).append(p)
    counts, _ = deliver([Send(m, alert, ps, g or None) for (m, g), ps in sorted(people.items())], pusher, db)
    if counts["gone"]:
        log.info("%d phone(s) had turned alerts off, so they were removed.", counts["gone"])
    return 0 if counts["sent"] else 1


def main(argv: Optional[List[str]] = None, env: Optional[Mapping[str, str]] = None,
         send: Callable = webpush, session: Optional[requests.Session] = None,
         site_config: Path = SITE_CONFIG) -> int:
    parser = argparse.ArgumentParser(description="Send phone alerts about new houses and matches.")
    parser.add_argument("--data", type=Path, default=config.LISTINGS_PATH)
    parser.add_argument("--dry-run", action="store_true", help="show what would be sent, send nothing")
    parser.add_argument("--test", metavar="NAME", help="send a test alert to NAME's phones (in any group), or 'everyone'")
    parser.add_argument("--new-keys", metavar="FILE", type=Path, help="make a new VAPID key pair")
    args = parser.parse_args(argv)
    if args.new_keys:
        return write_new_keys(args.new_keys)

    settings = Settings.from_env(os.environ if env is None else env)
    missing = settings.missing(sending=not args.dry_run)
    if missing:
        log.info("Phone alerts aren't set up yet (missing: %s), so none were sent.", ", ".join(missing))
        return 1 if args.test else 0

    pusher = None
    if not args.dry_run:
        try:
            pusher = Pusher(settings.private_key, settings.subject, send)
        except Exception:
            log.error("VAPID_PRIVATE_KEY isn't a valid key. It should be one line of about 43 letters, digits, - and _.")
            return 1
        if site_public_key(site_config) != public_key_of(pusher.vapid):
            log.error("VAPID_PRIVATE_KEY doesn't match vapidPublicKey in site/js/config.js. Phones signed up "
                      "with that public key, so the push services would refuse every alert. Use the private key "
                      "that was made together with it.")
            return 1

    db = Supabase(settings.supabase_url, settings.supabase_key, session)
    try:
        subs = db.push_subs()
    except (SupabaseError, requests.RequestException) as err:
        log.error("Couldn't read the phones' push addresses from Supabase: %s", err)
        return 1
    if not subs:
        log.info("Nobody has turned on phone alerts yet (Group tab → Turn on alerts).")
        return 1 if args.test else 0
    if args.test:
        return run_test(args.test, subs, pusher, db, settings.site_url)

    data = json.loads(args.data.read_text()) if args.data.exists() else {"listings": []}
    try:
        members = db.members()
    except (SupabaseError, requests.RequestException) as err:
        log.warning("Couldn't read budgets, so everyone gets the $%d default: %s. %s", DEFAULT_BUDGET, err, SCHEMA_HINT)
        members = []
    try:
        likes, sent = db.likes(), db.sent_matches()
    except (SupabaseError, requests.RequestException) as err:
        log.warning("Skipping match alerts this run: %s. %s", err, SCHEMA_HINT)
        likes, sent = None, set()

    sends, match_keys = plan(data, members, subs, likes, sent, settings.site_url)
    if not sends:
        log.info("Nothing new for anyone's phone this run.")
        return 0
    if args.dry_run:
        for s in sends:
            print(f"{s.member} ({len(s.phones)} phone(s)): {s.alert.title}\n    {s.alert.body}\n    {s.alert.url}")
        return 0

    counts, reached = deliver(sends, pusher, db)
    # Remember a group's matches once anyone in it got the alert; if all its phones failed, try again next run
    announced = [(g, key) for g, key in match_keys if (g, "match") in reached]
    if announced:
        try:
            db.remember_matches(announced)
        except (SupabaseError, requests.RequestException) as err:
            log.warning("Couldn't note which matches were announced, so they may be sent again: %s. %s", err, SCHEMA_HINT)
    log.info("Sent %d alert(s).%s%s", counts["sent"],
             f" {counts['gone']} phone(s) had turned alerts off, so they were removed." if counts["gone"] else "",
             f" {counts['failed']} didn't go through (see above)." if counts["failed"] else "")
    return 1 if counts["failed"] else 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    sys.exit(main())
