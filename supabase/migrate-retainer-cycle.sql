-- Run once in the Supabase SQL editor (2026-09-23): the recurring retainer cycle.
-- Every statement is guarded or idempotent — safe to re-run.
--
-- RUN ORDER: supabase/migrate-retainers.sql MUST be applied first — this alters the table it
-- creates and recreates the view it defines.
--
-- WHAT THIS IS, AND WHAT IT IS NOT:
-- retainers.status (pending/active/paused/churned) is the BILLING state of the engagement.
-- retainers.cycle_stage is WHERE IN THE MONTH the delivery work has got to. They are separate
-- concerns and are deliberately not merged: pausing a retainer must not lose its place in the
-- cycle, and moving through the cycle must not imply anything about billing. A paused retainer
-- keeps whatever cycle_stage it was on and resumes there.
--
-- This is a LOOP, not a funnel. Stage 06 hands back to stage 02 for the next month rather than
-- terminating, and cycle_number counts how many times that has happened, so "week 2 of cycle 3"
-- is distinguishable from "week 2 of cycle 1" instead of state being overwritten with no history.

-- 1) Where in the month this engagement is.
--    NOT NULL DEFAULT backfills every existing row to stage 01 in the same statement.
alter table retainers add column if not exists cycle_stage text not null
  default '01 — Retainer Activated';

-- Which month of the engagement this is. Starts at 1, increments only when stage 06 completes.
alter table retainers add column if not exists cycle_number int not null default 1;

-- The six stages are fixed by the SOP and are NOT user-editable, so unlike companies.project_stage
-- a CHECK is the right tool here: there is no UI that can ever write a seventh value. If the cycle
-- ever does become editable from a board, this constraint has to go the same way
-- companies_project_stage_check did — see supabase/migrate-project-stages.sql section 2.
--
-- NOTE the em dashes (—, U+2014), not hyphens. They must match app/page.tsx's retainerCycleStages
-- exactly or every write is rejected. The verification query at the bottom checks this.
alter table retainers drop constraint if exists retainers_cycle_stage_check;
alter table retainers add constraint retainers_cycle_stage_check check (cycle_stage in (
  '01 — Retainer Activated',
  '02 — Week 1: GBP / Site Health',
  '03 — Week 2: Website Work',
  '04 — Week 3: SEO / Performance',
  '05 — Week 4: Report / Billing',
  '06 — Month Complete → Next Cycle'));

alter table retainers drop constraint if exists retainers_cycle_number_check;
alter table retainers add constraint retainers_cycle_number_check check (cycle_number >= 1);

-- 2) RECREATE THE VIEW. This is not optional and it is not cosmetic.
--    current_retainers is defined as `select *`, and Postgres expands `*` at CREATE VIEW time
--    into a fixed column list. Adding columns to retainers does NOT add them to the view. The
--    app reads live retainers exclusively through this view, so without this step cycle_stage
--    and cycle_number would never reach the UI: every retainer would render at stage 01 forever,
--    with no error anywhere to say why.
--
--    Definition below is copied verbatim from migrate-retainers.sql so the two cannot drift.
--    security_invoker is load-bearing: without it the view runs with its owner's rights and
--    bypasses row-level security on retainers entirely.
drop view if exists current_retainers;
create view current_retainers with (security_invoker = true) as
 select distinct on (company_id) *
 from retainers
 where status <> 'churned'
 order by company_id, started_at desc nulls last;

grant select on current_retainers to authenticated;

-- 3) RLS is unchanged. Same table, same "approved retainers" policy from migrate-retainers.sql,
--    which already covers every column. Nothing to add — stated explicitly so the omission reads
--    as deliberate rather than forgotten.

-- ---------------------------------------------------------------- verify
-- Expect: both columns present, and every live retainer visible through the view carrying them.
-- If cycle_stage comes back missing from the second query, the view did not get recreated.
--
-- select column_name, data_type, column_default
--   from information_schema.columns
--  where table_name = 'retainers' and column_name in ('cycle_stage','cycle_number');
--
-- select company_id, status, cycle_stage, cycle_number from current_retainers order by cycle_stage;
