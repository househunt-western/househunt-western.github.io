-- Shared state for the house finder, for any number of friend groups: who is in which group,
-- votes, notes, status per house, viewing scorecards, budgets, phone push subscriptions, and
-- which match alerts were already sent. Listings themselves live in data/listings.json.
--
-- How to use: paste this whole file into Supabase's SQL editor and press Run.
-- It's safe to run again later (it only creates what's missing and replaces functions).
-- Moving a database from the old one-group version? Run migrate-to-accounts.sql first (SETUP.md).
--
-- Security model:
--  * People sign in with Supabase Auth (email + password). The page sends their sign-in token,
--    so auth.uid() tells these functions who is calling. Nobody can act as someone else.
--  * The page only has Supabase's public key, which anyone can see. So no table can be touched
--    directly (row level security on, no policies, privileges revoked). The page can only call
--    the functions below, and each one checks that you're in the group you're asking about.
--  * Invite links (…/#join=<invite>) let someone join a group after signing in.

-- ---------- tables ----------

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 40),
  invite_code text not null unique check (invite_code ~ '^[A-Za-z0-9_-]{12,64}$'),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- A member with no user_id is a name added before accounts existed; the first person who joins
-- with that name claims it (and its votes).
create table if not exists group_members (
  group_id uuid not null references groups(id) on delete cascade,
  name text not null check (length(name) between 1 and 20),
  user_id uuid references auth.users(id) on delete set null,
  position bigint generated always as identity,  -- keeps names in the order they joined
  budget_max int check (budget_max between 300 and 5000),
  created_at timestamptz not null default now(),
  primary key (group_id, name),
  unique (group_id, user_id)
);
create unique index if not exists group_members_name_idx on group_members (group_id, lower(name));
create index if not exists group_members_user_idx on group_members (user_id);

create table if not exists votes (
  group_id uuid not null,
  listing_key text not null check (length(listing_key) between 1 and 200),
  member text not null,
  vote text not null check (vote in ('like', 'pass')),
  updated_at timestamptz not null default now(),
  primary key (group_id, listing_key, member),
  foreign key (group_id, member) references group_members(group_id, name) on delete cascade on update cascade
);

create table if not exists notes (
  id bigint generated always as identity primary key,
  group_id uuid not null,
  listing_key text not null check (length(listing_key) between 1 and 200),
  member text not null,
  text text not null check (length(text) between 1 and 500),
  created_at timestamptz not null default now(),
  foreign key (group_id, member) references group_members(group_id, name) on delete cascade on update cascade
);
create index if not exists notes_group_listing_idx on notes (group_id, listing_key, created_at);

create table if not exists listing_status (
  group_id uuid not null references groups(id) on delete cascade,
  listing_key text not null check (length(listing_key) between 1 and 200),
  status text not null check (status in ('new', 'interested', 'contacted', 'viewing', 'rejected')),
  updated_by text,
  updated_at timestamptz not null default now(),
  primary key (group_id, listing_key),
  foreign key (group_id, updated_by) references group_members(group_id, name)
    on delete set null (updated_by) on update cascade
);

-- One viewing scorecard per person per house. Ratings are 1 (bad) to 5 (great) for every item,
-- so for damp and noise 5 means none. Empty ratings are null.
create table if not exists scorecards (
  group_id uuid not null,
  listing_key text not null check (length(listing_key) between 1 and 200),
  member text not null,
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
  primary key (group_id, listing_key, member),
  foreign key (group_id, member) references group_members(group_id, name) on delete cascade on update cascade
);

create table if not exists push_subs (
  endpoint text primary key,  -- the browser's push address; unique per phone
  group_id uuid not null,
  member text not null,
  subscription jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (group_id, member) references group_members(group_id, name) on delete cascade on update cascade
);

-- Alerts the daily job already sent, so "Everyone liked …" goes out once per house per group.
create table if not exists push_sent (
  group_id uuid not null references groups(id) on delete cascade,
  kind text not null check (kind in ('match')),
  listing_key text not null check (length(listing_key) between 1 and 200),
  sent_at timestamptz not null default now(),
  primary key (group_id, kind, listing_key)
);

