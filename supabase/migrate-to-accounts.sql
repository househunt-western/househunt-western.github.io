-- One-time move from the old one-group version (a shared group code, names typed in by hand)
-- to accounts + many groups. Only needed on a database set up before accounts existed.
--
-- Run these in Supabase's SQL editor, in this order (SETUP.md has the details):
--   1. this file
--   2. schema.sql
--   3. select adopt_old_group('<the old group code>', '<a name for the group>');
--
-- Step 1 moves the old tables into a "v1" schema, out of the way. Step 2 makes the new tables
-- and functions. Step 3 turns the old group into a normal group whose invite code is the old
-- group code, so the old invite link keeps working. Everyone's names come across unclaimed:
-- each friend signs in, taps their name, and gets their votes, notes and scorecards back.

do $$
begin
  if to_regclass('public.settings') is not null then
    create schema if not exists v1;
    alter table public.settings set schema v1;
    alter table public.members set schema v1;
    alter table public.votes set schema v1;
    alter table public.notes set schema v1;
    alter table public.listing_status set schema v1;
    alter table public.scorecards set schema v1;
    alter table public.push_subs set schema v1;
    alter table public.push_sent set schema v1;
  end if;
end $$;

create or replace function adopt_old_group(p_invite text, p_name text) returns text
language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  gid uuid;
  n_members int;
  n_votes int;
begin
  if to_regclass('v1.settings') is null then
    raise exception 'nothing to move: run migrate-to-accounts.sql first (or it already ran)';
  end if;
  if not exists (select 1 from v1.settings
                 where group_code_hash = encode(sha256(convert_to(coalesce(p_invite, ''), 'UTF8')), 'hex')) then
    raise exception 'that is not the old group code';
  end if;

  insert into groups (name, invite_code) values (_clean_name(p_name, 40), p_invite) returning id into gid;
  insert into group_members (group_id, name, budget_max, created_at)
    select gid, left(name, 20), budget_max, created_at from v1.members order by position;
  insert into votes (group_id, listing_key, member, vote, updated_at)
    select gid, listing_key, left(member, 20), vote, updated_at from v1.votes;
  insert into notes (group_id, listing_key, member, text, created_at)
    select gid, listing_key, left(member, 20), text, created_at from v1.notes order by created_at, id;
  insert into listing_status (group_id, listing_key, status, updated_by, updated_at)
    select gid, listing_key, status, left(updated_by, 20), updated_at from v1.listing_status;
  insert into scorecards (group_id, listing_key, member, bedrooms, bathrooms, kitchen, heating, laundry, damp,
                          noise, internet, landlord, lease_ok, deposit_asked, note, updated_at)
    select gid, listing_key, left(member, 20), bedrooms, bathrooms, kitchen, heating, laundry, damp,
           noise, internet, landlord, lease_ok, deposit_asked, note, updated_at
    from v1.scorecards;
  insert into push_subs (endpoint, group_id, member, subscription, created_at)
    select endpoint, gid, left(member, 20), subscription, created_at from v1.push_subs;
  insert into push_sent (group_id, kind, listing_key, sent_at)
    select gid, kind, listing_key, sent_at from v1.push_sent;

  select count(*) into n_members from group_members where group_id = gid;
  select count(*) into n_votes from votes where group_id = gid;
  drop schema v1 cascade;
  return format('Moved %s people and %s votes into "%s"', n_members, n_votes, p_name);
end $$;

revoke execute on function adopt_old_group(text, text) from public, anon, authenticated;
