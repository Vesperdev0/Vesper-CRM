-- Run once in the Supabase SQL editor (2026-09-23): the Project delivery pipeline becomes data,
-- so its columns can be renamed/added/reordered/removed from the Projects board exactly the way
-- the Sales board already edits pipeline_stages. Every statement is guarded or idempotent —
-- safe to re-run.
--
-- RUN ORDER: supabase/migrate-security.sql MUST be applied first. The RLS policy at the bottom
-- calls public.is_approved(), which that migration creates. Applying this one first fails on
-- `function public.is_approved() does not exist`.

-- 1) The table. Same shape as pipeline_stages, deliberately — two stage tables that differ in
--    shape would need two sets of CRUD, and the whole point is that the Projects board reuses
--    the Sales board's model.
--
--    `kind` is NOT decoration. On pipeline_stages, kind='won' is what drives the Sales→Projects
--    handover. Here kind='gate' marks the stage that reveals "Convert to Retainer" on a company's
--    Project tab. See section 4 for why that matters the moment stages become renameable.
create table if not exists project_stages (
 id uuid primary key default gen_random_uuid(),
 name text not null unique,
 kind text not null default 'open' check (kind in ('open','gate','closed')),
 position int not null,
 created_at timestamptz not null default now()
);

-- 2) THE CONSTRAINT HAS TO GO.
--    companies.project_stage carried a CHECK pinning it to the eleven hardcoded stage names
--    (added in migrate-pipeline.sql, re-added in migrate-stage-names.sql and schema.sql). That
--    constraint and an editable stage list are mutually exclusive: renaming a column, or adding
--    a new one and dragging a company onto it, writes a name the CHECK has never heard of and
--    the database rejects the write outright.
--
--    companies.lead_status — the column the Sales board has edited freely since migrate-pipeline
--    — has never had such a constraint. This brings project_stage to the same integrity model:
--    the stage list is the source of truth, held in project_stages, and referential correctness
--    is maintained by the app's rename/delete guards rather than by a check that has to be
--    rewritten by hand on every stage edit.
--
--    WARNING: re-running supabase/schema.sql, migrate-pipeline.sql or migrate-stage-names.sql
--    after this will put the constraint back and silently break stage editing again. Those files
--    predate this one; this is the current model.
alter table companies drop constraint if exists companies_project_stage_check;

-- 3) Seed from the eleven stages the app has been hardcoding, in the same order, so no existing
--    company row changes column on migration day. on conflict (name) keeps a re-run harmless and
--    preserves any renaming already done through the UI.
insert into project_stages (name, kind, position) values
 ('Onboarding','open',1),
 ('Sitemap & Wireframe','open',2),
 ('Structural Anchors','open',3),
 ('Portfolio + Quiz (Premium only)','open',4),
 ('Build in Progress','open',5),
 ('Full Site Review','open',6),
 ('Live Revision Walkthrough','open',7),
 ('Final QA','open',8),
 ('Launch Prep','open',9),
 ('Live / Handover','gate',10),
 ('Retainer Active / Project Closed','closed',11)
on conflict (name) do nothing;

-- 4) The retainer gate, by marker rather than by literal.
--    RetainerBlock gated "Convert to Retainer" on the string 'Live / Handover'. With a fixed
--    stage list that was fine. With an editable one it is a trap: renaming that column to
--    anything else would leave the comparison permanently false, and the Convert action would
--    vanish from the product with no error and nothing in the UI to explain it.
--
--    Reading the gate off kind='gate' instead means the marker travels with the row through any
--    rename, exactly as kind='won' already travels on pipeline_stages. This statement is the
--    idempotent repair for a database seeded before the marker existed.
update project_stages set kind = 'gate'
where name = 'Live / Handover' and kind <> 'gate';

-- Exactly one gate. Two would make "the stage that unlocks conversion" ambiguous, and the app
-- picks the lowest position, which would be an arbitrary answer rather than a stated one.
create unique index if not exists project_stages_one_gate
 on project_stages ((kind)) where kind = 'gate';

create index if not exists project_stages_position_idx on project_stages (position);

-- 5) RLS. Matches the approved-gate applied to every other table in migrate-security.sql.
--    Never `using (true)` — a new table is either policy-gated or world-readable.
alter table project_stages enable row level security;
drop policy if exists "approved project_stages" on project_stages;
create policy "approved project_stages" on project_stages for all to authenticated
 using (public.is_approved()) with check (public.is_approved());