-- Lock every table: the page can't read or write them directly.
alter table groups enable row level security;
alter table group_members enable row level security;
alter table votes enable row level security;
alter table notes enable row level security;
alter table listing_status enable row level security;
alter table push_subs enable row level security;
alter table scorecards enable row level security;
alter table push_sent enable row level security;
revoke all on groups, group_members, votes, notes, listing_status, push_subs, scorecards, push_sent
  from public, anon, authenticated;
-- The daily GitHub job (secret key = service_role) keeps the free project awake and sends the phone
-- alerts (scraper/notify.py). It reads the phones' addresses, budgets and likes; removes phones that
-- turned alerts off; and notes which matches it announced. It never sees invite codes, accounts,
-- notes or scorecards. These grants are needed when "Automatically expose new tables" is off.
grant select, delete on push_subs to service_role;
grant select (group_id, name, position, budget_max) on group_members to service_role;
grant select on votes to service_role;
grant select, insert on push_sent to service_role;

-- ---------- the old one-group version (gone) ----------

drop function if exists get_group_state(text), group_vote(text, text, text, text),
  group_add_note(text, text, text, text), group_set_status(text, text, text, text),
  group_set_budget(text, text, numeric), group_save_scorecard(text, text, text, jsonb),
  save_push_sub(text, text, jsonb), setup_group(text, text[]), _check(text, text), _code_hash(text);

-- ---------- helpers (not callable from the page) ----------

-- My name in this group. Refuses anyone signed out or not in the group.
create or replace function _me(p_group uuid) returns text
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare n text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  select name into n from group_members where group_id = p_group and user_id = auth.uid();
  if n is null then
    raise exception 'not in this group' using errcode = '28000';
  end if;
  return n;
end $$;

-- A first name as typed: trimmed, 1–20 characters.
create or replace function _clean_name(p_name text, p_max int default 20) returns text
language plpgsql immutable set search_path = pg_catalog, pg_temp
as $$
declare n text := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
begin
  if length(n) not between 1 and p_max then
    raise exception 'bad name' using errcode = '22023';
  end if;
  return n;
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

-- ---------- groups: start, join, leave ----------

-- What an invite link leads to, shown before signing in: the group's name and who's in it.
-- Null if the invite doesn't exist.
create or replace function group_preview(p_invite text) returns jsonb
language sql stable security definer set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'name', g.name,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object('name', m.name, 'claimed', m.user_id is not null) order by m.position)
      from group_members m where m.group_id = g.id), '[]'::jsonb),
    'full', (select count(*) from group_members m where m.group_id = g.id) >= 5)
  from groups g where g.invite_code = p_invite
$$;

-- The groups I'm in, most recently joined first.
create or replace function my_groups() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', g.id, 'name', g.name, 'me', m.name,
             'size', (select count(*) from group_members x where x.group_id = g.id))
           order by m.created_at desc)
    from group_members m join groups g on g.id = m.group_id
    where m.user_id = auth.uid()), '[]'::jsonb);
end $$;

-- Start a group and join it. The page makes the invite code (16 random characters).
-- Anyone can start up to 3 groups.
create or replace function create_group(p_name text, p_my_name text, p_invite text) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  gname text;
  me text := _clean_name(p_my_name);
  gid uuid;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  gname := _clean_name(p_name, 40);
  if coalesce(p_invite, '') !~ '^[A-Za-z0-9_-]{12,64}$' then
    raise exception 'bad invite' using errcode = '22023';
  end if;
  if (select count(*) from groups where created_by = auth.uid()) >= 3 then
    raise exception 'too many groups' using errcode = '22023';
  end if;
  begin
    insert into groups (name, invite_code, created_by) values (gname, p_invite, auth.uid()) returning id into gid;
  exception when unique_violation then
    raise exception 'invite taken' using errcode = '23505';
  end;
  insert into group_members (group_id, name, user_id) values (gid, me, auth.uid());
  return gid;
end $$;

