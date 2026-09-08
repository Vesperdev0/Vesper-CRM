-- Run once in the Supabase SQL editor (2026-09-08): drop the "Round N:" prefixes from the
-- delivery stage names. Renames the values already stored on companies and swaps the check
-- constraint to match. Idempotent — rows already renamed are left alone.

-- Drop the constraint BEFORE renaming, or the new values violate the old check.
alter table companies drop constraint if exists companies_project_stage_check;

update companies set project_stage = case project_stage
 when 'Round 1: Sitemap & Wireframe' then 'Sitemap & Wireframe'
 when 'Round 2: Structural Anchors' then 'Structural Anchors'
 when 'Round 2.5: Portfolio + Quiz (Premium only)' then 'Portfolio + Quiz (Premium only)'
 when 'Round 3: Full Site Review' then 'Full Site Review'
 when 'Round 4: Live Revision Walkthrough' then 'Live Revision Walkthrough'
 else project_stage end
where project_stage is not null;

alter table companies add constraint companies_project_stage_check check (project_stage in (
 'Onboarding','Sitemap & Wireframe','Structural Anchors','Portfolio + Quiz (Premium only)',
 'Build in Progress','Full Site Review','Live Revision Walkthrough','Final QA','Launch Prep',
 'Live / Handover','Retainer Active / Project Closed'));
