create extension if not exists pgcrypto;

create table if not exists profiles (
 id uuid primary key references auth.users(id) on delete cascade,
 username text unique,
 display_name text,
 role text not null default 'member' check (role in ('admin','member')),
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
alter table milestones enable row level security;
create policy "authenticated milestones" on milestones for all to authenticated using (true) with check (true);
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

create policy "authenticated profiles" on profiles for select to authenticated using (true);
create policy "authenticated companies" on companies for all to authenticated using (true) with check (true);
create policy "authenticated contacts" on contacts for all to authenticated using (true) with check (true);
create policy "authenticated opportunities" on opportunities for all to authenticated using (true) with check (true);
create policy "authenticated activities" on activities for all to authenticated using (true) with check (true);
create policy "authenticated tasks" on tasks for all to authenticated using (true) with check (true);
create policy "authenticated meetings" on meetings for all to authenticated using (true) with check (true);
create policy "own calendar connection" on calendar_connections for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "authenticated audit" on audit_log for all to authenticated using (true) with check (true);

insert into profiles (id, username, display_name, role)
select id, coalesce(raw_user_meta_data->>'username', split_part(email,'@',1)), coalesce(raw_user_meta_data->>'display_name', split_part(email,'@',1)), 'admin'
from auth.users
on conflict (id) do nothing;

create or replace function set_updated_at() returns trigger language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
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
-- 2026-09-08: currently unused / reserved — nothing in the UI reads or writes these yet:
--   companies.deal_value_min / deal_value_max / deal_value_type  (deal value ranges)
--   opportunities  (multi-deal-per-company model)
--   audit_log      (change history)
--   meetings.meeting_type is written by default only; meetings.status is settable but has no UI
-- Kept so no data is dropped; wire them up or drop them deliberately later.

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
create policy "authenticated pipeline_stages" on pipeline_stages for all to authenticated using (true) with check (true);
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