-- Join a group from its invite link. Taking a name nobody has claimed yet (added before
-- accounts) claims it, votes and all. Joining a group I'm already in just returns it.
-- Groups hold 5 people, matching the 2–5 bedroom search.
create or replace function join_group(p_invite text, p_name text) returns uuid
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  gid uuid;
  me text;
  owner uuid;
  hit boolean;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '28000';
  end if;
  select id into gid from groups where invite_code = p_invite for update;  -- one join at a time
  if gid is null then
    raise exception 'bad invite' using errcode = '22023';
  end if;
  if exists (select 1 from group_members where group_id = gid and user_id = auth.uid()) then
    return gid;
  end if;
  me := _clean_name(p_name);
  select true, user_id into hit, owner from group_members where group_id = gid and lower(name) = lower(me);
  if hit and owner is not null then
    raise exception 'name taken' using errcode = '23505';
  elsif hit then
    update group_members set user_id = auth.uid() where group_id = gid and lower(name) = lower(me);
    return gid;
  end if;
  if (select count(*) from group_members where group_id = gid) >= 5 then
    raise exception 'group is full' using errcode = '22023';
  end if;
  insert into group_members (group_id, name, user_id) values (gid, me, auth.uid());
  return gid;
end $$;

-- Leave a group: my votes, notes and scorecards there go too. The last one out deletes the group.
create or replace function leave_group(p_group uuid) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare me text := _me(p_group);
begin
  delete from group_members where group_id = p_group and name = me;
  if not exists (select 1 from group_members where group_id = p_group and user_id is not null) then
    delete from groups where id = p_group;
  end if;
end $$;

-- ---------- one group's houses ----------
-- These mirror site/js/group.js LocalGroupStore: same names, same rules, same state shape.
-- "Me" always comes from the sign-in, never from the page.

