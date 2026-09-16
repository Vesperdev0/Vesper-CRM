-- Run once in the Supabase SQL editor (2026-09-17): the retainer engagement table and the
-- current_retainers view. Every statement is guarded or idempotent — safe to re-run.
--
-- RUN ORDER: supabase/migrate-security.sql MUST be applied first. The RLS policy at the bottom
-- of this file calls public.is_approved(), which that migration creates. Applying this one first
-- fails on `function public.is_approved() does not exist`.
--
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
