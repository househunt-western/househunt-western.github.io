-- Shared group state for the house finder: votes, notes, status per house, viewing scorecards,
-- budgets, phone push subscriptions, and which match alerts were already sent.
--
-- How to use: paste this whole file into Supabase's SQL editor and press Run.
-- It's safe to run again later (it only creates what's missing and replaces functions).
-- Then run setup_group(...) once; see supabase/SETUP.md.
--
-- Security model:
--  * The web page only has Supabase's public "anon" key, which anyone can see.
--  * So the anon key can't touch any table directly (row level security on, no policies,
--    privileges revoked). It can only call the functions below.
--  * Every function first checks the group code from your invite link. Only its SHA-256
--    hash is stored, so even someone reading the database can't recover the code.

-- ---------- tables ----------

create table if not exists settings (
  id int primary key default 1 check (id = 1),  -- exactly one row
  group_code_hash text not null
);

create table if not exists members (
  name text primary key check (length(name) between 1 and 40),
  position bigint generated always as identity,  -- keeps names in the order you listed them
  budget_max int check (budget_max between 300 and 5000),
  created_at timestamptz not null default now()
);

create table if not exists votes (
  listing_key text not null check (length(listing_key) between 1 and 200),
  member text not null references members(name) on delete cascade,
  vote text not null check (vote in ('like', 'pass')),
  updated_at timestamptz not null default now(),
  primary key (listing_key, member)
);

create table if not exists notes (
  id bigint generated always as identity primary key,
  listing_key text not null check (length(listing_key) between 1 and 200),
  member text not null references members(name) on delete cascade,
  text text not null check (length(text) between 1 and 500),
  created_at timestamptz not null default now()
);
create index if not exists notes_listing_idx on notes (listing_key, created_at);

create table if not exists listing_status (
  listing_key text primary key check (length(listing_key) between 1 and 200),
  status text not null check (status in ('new', 'interested', 'contacted', 'viewing', 'rejected')),
  updated_by text references members(name) on delete set null,
  updated_at timestamptz not null default now()
);

-- One viewing scorecard per person per house. Ratings are 1 (bad) to 5 (great) for every item,
-- so for damp and noise 5 means none. Empty ratings are null.
create table if not exists scorecards (
  listing_key text not null check (length(listing_key) between 1 and 200),
  member text not null references members(name) on delete cascade,
  bedrooms smallint check (bedrooms between 1 and 5),  -- are the bedrooms roughly equal?
  bathrooms smallint check (bathrooms between 1 and 5),
  kitchen smallint check (kitchen between 1 and 5),
  heating smallint check (heating between 1 and 5),
  laundry smallint check (laundry between 1 and 5),
  damp smallint check (damp between 1 and 5),
  noise smallint check (noise between 1 and 5),
  internet smallint check (internet between 1 and 5),
  landlord smallint check (landlord between 1 and 5),
  lease_ok boolean,
  deposit_asked boolean,  -- a damage deposit: not allowed in Ontario
  note text not null default '' check (length(note) <= 500),
  updated_at timestamptz not null default now(),
  primary key (listing_key, member)
);

create table if not exists push_subs (
  endpoint text primary key,  -- the browser's push address; unique per phone
  member text not null references members(name) on delete cascade,
  subscription jsonb not null,
  created_at timestamptz not null default now()
);

-- Alerts the daily job already sent, so "Everyone liked …" goes out once per house.
create table if not exists push_sent (
  kind text not null check (kind in ('match')),
  listing_key text not null check (length(listing_key) between 1 and 200),
  sent_at timestamptz not null default now(),
  primary key (kind, listing_key)
);

-- Lock every table: the page can't read or write them directly.
alter table settings enable row level security;
alter table members enable row level security;
alter table votes enable row level security;
alter table notes enable row level security;
alter table listing_status enable row level security;
alter table push_subs enable row level security;
alter table scorecards enable row level security;
alter table push_sent enable row level security;
revoke all on settings, members, votes, notes, listing_status, push_subs, scorecards, push_sent
  from public, anon, authenticated;
-- The daily GitHub job (secret key = service_role) keeps the free project awake and sends the phone
-- alerts (scraper/notify.py). It reads the phones' addresses, budgets and likes; removes phones that
-- turned alerts off; and notes which matches it announced. It never sees the group code, notes or
-- scorecards. These grants are needed when "Automatically expose new tables" is off.
grant select, delete on push_subs to service_role;
grant select on members, votes to service_role;
grant select, insert on push_sent to service_role;

-- ---------- helpers (not callable from the page) ----------

