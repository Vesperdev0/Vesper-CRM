-- Run once in the Supabase SQL editor. Closes the "anyone who signs up owns the CRM" hole.
-- Every statement is guarded or idempotent — safe to re-run.
--
-- WHY AN APPROVAL GATE AND NOT PER-ROW OWNERSHIP:
-- This is a shared two-person workspace — both users are supposed to see every company. So
-- scoping rows to owner_id would break the product, not secure it. The actual hole is that
-- `to authenticated using (true)` treats "has an account" as "is staff", while self-signup
-- means anyone can get an account. This makes the two different things again: signing up
-- still works, but an unapproved account reads and writes exactly nothing.
--
-- THIS IS NOT THE WHOLE FIX. Also do these two in the dashboard, they are not SQL:
--   1. Authentication → Sign In / Providers → turn OFF "Allow new users to sign up".
--   2. Project Settings → API → rotate the publishable key (the old one is public on GitHub),
--      then update NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY in .env.local and on your host.

-- 1) The gate itself.
alter table profiles add column if not exists approved boolean not null default false;

-- Existing accounts are the real staff — keep them working. New signups default to false.
update profiles set approved = true where approved = false;

-- 2) Read the gate WITHOUT recursion. A policy on `profiles` that selects from `profiles`
--    deadlocks with error 42P17 (infinite recursion). SECURITY DEFINER runs the lookup as the
--    function owner, which bypasses RLS on that one read and breaks the cycle.
create or replace function public.is_approved() returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles where id = auth.uid() and approved)
$$;
revoke all on function public.is_approved() from public;
grant execute on function public.is_approved() to authenticated;

-- 3) Re-point every data policy at the gate. Dropped by name first so this is re-runnable.
drop policy if exists "authenticated companies" on companies;
create policy "approved companies" on companies for all to authenticated
  using (public.is_approved()) with check (public.is_approved());

drop policy if exists "authenticated contacts" on contacts;
create policy "approved contacts" on contacts for all to authenticated
  using (public.is_approved()) with check (public.is_approved());

drop policy if exists "authenticated opportunities" on opportunities;
create policy "approved opportunities" on opportunities for all to authenticated
  using (public.is_approved()) with check (public.is_approved());

drop policy if exists "authenticated activities" on activities;
create policy "approved activities" on activities for all to authenticated
  using (public.is_approved()) with check (public.is_approved());

drop policy if exists "authenticated tasks" on tasks;
create policy "approved tasks" on tasks for all to authenticated
  using (public.is_approved()) with check (public.is_approved());

drop policy if exists "authenticated meetings" on meetings;
create policy "approved meetings" on meetings for all to authenticated
  using (public.is_approved()) with check (public.is_approved());

drop policy if exists "authenticated milestones" on milestones;
create policy "approved milestones" on milestones for all to authenticated
  using (public.is_approved()) with check (public.is_approved());

drop policy if exists "authenticated pipeline_stages" on pipeline_stages;
create policy "approved pipeline_stages" on pipeline_stages for all to authenticated
  using (public.is_approved()) with check (public.is_approved());

drop policy if exists "authenticated audit" on audit_log;
drop policy if exists "approved audit" on audit_log;
-- Append-only on purpose. An audit trail that the audited party can edit or delete is not an
-- audit trail — the old `for all using (true)` let any user erase their own history. No update
-- or delete policy exists, so those are denied outright; corrections go in as new rows.
create policy "approved audit read" on audit_log for select to authenticated using (public.is_approved());
create policy "approved audit append" on audit_log for insert to authenticated with check (public.is_approved());

-- 4) profiles: you can always see your own row (the app reads your role from it, and an
--    unapproved user needs to be able to load the page far enough to be told they're pending).
--    Everyone else's row requires the gate.
drop policy if exists "authenticated profiles" on profiles;
create policy "own or approved profiles" on profiles for select to authenticated
  using (id = auth.uid() or public.is_approved());

-- 5) calendar_connections is already correctly scoped to user_id = auth.uid() — left alone
--    deliberately. It holds OAuth tokens and was never part of this hole.
