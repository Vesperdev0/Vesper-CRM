-- OPTIONAL AND DESTRUCTIVE. Unlike the other files in this folder, this one deletes columns
-- and a table. Nothing in the app requires it — it exists so the dead schema can be removed
-- deliberately rather than sitting there indefinitely being mistaken for a feature.
--
-- DO NOT RUN IT BLIND. Run the audit block first and read the counts. Dropping a column drops
-- its data, and Postgres will not give it back. Take a backup first.
--
-- Everything here was verified unused by the application on 2026-09-16: no .ts/.tsx file reads
-- or writes any of it. That is a fact about the code, not about your data — if you have been
-- populating any of these by hand in the Supabase table editor, the audit will show it.

-- ---------------------------------------------------------------- 1. AUDIT (run alone first)
-- Every count here should be 0. Any non-zero means real data lives in that column — stop and
-- decide what to do with it before running section 2.
select 'companies.deal_value_min'  as column, count(*) as rows_with_data from companies     where deal_value_min  is not null
union all select 'companies.deal_value_max',  count(*) from companies     where deal_value_max  is not null
union all select 'companies.deal_value_type', count(*) from companies     where deal_value_type is distinct from 'none'
union all select 'companies.facebook',        count(*) from companies     where facebook        is not null
union all select 'contacts.facebook',         count(*) from contacts      where facebook        is not null
union all select 'contacts.address',          count(*) from contacts      where address         is not null
union all select 'opportunities (all rows)',  count(*) from opportunities
union all select 'activities.opportunity_id', count(*) from activities    where opportunity_id  is not null
union all select 'tasks.opportunity_id',      count(*) from tasks         where opportunity_id  is not null
union all select 'meetings.opportunity_id',   count(*) from meetings      where opportunity_id  is not null;

-- ---------------------------------------------------------------- 2. DROP (only after the above)
-- Uncomment the block below once the audit reads all zeros.
--
-- begin;
--
-- -- Deal value ranges: companies.deal_value is the only one the app ever reads or writes.
-- alter table companies drop column if exists deal_value_min;
-- alter table companies drop column if exists deal_value_max;
-- alter table companies drop column if exists deal_value_type;
--
-- -- Facebook was never in any form; Instagram and LinkedIn are the two that are.
-- alter table companies drop column if exists facebook;
-- alter table contacts  drop column if exists facebook;
-- -- Address lives on the company, and the contact form never collected a separate one.
-- alter table contacts  drop column if exists address;
--
-- -- The multi-deal-per-company model was never built: one company carries one lead_status and
-- -- one deal_value. Drop the referencing columns before the table they point at.
-- alter table activities drop column if exists opportunity_id;
-- alter table tasks      drop column if exists opportunity_id;
-- alter table meetings   drop column if exists opportunity_id;
-- drop table if exists opportunities;
--
-- commit;

-- ---------------------------------------------------------------- deliberately NOT dropped
--   audit_log        — unused by the app, but kept and made append-only in migrate-security.sql
--                      so change history can be switched on without another migration.
--   profiles.role    — now read and displayed in Settings. Recorded, not yet enforced.
--   meetings.status  — written as 'scheduled' on insert and preserved across calendar re-sync.
--                      No UI changes it yet, but the sync route depends on it staying put.