create or replace function get_group_state(p_group uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare me text := _me(p_group);
begin
  return (select jsonb_build_object(
    'id', g.id,
    'name', g.name,
    'invite', g.invite_code,
    'me', me,
    'members', coalesce((
      select jsonb_agg(name order by position) from group_members where group_id = p_group), '[]'::jsonb),
    'unclaimed', coalesce((
      select jsonb_agg(name order by position) from group_members where group_id = p_group and user_id is null),
      '[]'::jsonb),
    'votes', coalesce((
      select jsonb_object_agg(listing_key, by_member) from (
        select listing_key, jsonb_object_agg(member, vote) as by_member
        from votes where group_id = p_group group by listing_key
      ) v), '{}'::jsonb),
    'notes', coalesce((
      select jsonb_object_agg(listing_key, list) from (
        select listing_key,
               jsonb_agg(jsonb_build_object('member', member, 'text', text, 'at', created_at)
                         order by created_at, id) as list
        from notes where group_id = p_group group by listing_key
      ) n), '{}'::jsonb),
    'status', coalesce((
      select jsonb_object_agg(listing_key,
               jsonb_build_object('status', status, 'by', updated_by, 'at', updated_at))
      from listing_status where group_id = p_group), '{}'::jsonb),
    'budgets', coalesce((
      select jsonb_object_agg(name, budget_max)
      from group_members where group_id = p_group and budget_max is not null), '{}'::jsonb),
    'scorecards', coalesce((
      select jsonb_object_agg(listing_key, by_member) from (
        select listing_key, jsonb_object_agg(member, jsonb_build_object(
                 'ratings', jsonb_strip_nulls(jsonb_build_object(
                   'bedrooms', bedrooms, 'bathrooms', bathrooms, 'kitchen', kitchen, 'heating', heating,
                   'laundry', laundry, 'damp', damp, 'noise', noise, 'internet', internet, 'landlord', landlord)),
                 'lease_ok', lease_ok, 'deposit_asked', deposit_asked, 'note', note, 'at', updated_at)) as by_member
        from scorecards where group_id = p_group group by listing_key
      ) c), '{}'::jsonb))
    from groups g where g.id = p_group);
end $$;

-- p_vote: 'like', 'pass', or null to clear my vote
create or replace function group_vote(p_group uuid, p_key text, p_vote text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare me text := _me(p_group);
begin
  if p_vote is null then
    delete from votes where group_id = p_group and listing_key = p_key and member = me;
  elsif p_vote in ('like', 'pass') then
    insert into votes (group_id, listing_key, member, vote) values (p_group, p_key, me, p_vote)
      on conflict (group_id, listing_key, member) do update set vote = excluded.vote, updated_at = now();
  else
    raise exception 'bad vote %', p_vote using errcode = '22023';
  end if;
end $$;

-- Returns false (and saves nothing) for an empty note; long notes are cut to 500 characters.
create or replace function group_add_note(p_group uuid, p_key text, p_text text) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  me text := _me(p_group);
  clean text := left(trim(coalesce(p_text, '')), 500);
begin
  if clean = '' then
    return false;
  end if;
  insert into notes (group_id, listing_key, member, text) values (p_group, p_key, me, clean);
  return true;
end $$;

create or replace function group_set_status(p_group uuid, p_key text, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare me text := _me(p_group);
begin
  insert into listing_status (group_id, listing_key, status, updated_by) values (p_group, p_key, p_status, me)
    on conflict (group_id, listing_key) do update
    set status = excluded.status, updated_by = excluded.updated_by, updated_at = now();
end $$;

-- Returns false (and saves nothing) for amounts outside $300–$5,000.
create or replace function group_set_budget(p_group uuid, p_amount numeric) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  me text := _me(p_group);
  n int;
begin
  if p_amount is null then
    return false;
  end if;
  n := round(p_amount);
  if n < 300 or n > 5000 then
    return false;
  end if;
  update group_members set budget_max = n where group_id = p_group and name = me;
  return true;
end $$;

-- My viewing scorecard for a house. p_card looks like the page's:
--   {"ratings": {"kitchen": 4, ...}, "lease_ok": true, "deposit_asked": false, "note": "..."}
-- Saving again replaces it. An empty card removes mine and returns false; otherwise returns true.
-- Unknown items are ignored; a rating that isn't a whole number 1–5 is refused.
create or replace function group_save_scorecard(p_group uuid, p_key text, p_card jsonb) returns boolean
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  me text := _me(p_group);
  c jsonb := coalesce(p_card, '{}'::jsonb);
  r scorecards%rowtype;
begin
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
    delete from scorecards where group_id = p_group and listing_key = p_key and member = me;
    return false;
  end if;
  insert into scorecards (group_id, listing_key, member, bedrooms, bathrooms, kitchen, heating, laundry, damp,
                          noise, internet, landlord, lease_ok, deposit_asked, note)
    values (p_group, p_key, me, r.bedrooms, r.bathrooms, r.kitchen, r.heating, r.laundry, r.damp, r.noise,
            r.internet, r.landlord, r.lease_ok, r.deposit_asked, r.note)
    on conflict (group_id, listing_key, member) do update set
      bedrooms = excluded.bedrooms, bathrooms = excluded.bathrooms, kitchen = excluded.kitchen,
      heating = excluded.heating, laundry = excluded.laundry, damp = excluded.damp, noise = excluded.noise,
      internet = excluded.internet, landlord = excluded.landlord, lease_ok = excluded.lease_ok,
      deposit_asked = excluded.deposit_asked, note = excluded.note, updated_at = now();
  return true;
end $$;

-- A phone that turned on alerts, for this group. Same phone again just updates its entry.
create or replace function save_push_sub(p_group uuid, p_sub jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp
as $$
declare me text := _me(p_group);
begin
  if coalesce(p_sub->>'endpoint', '') !~ '^https://' then
    raise exception 'push subscription needs an https endpoint' using errcode = '22023';
  end if;
  insert into push_subs (endpoint, group_id, member, subscription) values (p_sub->>'endpoint', p_group, me, p_sub)
    on conflict (endpoint) do update
    set group_id = excluded.group_id, member = excluded.member, subscription = excluded.subscription;
end $$;

-- ---------- who may call what ----------
-- Postgres lets everyone run new functions by default; take that away, then allow only the page's ones.
-- Only signed-in people get the group functions; an invite's preview is shown before signing in.
revoke execute on function _me(uuid), _clean_name(text, int), _rating(jsonb, text),
  group_preview(text), my_groups(), create_group(text, text, text), join_group(text, text), leave_group(uuid),
  get_group_state(uuid), group_vote(uuid, text, text), group_add_note(uuid, text, text),
  group_set_status(uuid, text, text), group_set_budget(uuid, numeric), group_save_scorecard(uuid, text, jsonb),
  save_push_sub(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function group_preview(text) to anon, authenticated;
grant execute on function my_groups(), create_group(text, text, text), join_group(text, text), leave_group(uuid),
  get_group_state(uuid), group_vote(uuid, text, text), group_add_note(uuid, text, text),
  group_set_status(uuid, text, text), group_set_budget(uuid, numeric), group_save_scorecard(uuid, text, jsonb),
  save_push_sub(uuid, jsonb)
  to authenticated;