create or replace function _code_hash(p_code text) returns text
language sql immutable set search_path = pg_catalog, pg_temp
as $$ select encode(sha256(convert_to(coalesce(p_code, ''), 'UTF8')), 'hex') $$;

create or replace function _check(p_code text, p_member text default null) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from settings where group_code_hash = _code_hash(p_code)) then
    raise exception 'bad group code' using errcode = '28000';
  end if;
  if p_member is not null and not exists (select 1 from members where name = p_member) then
    raise exception 'unknown member %', p_member using errcode = '22023';
  end if;
end $$;

-- One rating from a scorecard sent by the page: null if it's missing, else a whole number 1–5.
create or replace function _rating(p_card jsonb, p_item text) returns smallint
language plpgsql immutable set search_path = pg_catalog, pg_temp
as $$
declare v jsonb := p_card->'ratings'->p_item;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'number' or v::text !~ '^[1-5]$' then
    raise exception 'bad rating for %', p_item using errcode = '22023';
  end if;
  return v::text::smallint;
end $$;

-- Run once from the SQL editor (see SETUP.md). Running it again changes the code and
-- adds any new names; it never deletes anyone's votes.
create or replace function setup_group(p_code text, p_members text[]) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if length(coalesce(p_code, '')) < 12 then
    raise exception 'use a group code of at least 12 characters';
  end if;
  insert into settings (id, group_code_hash) values (1, _code_hash(p_code))
    on conflict (id) do update set group_code_hash = excluded.group_code_hash;
  insert into members (name)
    select trim(m) from unnest(p_members) with ordinality as t(m, ord) where trim(m) <> '' order by ord
    on conflict (name) do nothing;
  return 'Group ready with ' || (select count(*) from members) || ' members';
end $$;

-- ---------- what the page calls ----------
-- These mirror site/js/group.js LocalGroupStore: same names, same rules, same state shape.

