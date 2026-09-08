-- Run once in the Supabase SQL editor (2026-09-08): editable sales pipeline + the real
-- 11-step project delivery pipeline + Sales→Projects handover for already-closed companies.
-- Every statement is guarded or idempotent — safe to re-run.

-- 1) Sales pipeline stages become data, so columns can be renamed/added from the Sales board.
--    kind marks terminal columns; 'won' triggers the automatic handover into Projects.
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

-- 2) Project delivery pipeline v2 — the real 11-step flow. Drop the old constraint BEFORE
--    remapping (the new values would violate the old check otherwise), then re-add it.
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

-- 3) Companies already closed-won enter delivery, which removes them from the Sales board.
update companies set project_stage = 'Onboarding'
where project_stage is null and lead_status = 'Closed & Onboarding';
