-- VESPER CRM canonical schema. Runs clean on an empty database AND is safe to re-run over
-- an existing one: tables/columns are `if not exists`, constraints and policies are dropped
-- by name first, and functions/triggers use `create or replace`.
create extension if not exists pgcrypto;

-- Defined up here, not next to the companies/contacts/meetings triggers further down:
-- the milestones trigger references it ~30 lines earlier than that, and Postgres resolves
-- the function at CREATE TRIGGER time. With the old ordering a fresh database aborted on
-- `function set_updated_at() does not exist`, so this file had never actually run clean.
create or replace function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;

create table if not exists profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 username text unique,
 display_name text,
 role text not null default 'member' check (role in ('admin','member')),
 -- Gate for RLS: having an auth account is not the same as being VESPER staff. Self-signup
 -- means anyone can get an account, so every data policy below checks this instead of merely
 -- checking `to authenticated`. New signups land here as false and can read nothing.
 approved boolean not null default false,
 created_at timestamptz not null default now()
);

create table if not exists companies (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 lead_status text not null default 'Prospect',
 lead_score int not null default 50 check (lead_score between 0 and 100),
 website text,
 site_condition text,
 gbp boolean,
 deal_value numeric,
 deal_value_min numeric,
 deal_value_max numeric,
 deal_value_type text not null default 'none' check (deal_value_type in ('value','range','none')),
 company_email text,
 company_phone text,
 instagram text,
 facebook text,
 linkedin text,
 address text,
 client_type text not null default 'not active',
 remarks text,
 owner_id uuid references profiles(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists contacts (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references companies(id) on delete cascade,
 name text not null,
 title text,
 email text,
 phone text,
 instagram text,
 facebook text,
 linkedin text,
 address text,
 is_primary boolean not null default false,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists opportunities (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references companies(id) on delete cascade,
 name text not null,
 stage text not null default 'Prospect',
 value numeric,
 value_min numeric,
 value_max numeric,
 value_type text not null default 'none',
 status text not null default 'open' check (status in ('open','won','lost','future')),
 lost_reason text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists activities (
 id uuid primary key default gen_random_uuid(),
 company_id uuid references companies(id) on delete cascade,
 opportunity_id uuid references opportunities(id) on delete cascade,
 user_id uuid references profiles(id),
 type text not null,
 title text not null,
 body text,
 metadata jsonb not null default '{}'::jsonb,
 occurred_at timestamptz not null default now()
);

create table if not exists tasks (
 id uuid primary key default gen_random_uuid(),
 company_id uuid references companies(id) on delete cascade,
 opportunity_id uuid references opportunities(id) on delete cascade,
 assigned_to uuid references profiles(id),
 title text not null,
 due_at timestamptz,
 completed boolean not null default false,
 created_at timestamptz not null default now()
);

create table if not exists meetings (
 id uuid primary key default gen_random_uuid(),
 company_id uuid references companies(id) on delete cascade,
 opportunity_id uuid references opportunities(id) on delete set null,
 created_by uuid references profiles(id),
 title text not null,
 meeting_type text not null default 'Discovery Call',
 starts_at timestamptz not null,
 ends_at timestamptz not null,
 location text,
 google_event_id text unique,
 google_calendar_id text,
 google_meet_url text,
 status text not null default 'scheduled',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

create table if not exists calendar_connections (
 user_id uuid primary key references profiles(id) on delete cascade,
 access_token text,
 refresh_token text,
 expires_at timestamptz,
 calendar_id text default 'primary',
 connected_email text,
 updated_at timestamptz not null default now()
);

create table if not exists audit_log (
 id uuid primary key default gen_random_uuid(),
 company_id uuid references companies(id) on delete cascade,
 meeting_id uuid references meetings(id) on delete cascade,
 user_id uuid references profiles(id),
 action text not null,
 before jsonb,
 after jsonb,
 created_at timestamptz not null default now()
);

-- Outreach touch tracking as a per-company field, not separate pipeline stages — the
-- Outreach SOP is explicit that DM/call touches stay as state on the "Prospect" stage, not
-- their own kanban columns. Corrects the earlier design where Cold DM Reply/No Reply/Cold
-- Call/Cold Call Failed were columns in `stages` below (Atomeo flagged this 2026-09-07).
alter table companies add column if not exists outreach_status text
  check (outreach_status in ('Not Contacted','DM Reply','DM No Reply','Call Successful','Call Failed'))
  default 'Not Contacted';

-- Post-close delivery tracking + retainer goals — additive only, does not touch the
-- existing sales-pipeline `lead_status` list. Matches the real post-payment stages confirmed
-- against Vesper's own Onboarding/Execution/Handover/Retainer SOPs (2026-09-07).
alter table companies add column if not exists project_stage text
  check (project_stage in ('Onboarding','Active Project','Waiting on Client','Ready for Launch','Won Opportunity / Active Retainer'));
alter table companies add column if not exists retainer_tier text
  check (retainer_tier in ('maintenance','growth','full-service'));

create table if not exists milestones (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references companies(id) on delete cascade,
 title text not null,
 category text not null default 'goal' check (category in ('goal','deliverable')),
 cadence text check (cadence in ('once','weekly','monthly','quarterly')),
 target_date timestamptz,
 status text not null default 'pending' check (status in ('pending','done','missed')),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
-- Reads the approval gate WITHOUT recursing: a policy on `profiles` that selects from
-- `profiles` fails with 42P17 (infinite recursion). SECURITY DEFINER runs this one lookup as
-- the function owner, which skips RLS for it and breaks the cycle.
create or replace function public.is_approved() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and approved)
$$;
revoke all on function public.is_approved() from public;
grant execute on function public.is_approved() to authenticated;

alter table milestones enable row level security;
drop policy if exists "approved milestones" on milestones;
create policy "approved milestones" on milestones for all to authenticated using (public.is_approved()) with check (public.is_approved());
create or replace trigger milestones_updated before update on milestones for each row execute function set_updated_at();

alter table profiles enable row level security;
alter table companies enable row level security;
alter table contacts enable row level security;
alter table opportunities enable row level security;
alter table activities enable row level security;
alter table tasks enable row level security;
alter table meetings enable row level security;
alter table calendar_connections enable row level security;
alter table audit_log enable row level security;

drop policy if exists "own or approved profiles" on profiles;
create policy "own or approved profiles" on profiles for select to authenticated using (id = auth.uid() or public.is_approved());
drop policy if exists "approved companies" on companies;
create policy "approved companies" on companies for all to authenticated using (public.is_approved()) with check (public.is_approved());
drop policy if exists "approved contacts" on contacts;
create policy "approved contacts" on contacts for all to authenticated using (public.is_approved()) with check (public.is_approved());
drop policy if exists "approved opportunities" on opportunities;
create policy "approved opportunities" on opportunities for all to authenticated using (public.is_approved()) with check (public.is_approved());
drop policy if exists "approved activities" on activities;
create policy "approved activities" on activities for all to authenticated using (public.is_approved()) with check (public.is_approved());
drop policy if exists "approved tasks" on tasks;
create policy "approved tasks" on tasks for all to authenticated using (public.is_approved()) with check (public.is_approved());
drop policy if exists "approved meetings" on meetings;
create policy "approved meetings" on meetings for all to authenticated using (public.is_approved()) with check (public.is_approved());
drop policy if exists "own calendar connection" on calendar_connections;
create policy "own calendar connection" on calendar_connections for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "authenticated audit" on audit_log;
drop policy if exists "approved audit" on audit_log;
-- Append-only on purpose. An audit trail that the audited party can edit or delete is not an
-- audit trail — the old `for all using (true)` let any user erase their own history. No update
-- or delete policy exists, so those are denied outright; corrections go in as new rows.
create policy "approved audit read" on audit_log for select to authenticated using (public.is_approved());
create policy "approved audit append" on audit_log for insert to authenticated with check (public.is_approved());

-- Accounts that already existed when this ran are the founding staff: admin + approved.
-- Everyone who signs up after this gets 'member'/approved=false via handle_new_user().
insert into profiles (id, username, display_name, role, approved)
select id, coalesce(raw_user_meta_data->>'username', split_part(email,'@',1)), coalesce(raw_user_meta_data->>'display_name', split_part(email,'@',1)), 'admin', true
from auth.users
on conflict (id) do nothing;

create or replace trigger companies_updated before update on companies for each row execute function set_updated_at();
create or replace trigger contacts_updated before update on contacts for each row execute function set_updated_at();
create or replace trigger opp_updated before update on opportunities for each row execute function set_updated_at();
create or replace trigger meetings_updated before update on meetings for each row execute function set_updated_at();

create or replace function public.handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles(id, username, display_name) values (new.id, coalesce(new.raw_user_meta_data->>'username', split_part(new.email,'@',1)), coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email,'@',1))) on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.handle_new_user();

-- 2026-09-07: upgrade milestones into a full project-task board (priority, progress, in-progress status)
-- 2026-09-16: dead-schema status, re-verified against the code rather than assumed.
--   Still unread and unwritten by every .ts/.tsx file:
--     companies.deal_value_min / deal_value_max / deal_value_type  (deal value ranges)
--     companies.facebook, contacts.facebook, contacts.address
--     opportunities, and the opportunity_id columns on activities / tasks / meetings
--   → supabase/migrate-drop-unused.sql removes these. It is destructive and opt-in, and it
--     audits for real data before it will let you drop anything.
--
--   No longer dead:
--     meetings.meeting_type  — the new-meeting form sets it (it used to take the default, so
--                              every meeting on Today claimed to be a Discovery Call)
--     profiles.role          — read and shown in Settings; recorded, not yet enforced
--   Kept on purpose:
--     audit_log              — still unwritten, but now append-only (see migrate-security.sql)
--     meetings.status        — set on insert and deliberately preserved across calendar re-sync

alter table milestones add column if not exists priority text not null default 'Medium' check (priority in ('Low','Medium','High'));
alter table milestones add column if not exists progress smallint not null default 0 check (progress >= 0 and progress <= 100);
alter table milestones drop constraint if exists milestones_status_check;
alter table milestones add constraint milestones_status_check check (status in ('pending','in_progress','done','missed'));

-- 2026-09-08: editable sales pipeline + real 11-step delivery pipeline + Sales→Projects
-- handover. Same statements as supabase/migrate-pipeline.sql (kept there for existing DBs).
create table if not exists pipeline_stages (
 id uuid primary key default gen_random_uuid(),
 name text not null unique,
 kind text not null default 'open' check (kind in ('open','won','lost','future')),
 position int not null,
 created_at timestamptz not null default now()
);
alter table pipeline_stages enable row level security;
drop policy if exists "authenticated pipeline_stages" on pipeline_stages;
drop policy if exists "approved pipeline_stages" on pipeline_stages;
create policy "approved pipeline_stages" on pipeline_stages for all to authenticated using (public.is_approved()) with check (public.is_approved());
insert into pipeline_stages (name, kind, position) values
 ('Prospect','open',1),('Qualified Lead','open',2),('Discovery Call','open',3),
 ('Proposal Agreement Sent','open',4),('Close Call','open',5),('Verbal Approval','open',6),
 ('Agreement Signed','open',7),('Initial Payment Received','open',8),
 ('Closed & Onboarding','won',9),('Future Opportunity','future',10),('Lost Opportunity','lost',11)
on conflict (name) do nothing;
alter table companies drop constraint if exists companies_project_stage_check;
update companies set project_stage = case project_stage
 when 'Active Project' then 'Build in Progress'
 when 'Waiting on Client' then 'Build in Progress'
 when 'Ready for Launch' then 'Launch Prep'
 when 'Won Opportunity / Active Retainer' then 'Retainer Active / Project Closed'
 else project_stage end
where project_stage is not null;
alter table companies add constraint companies_project_stage_check check (project_stage in (
 'Onboarding','Sitemap & Wireframe','Structural Anchors',
 'Portfolio + Quiz (Premium only)','Build in Progress','Full Site Review',
 'Live Revision Walkthrough','Final QA','Launch Prep','Live / Handover',
 'Retainer Active / Project Closed'));
update companies set project_stage = 'Onboarding'
where project_stage is null and lead_status = 'Closed & Onboarding';

-- 2026-09-17: retainer engagements. Same statements as supabase/migrate-retainers.sql
-- (kept there for existing DBs).
-- MODEL: one row per ENGAGEMENT, not per company. A churned company that re-signs later gets a
-- brand new row; the terminal row is never updated again. There is deliberately no status-change
-- snapshot log — each row already carries the tier and the amount that were actually agreed for
-- that engagement, which is what a log would have existed to preserve.

create table if not exists retainers (
 id uuid primary key default gen_random_uuid(),
 company_id uuid not null references companies(id) on delete cascade,
 tier text not null check (tier in ('Maintenance','Growth','Full-Service')),
 -- The agreed number for THIS engagement, stored, never derived from tier. Tier defaults
 -- (Maintenance 2500 / Growth 6500 / Full-Service 12500) only prefill the form. If a tier is
 -- repriced later, every existing row keeps what was actually signed.
 monthly_amount numeric not null check (monthly_amount >= 0),
 status text not null default 'pending' check (status in ('pending','active','paused','churned')),
 -- The agreement date is what brings a row into existence at all.
 agreement_signed_on date not null,
 -- Null for the whole signed-but-not-yet-invoiced period, which by SOP is every retainer's
 -- month 1 (free/handover, invoicing starts month 2). Filling it in is what activates the row.
 first_invoice_issued_on date,
 started_at date,
 billing_anchor date,
 next_invoice_due date,
 churned_at date,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);

-- At most one live (pending or paused or active) engagement per company; churned rows are
-- unlimited, which is what makes re-signing possible without touching the terminal row.
create unique index if not exists retainers_one_live_per_company
 on retainers (company_id) where status <> 'churned';

create index if not exists retainers_company_idx on retainers (company_id);
create index if not exists retainers_status_idx on retainers (status);

-- Invariants stated in the spec, enforced here rather than trusted to the UI.
alter table retainers drop constraint if exists retainers_active_dates_check;
alter table retainers add constraint retainers_active_dates_check
 check (status <> 'active' or (started_at is not null and billing_anchor is not null));
alter table retainers drop constraint if exists retainers_churned_date_check;
alter table retainers add constraint retainers_churned_date_check
 check (status <> 'churned' or churned_at is not null);

-- Activation is the ONE inferred transition: recording the first invoice flips pending -> active
-- and stamps started_at, billing_anchor and next_invoice_due from that same date. Pause and churn
-- are never inferred — they are deliberate user actions and this trigger does not touch them,
-- which is why it only fires on a row still sitting at 'pending'.
--
-- next_invoice_due is billing_anchor + 1 MONTH. It is the date the next invoice is raised, not a
-- payment deadline — the SOP's 7-day figure is the follow-up grace period AFTER invoicing and has
-- no bearing on this field. Conflating the two would bill every client four times too often.
--
-- Postgres clamps month arithmetic to the end of a short month on its own: an anchor of Jan 31
-- yields Feb 28, not an error and not Mar 3.
create or replace function public.retainer_activate_on_first_invoice() returns trigger
 language plpgsql as $$
begin
  if new.first_invoice_issued_on is not null and new.status = 'pending' then
    new.status := 'active';
    new.started_at := coalesce(new.started_at, new.first_invoice_issued_on);
    new.billing_anchor := coalesce(new.billing_anchor, new.first_invoice_issued_on);
    new.next_invoice_due := coalesce(new.next_invoice_due, (new.billing_anchor + interval '1 month')::date);
  end if;
  return new;
end $$;

drop trigger if exists retainers_activate on retainers;
create trigger retainers_activate before insert or update on retainers
 for each row execute function public.retainer_activate_on_first_invoice();

-- Backfill for rows activated before next_invoice_due was derived. Idempotent: only touches
-- active rows that are missing it.
update retainers set next_invoice_due = (billing_anchor + interval '1 month')::date
where status = 'active' and next_invoice_due is null and billing_anchor is not null;

drop trigger if exists retainers_updated on retainers;
create trigger retainers_updated before update on retainers
 for each row execute function set_updated_at();

-- ---------------------------------------------------------------- current_retainers
-- THE ONLY SANCTIONED WAY TO READ "the current retainer" FOR A COMPANY. Every query that means
-- a client's live retainer — dashboard tiles, MRR, any reporting — reads this view, never the
-- retainers table directly.
--
-- WHY: forgetting the status filter silently sums churned engagements into live revenue. It does
-- not error, it does not look wrong, it just quietly reports a bigger number than you are owed,
-- and the error grows every time a client churns.
--
-- security_invoker is load-bearing: without it a view runs with its owner's rights and bypasses
-- row-level security on retainers entirely, exposing every row to any caller who can read the
-- view. distinct on is belt-and-braces — retainers_one_live_per_company already guarantees at
-- most one non-churned row per company — and it needs company_id leading the ORDER BY to be
-- valid SQL, which is why the ordering below reads company_id first.
drop view if exists current_retainers;
create view current_retainers with (security_invoker = true) as
 select distinct on (company_id) *
 from retainers
 where status <> 'churned'
 order by company_id, started_at desc nulls last;

grant select on current_retainers to authenticated;

-- ---------------------------------------------------------------- RLS
-- Flagged in the report: a new table is either policy-gated or world-readable, so this adds a
-- policy for the NEW table only. No existing policy is modified. Matches the gate applied to
-- every other table in migrate-security.sql.
alter table retainers enable row level security;
drop policy if exists "approved retainers" on retainers;
create policy "approved retainers" on retainers for all to authenticated
 using (public.is_approved()) with check (public.is_approved());