create or replace function get_group_state(p_code text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  perform _check(p_code);
  return jsonb_build_object(
    'members', coalesce((select jsonb_agg(name order by position) from members), '[]'::jsonb),
    'votes', coalesce((
      select jsonb_object_agg(listing_key, by_member) from (
        select listing_key, jsonb_object_agg(member, vote) as by_member from votes group by listing_key
      ) v), '{}'::jsonb),
    'notes', coalesce((
      select jsonb_object_agg(listing_key, list) from (
        select listing_key,
               jsonb_agg(jsonb_build_object('member', member, 'text', text, 'at', created_at)
                         order by created_at, id) as list
        from notes group by listing_key
      ) n), '{}'::jsonb),
    'status', coalesce((
      select jsonb_object_agg(listing_key,
               jsonb_build_object('status', status, 'by', updated_by, 'at', updated_at))
      from listing_status), '{}'::jsonb),
    'budgets', coalesce((
      select jsonb_object_agg(name, budget_max) from members where budget_max is not null), '{}'::jsonb),
    'scorecards', coalesce((
      select jsonb_object_agg(listing_key, by_member) from (
        select listing_key, jsonb_object_agg(member, jsonb_build_object(
                 'ratings', jsonb_strip_nulls(jsonb_build_object(
                   'bedrooms', bedrooms, 'bathrooms', bathrooms, 'kitchen', kitchen, 'heating', heating,
                   'laundry', laundry, 'damp', damp, 'noise', noise, 'internet', internet, 'landlord', landlord)),
                 'lease_ok', lease_ok, 'deposit_asked', deposit_asked, 'note', note, 'at', updated_at)) as by_member
        from scorecards group by listing_key
      ) c), '{}'::jsonb)
  );
end $$;

-- p_vote: 'like', 'pass', or null to clear your vote
create or replace function group_vote(p_code text, p_key text, p_member text, p_vote text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform _check(p_code, p_member);
  if p_vote is null then
    delete from votes where listing_key = p_key and member = p_member;
  elsif p_vote in ('like', 'pass') then
    insert into votes (listing_key, member, vote) values (p_key, p_member, p_vote)
      on conflict (listing_key, member) do update set vote = excluded.vote, updated_at = now();
  else
    raise exception 'bad vote %', p_vote using errcode = '22023';
  end if;
end $$;

-- Returns false (and saves nothing) for an empty note; long notes are cut to 500 characters.
create or replace function group_add_note(p_code text, p_key text, p_member text, p_text text) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare clean text := left(trim(coalesce(p_text, '')), 500);
begin
  perform _check(p_code, p_member);
  if clean = '' then
    return false;
  end if;
  insert into notes (listing_key, member, text) values (p_key, p_member, clean);
  return true;
end $$;

create or replace function group_set_status(p_code text, p_key text, p_status text, p_member text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform _check(p_code, p_member);
  insert into listing_status (listing_key, status, updated_by) values (p_key, p_status, p_member)
    on conflict (listing_key) do update
    set status = excluded.status, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- Returns false (and saves nothing) for amounts outside $300–$5,000.
create or replace function group_set_budget(p_code text, p_member text, p_amount numeric) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare n int;
begin
  perform _check(p_code, p_member);
  if p_amount is null then
    return false;
  end if;
  n := round(p_amount);
  if n < 300 or n > 5000 then
    return false;
  end if;
  update members set budget_max = n where name = p_member;
  return true;
end $$;

-- My viewing scorecard for a house. p_card looks like the page's:
--   {"ratings": {"kitchen": 4, ...}, "lease_ok": true, "deposit_asked": false, "note": "..."}
-- Saving again replaces it. An empty card removes mine and returns false; otherwise returns true.
-- Unknown items are ignored; a rating that isn't a whole number 1–5 is refused.
create or replace function group_save_scorecard(p_code text, p_key text, p_member text, p_card jsonb) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  c jsonb := coalesce(p_card, '{}'::jsonb);
  r scorecards%rowtype;
begin
  perform _check(p_code, p_member);
  r.bedrooms := _rating(c, 'bedrooms');
  r.bathrooms := _rating(c, 'bathrooms');
  r.kitchen := _rating(c, 'kitchen');
  r.heating := _rating(c, 'heating');
  r.laundry := _rating(c, 'laundry');
  r.damp := _rating(c, 'damp');
  r.noise := _rating(c, 'noise');
  r.internet := _rating(c, 'internet');
  r.landlord := _rating(c, 'landlord');
  r.lease_ok := case when jsonb_typeof(c->'lease_ok') = 'boolean' then (c->>'lease_ok')::boolean end;
  r.deposit_asked := case when jsonb_typeof(c->'deposit_asked') = 'boolean' then (c->>'deposit_asked')::boolean end;
  r.note := left(trim(coalesce(c->>'note', '')), 500);
  if num_nonnulls(r.bedrooms, r.bathrooms, r.kitchen, r.heating, r.laundry, r.damp, r.noise, r.internet,
                  r.landlord, r.lease_ok, r.deposit_asked) = 0 and r.note = '' then
    delete from scorecards where listing_key = p_key and member = p_member;
    return false;
  end if;
  insert into scorecards (listing_key, member, bedrooms, bathrooms, kitchen, heating, laundry, damp, noise,
                          internet, landlord, lease_ok, deposit_asked, note)
    values (p_key, p_member, r.bedrooms, r.bathrooms, r.kitchen, r.heating, r.laundry, r.damp, r.noise,
            r.internet, r.landlord, r.lease_ok, r.deposit_asked, r.note)
    on conflict (listing_key, member) do update set
      bedrooms = excluded.bedrooms, bathrooms = excluded.bathrooms, kitchen = excluded.kitchen,
      heating = excluded.heating, laundry = excluded.laundry, damp = excluded.damp, noise = excluded.noise,
      internet = excluded.internet, landlord = excluded.landlord, lease_ok = excluded.lease_ok,
      deposit_asked = excluded.deposit_asked, note = excluded.note, updated_at = now();
  return true;
end $$;

-- Phase 3: a phone that turned on alerts. Same phone again just updates its entry.
create or replace function save_push_sub(p_code text, p_member text, p_sub jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  perform _check(p_code, p_member);
  if coalesce(p_sub->>'endpoint', '') !~ '^https://' then
    raise exception 'push subscription needs an https endpoint' using errcode = '22023';
  end if;
  insert into push_subs (endpoint, member, subscription) values (p_sub->>'endpoint', p_member, p_sub)
    on conflict (endpoint) do update set member = excluded.member, subscription = excluded.subscription;
end $$;

-- ---------- who may call what ----------
-- Postgres lets everyone run new functions by default; take that away, then allow only the page's ones.
revoke execute on function _code_hash(text), _check(text, text), _rating(jsonb, text), setup_group(text, text[]),
  get_group_state(text), group_vote(text, text, text, text), group_add_note(text, text, text, text),
  group_set_status(text, text, text, text), group_set_budget(text, text, numeric),
  group_save_scorecard(text, text, text, jsonb), save_push_sub(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function get_group_state(text), group_vote(text, text, text, text),
  group_add_note(text, text, text, text), group_set_status(text, text, text, text),
  group_set_budget(text, text, numeric), group_save_scorecard(text, text, text, jsonb),
  save_push_sub(text, text, jsonb)
  to anon, authenticated;
