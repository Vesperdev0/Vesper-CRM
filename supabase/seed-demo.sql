-- VESPER demo data — paste into the Supabase SQL editor and Run.
-- Safe to run twice (fixed ids + on conflict do nothing). All demo rows use fixed UUIDs
-- starting with 'de300000' so the cleanup block at the bottom can remove exactly these
-- rows and nothing else. Meetings here have no google_event_id, so calendar sync will
-- neither delete nor duplicate them.
--
-- Covers: every pipeline stage in use, all outreach statuses, stalled-lead detection on
-- the Today view, the AI FAB ("companies in mumbai", "qualified leads", "no website"),
-- post-close project stages + retainer tiers, milestones in every status (incl. overdue
-- and missed), tasks (overdue / today / upcoming / done), and past + upcoming meetings.
--
-- Also covers the retainer module end to end: companies below the 'Live / Handover' gate (the
-- Convert action must stay hidden), one exactly at the gate with no retainer (the action must
-- appear), and retainers in all four states — pending, active x2 on different tiers, paused,
-- and churned.

-- ---------------------------------------------------------------- schema catch-up
-- Your live DB was created before the later additions in schema.sql, so bring it up to
-- date first. Every statement is guarded (if not exists / if exists) — safe to re-run.
alter table companies add column if not exists outreach_status text
  check (outreach_status in ('Not Contacted','DM Reply','DM No Reply','Call Successful','Call Failed'))
  default 'Not Contacted';
alter table companies add column if not exists project_stage text
  check (project_stage in ('Onboarding','Sitemap & Wireframe','Structural Anchors','Portfolio + Quiz (Premium only)','Build in Progress','Full Site Review','Live Revision Walkthrough','Final QA','Launch Prep','Live / Handover','Retainer Active / Project Closed'));
alter table companies add column if not exists retainer_tier text
  check (retainer_tier in ('maintenance','growth','full-service'));
alter table milestones add column if not exists priority text not null default 'Medium' check (priority in ('Low','Medium','High'));
alter table milestones add column if not exists progress smallint not null default 0 check (progress >= 0 and progress <= 100);
alter table milestones drop constraint if exists milestones_status_check;
alter table milestones add constraint milestones_status_check check (status in ('pending','in_progress','done','missed'));

-- The retainer table is NOT created here — it belongs to supabase/migrate-retainers.sql and
-- duplicating its DDL would give us two definitions free to drift. Fail loudly and early instead
-- of seeding half the data and leaving you to work out why the Retainer view is empty.
do $$
begin
  if to_regclass('public.retainers') is null then
    raise exception 'Run supabase/migrate-retainers.sql first — the retainers table does not exist yet.';
  end if;
end $$;

-- ---------------------------------------------------------------- companies
insert into companies (id, name, lead_status, lead_score, website, site_condition, gbp, deal_value, company_email, company_phone, instagram, address, client_type, remarks, outreach_status, project_stage, retainer_tier, owner_id, created_at, updated_at) values
('de300000-0000-4000-8000-000000000001','Sharma Dental Clinic','Prospect',35,null,'No Site',false,45000,'contact@sharmadental.in','+91 98200 11223','sharmadentalmumbai','Andheri West, Mumbai, Maharashtra','not active','[DEMO] Found via Google Maps — no website at all, strong reviews (4.7★).','Not Contacted',null,null,(select id from profiles order by created_at limit 1), now() - interval '2 days', now() - interval '2 days'),
('de300000-0000-4000-8000-000000000002','GreenLeaf Organics','Prospect',48,'greenleaforganics.in','Outdated',true,60000,'hello@greenleaforganics.in','+91 98111 40567','greenleaf.organics','Koregaon Park, Pune, Maharashtra','not active','[DEMO] DMed on Instagram, no reply yet. Site is from 2018.','DM No Reply',null,null,(select id from profiles order by created_at limit 1), now() - interval '25 days', now() - interval '21 days'),
('de300000-0000-4000-8000-000000000003','Iron Temple Fitness','Qualified Lead',72,'irontemplegym.com','Not Good',true,90000,'info@irontemplegym.com','+91 99999 88776','irontemple.delhi','Hauz Khas, New Delhi','not active','[DEMO] Cold call went well — owner wants a new site before their January membership push.','Call Successful',null,null,(select id from profiles order by created_at limit 1), now() - interval '6 days', now() - interval '1 day'),
('de300000-0000-4000-8000-000000000004','Coastal Interiors','Discovery Call',80,'coastalinteriors.co.in','Decent',false,150000,'studio@coastalinteriors.co.in','+91 98500 22334','coastal.interiors','Panaji, Goa','not active','[DEMO] Discovery call booked. Wants portfolio-heavy redesign + GBP setup.','DM Reply',null,null,(select id from profiles order by created_at limit 1), now() - interval '5 days', now() - interval '12 hours'),
('de300000-0000-4000-8000-000000000005','Zenith Ayurveda','Proposal Agreement Sent',85,'zenithayurveda.in','Outdated',true,120000,'care@zenithayurveda.in','+91 94140 55667','zenith.ayurveda','Malviya Nagar, Jaipur, Rajasthan','not active','[DEMO] Proposal sent 3 days ago — follow up if no response by Friday.','Call Successful',null,null,(select id from profiles order by created_at limit 1), now() - interval '10 days', now() - interval '3 days'),
('de300000-0000-4000-8000-000000000006','Bluewave Cafés','Verbal Approval',90,'bluewavecafes.in','Not Working',true,200000,'owner@bluewavecafes.in','+91 98450 66778','bluewave.cafes','Indiranagar, Bengaluru, Karnataka','not active','[DEMO] Verbal yes on ₹2L for 3-location site + online ordering. Drafting agreement.','Call Successful',null,null,(select id from profiles order by created_at limit 1), now() - interval '14 days', now() - interval '1 day'),
('de300000-0000-4000-8000-000000000007','Nova Health Diagnostics','Closed & Onboarding',95,'novahealthlabs.in','Good',true,250000,'admin@novahealthlabs.in','+91 98200 77889','novahealth.labs','Bandra East, Mumbai, Maharashtra','active','[DEMO] Signed + paid. Growth retainer. Main contact prefers WhatsApp.','Call Successful','Build in Progress','growth',(select id from profiles order by created_at limit 1), now() - interval '45 days', now() - interval '2 days'),
('de300000-0000-4000-8000-000000000008','Pixel & Thread Boutique','Initial Payment Received',88,'pixelandthread.in','Coming Soon / Under Construction',false,80000,'hello@pixelandthread.in','+91 90040 33445','pixelandthread','Kala Ghoda, Mumbai, Maharashtra','active','[DEMO] 50% advance received. Maintenance tier after launch.','Call Successful','Onboarding','maintenance',(select id from profiles order by created_at limit 1), now() - interval '8 days', now() - interval '1 day'),
('de300000-0000-4000-8000-000000000009','Apex Realty Group','Lost Opportunity',40,'apexrealty.in','Decent',true,175000,'sales@apexrealty.in','+91 98333 99001',null,'Viman Nagar, Pune, Maharashtra','old','[DEMO] Went with their nephew''s agency. Revisit in 6 months.','Call Failed',null,null,(select id from profiles order by created_at limit 1), now() - interval '30 days', now() - interval '18 days'),
('de300000-0000-4000-8000-000000000010','Sunrise Academy','Future Opportunity',65,'sunriseacademy.edu.in','Outdated',true,110000,'office@sunriseacademy.edu.in','+91 94480 12123',null,'Jayanagar, Bengaluru, Karnataka','not active','[DEMO] Budget frozen till new academic year (April). Warm — principal loved the audit.','DM Reply',null,null,(select id from profiles order by created_at limit 1), now() - interval '20 days', now() - interval '9 days'),
-- Delivery in progress, BELOW the gate. Together with Nova Health (Build in Progress) and
-- Pixel & Thread (Onboarding) above, this gives three pre-gate stages — the Convert to Retainer
-- action must be hidden on all three, and Mango Tree is the near-miss one stage short of it.
('de300000-0000-4000-8000-000000000011','Mango Tree Pediatrics','Closed & Onboarding',92,'mangotreepeds.in','Good',true,140000,'front@mangotreepeds.in','+91 98860 45511','mangotree.peds','Alwarpet, Chennai, Tamil Nadu','active','[DEMO] Pre-gate at Final QA — Convert to Retainer must NOT be offered here.','Call Successful','Final QA',null,(select id from profiles order by created_at limit 1), now() - interval '52 days', now() - interval '3 days'),
-- Exactly AT the gate with no retainer row: the one company where the Convert action should appear.
('de300000-0000-4000-8000-000000000012','Harbour Line Logistics','Closed & Onboarding',90,'harbourlinelogistics.in','Good',true,185000,'ops@harbourlinelogistics.in','+91 99870 21140',null,'Fort Kochi, Kerala','active','[DEMO] Handover done, no retainer yet — this is the Convert to Retainer test case.','Call Successful','Live / Handover',null,(select id from profiles order by created_at limit 1), now() - interval '70 days', now() - interval '4 days'),
-- The four retainer states below. All sit at 'Live / Handover' because conversion deliberately
-- does NOT advance project_stage — see the PR 2 ruling — so this is the real post-conversion shape.
('de300000-0000-4000-8000-000000000013','Silverleaf Legal','Closed & Onboarding',93,'silverleaflegal.in','Good',true,220000,'clerk@silverleaflegal.in','+91 98330 71220',null,'Ballygunge, Kolkata, West Bengal','active','[DEMO] Retainer signed, first invoice not raised yet — tests Record First Invoice.','Call Successful','Live / Handover',null,(select id from profiles order by created_at limit 1), now() - interval '95 days', now() - interval '12 days'),
('de300000-0000-4000-8000-000000000014','Copperpot Kitchens','Closed & Onboarding',89,'copperpotkitchens.in','Good',true,160000,'hello@copperpotkitchens.in','+91 90350 88214','copperpot.kitchens','Aundh, Pune, Maharashtra','very active','[DEMO] Active Maintenance retainer at list price.','Call Successful','Live / Handover',null,(select id from profiles order by created_at limit 1), now() - interval '150 days', now() - interval '6 days'),
('de300000-0000-4000-8000-000000000015','Vertex Physiotherapy','Closed & Onboarding',96,'vertexphysio.in','Good',true,300000,'reception@vertexphysio.in','+91 97410 30092','vertex.physio','Gachibowli, Hyderabad, Telangana','very active','[DEMO] Active Full-Service retainer at a negotiated ₹14,000 — deliberately off the tier default.','Call Successful','Live / Handover',null,(select id from profiles order by created_at limit 1), now() - interval '110 days', now() - interval '2 days'),
('de300000-0000-4000-8000-000000000016','Lotus Bloom Spa','Closed & Onboarding',84,'lotusbloomspa.in','Decent',true,95000,'book@lotusbloomspa.in','+91 93400 66125','lotusbloom.spa','Vasant Kunj, New Delhi','active','[DEMO] Growth retainer paused while they rebrand — tests Pause/Resume.','Call Successful','Live / Handover',null,(select id from profiles order by created_at limit 1), now() - interval '230 days', now() - interval '30 days'),
('de300000-0000-4000-8000-000000000017','Driftwood Surf Co.','Closed & Onboarding',70,'driftwoodsurf.in','Decent',false,75000,'shop@driftwoodsurf.in','+91 96320 14477','driftwood.surf','Varkala, Kerala','old','[DEMO] Churned retainer. Still at the gate, so Convert should be offered again — re-signing must create a NEW row, not revive this one.','Call Successful','Live / Handover',null,(select id from profiles order by created_at limit 1), now() - interval '400 days', now() - interval '25 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------- contacts
insert into contacts (id, company_id, name, title, email, phone, instagram, is_primary) values
('de300000-0000-4000-8000-000000000101','de300000-0000-4000-8000-000000000001','Dr. Anil Sharma','Owner','anil@sharmadental.in','+91 98200 11223','dr.anilsharma',true),
('de300000-0000-4000-8000-000000000102','de300000-0000-4000-8000-000000000002','Meera Kulkarni','Founder','meera@greenleaforganics.in','+91 98111 40567','meera.kulkarni',true),
('de300000-0000-4000-8000-000000000103','de300000-0000-4000-8000-000000000003','Vikram Rathore','Owner','vikram@irontemplegym.com','+91 99999 88776','vikram.lifts',true),
('de300000-0000-4000-8000-000000000104','de300000-0000-4000-8000-000000000004','Sonia D''Souza','Principal Designer','sonia@coastalinteriors.co.in','+91 98500 22334','sonia.designs',true),
('de300000-0000-4000-8000-000000000105','de300000-0000-4000-8000-000000000005','Dr. Kavita Joshi','Director','kavita@zenithayurveda.in','+91 94140 55667',null,true),
('de300000-0000-4000-8000-000000000106','de300000-0000-4000-8000-000000000006','Arjun Nair','Founder & CEO','arjun@bluewavecafes.in','+91 98450 66778','arjun.brews',true),
('de300000-0000-4000-8000-000000000107','de300000-0000-4000-8000-000000000007','Rohit Mehta','Operations Head','rohit@novahealthlabs.in','+91 98200 77889',null,true),
('de300000-0000-4000-8000-000000000108','de300000-0000-4000-8000-000000000008','Ananya Iyer','Founder','ananya@pixelandthread.in','+91 90040 33445','ananya.threads',true),
('de300000-0000-4000-8000-000000000109','de300000-0000-4000-8000-000000000011','Dr. Priya Raman','Managing Partner','priya@mangotreepeds.in','+91 98860 45511','dr.priyaraman',true),
('de300000-0000-4000-8000-000000000110','de300000-0000-4000-8000-000000000012','Thomas Varghese','Operations Director','thomas@harbourlinelogistics.in','+91 99870 21140',null,true),
('de300000-0000-4000-8000-000000000111','de300000-0000-4000-8000-000000000013','Ritika Sen','Senior Partner','ritika@silverleaflegal.in','+91 98330 71220',null,true),
('de300000-0000-4000-8000-000000000112','de300000-0000-4000-8000-000000000014','Farhan Qureshi','Co-founder','farhan@copperpotkitchens.in','+91 90350 88214','farhan.cooks',true),
('de300000-0000-4000-8000-000000000113','de300000-0000-4000-8000-000000000015','Dr. Neha Bhatt','Clinical Director','neha@vertexphysio.in','+91 97410 30092','dr.nehabhatt',true),
('de300000-0000-4000-8000-000000000114','de300000-0000-4000-8000-000000000016','Kavya Menon','Owner','kavya@lotusbloomspa.in','+91 93400 66125','kavya.lotusbloom',true),
('de300000-0000-4000-8000-000000000115','de300000-0000-4000-8000-000000000017','Sam Fernandes','Founder','sam@driftwoodsurf.in','+91 96320 14477','sam.driftwood',true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- activities (timeline)
insert into activities (id, company_id, user_id, type, title, body, occurred_at) values
('de300000-0000-4000-8000-000000000201','de300000-0000-4000-8000-000000000001',(select id from profiles order by created_at limit 1),'system','Prospect added',null, now() - interval '2 days'),
('de300000-0000-4000-8000-000000000202','de300000-0000-4000-8000-000000000002',(select id from profiles order by created_at limit 1),'instagram','Sent intro DM','Complimented their new product line, pitched a homepage refresh.', now() - interval '21 days'),
('de300000-0000-4000-8000-000000000203','de300000-0000-4000-8000-000000000003',(select id from profiles order by created_at limit 1),'call','Cold call — connected','Spoke to Vikram directly. Frustrated with current site speed. Wants a call next week.', now() - interval '3 days'),
('de300000-0000-4000-8000-000000000204','de300000-0000-4000-8000-000000000003',(select id from profiles order by created_at limit 1),'note','Competitor research','Their rival CrossFit box just launched a slick new site — good urgency angle.', now() - interval '1 day'),
('de300000-0000-4000-8000-000000000205','de300000-0000-4000-8000-000000000004',(select id from profiles order by created_at limit 1),'instagram','DM reply received','Sonia replied, interested. Moving to discovery call.', now() - interval '4 days'),
('de300000-0000-4000-8000-000000000206','de300000-0000-4000-8000-000000000005',(select id from profiles order by created_at limit 1),'email','Proposal sent','₹1.2L — 8-page site, GBP optimization, 15 keywords. Valid 14 days.', now() - interval '3 days'),
('de300000-0000-4000-8000-000000000207','de300000-0000-4000-8000-000000000006',(select id from profiles order by created_at limit 1),'call','Verbal approval on call','Arjun agreed to ₹2L scope. Send agreement this week.', now() - interval '1 day'),
('de300000-0000-4000-8000-000000000208','de300000-0000-4000-8000-000000000007',(select id from profiles order by created_at limit 1),'meeting','Kickoff meeting','Walked through sitemap and brand assets. Rohit sharing lab photos by Friday.', now() - interval '40 days'),
('de300000-0000-4000-8000-000000000209','de300000-0000-4000-8000-000000000007',(select id from profiles order by created_at limit 1),'email','Monthly report sent','GA4 + GBP report for last month. Calls from GBP up 22%.', now() - interval '2 days'),
('de300000-0000-4000-8000-000000000210','de300000-0000-4000-8000-000000000008',(select id from profiles order by created_at limit 1),'email','Advance invoice paid','50% received. Onboarding form sent.', now() - interval '2 days'),
('de300000-0000-4000-8000-000000000211','de300000-0000-4000-8000-000000000009',(select id from profiles order by created_at limit 1),'call','Closed lost','Went with a relative''s agency. Parted on good terms — check back in 6 months.', now() - interval '18 days'),
('de300000-0000-4000-8000-000000000212','de300000-0000-4000-8000-000000000010',(select id from profiles order by created_at limit 1),'linkedin','Connected with principal','Shared the free mini-audit. Very positive, but budget locked till April.', now() - interval '9 days'),
('de300000-0000-4000-8000-000000000213','de300000-0000-4000-8000-000000000011',(select id from profiles order by created_at limit 1),'note','Final QA checklist started','Cross-browser pass done. Forms and analytics still to verify before handover.', now() - interval '3 days'),
('de300000-0000-4000-8000-000000000214','de300000-0000-4000-8000-000000000012',(select id from profiles order by created_at limit 1),'meeting','Handover walkthrough','Site live, admin training done, credentials transferred. Retainer discussed but not signed.', now() - interval '4 days'),
('de300000-0000-4000-8000-000000000215','de300000-0000-4000-8000-000000000013',(select id from profiles order by created_at limit 1),'system','Retainer agreement signed — Growth at ₹6,500/mo (awaiting first invoice)',null, now() - interval '12 days'),
('de300000-0000-4000-8000-000000000216','de300000-0000-4000-8000-000000000014',(select id from profiles order by created_at limit 1),'system','Retainer started — Maintenance at ₹2,500/mo',null, now() - interval '90 days'),
('de300000-0000-4000-8000-000000000217','de300000-0000-4000-8000-000000000015',(select id from profiles order by created_at limit 1),'system','Retainer started — Full-Service at ₹14,000/mo',null, now() - interval '60 days'),
('de300000-0000-4000-8000-000000000218','de300000-0000-4000-8000-000000000016',(select id from profiles order by created_at limit 1),'system','Retainer paused',null, now() - interval '30 days'),
('de300000-0000-4000-8000-000000000219','de300000-0000-4000-8000-000000000017',(select id from profiles order by created_at limit 1),'call','Cancellation call','Shop going seasonal — pausing all marketing spend. Left the door open for next season.', now() - interval '26 days'),
('de300000-0000-4000-8000-000000000220','de300000-0000-4000-8000-000000000017',(select id from profiles order by created_at limit 1),'system','Retainer churned',null, now() - interval '25 days')
on conflict (id) do nothing;

-- ---------------------------------------------------------------- tasks (Follow-ups view)
insert into tasks (id, company_id, assigned_to, title, due_at, completed) values
('de300000-0000-4000-8000-000000000301','de300000-0000-4000-8000-000000000005',(select id from profiles order by created_at limit 1),'Follow up on Zenith proposal', now() - interval '1 day', false),
('de300000-0000-4000-8000-000000000302','de300000-0000-4000-8000-000000000006',(select id from profiles order by created_at limit 1),'Send Bluewave agreement + invoice', now(), false),
('de300000-0000-4000-8000-000000000303','de300000-0000-4000-8000-000000000003',(select id from profiles order by created_at limit 1),'Prep discovery deck for Iron Temple', now() + interval '2 days', false),
('de300000-0000-4000-8000-000000000304','de300000-0000-4000-8000-000000000002',(select id from profiles order by created_at limit 1),'Second DM touch — GreenLeaf', now() + interval '1 day', false),
('de300000-0000-4000-8000-000000000305','de300000-0000-4000-8000-000000000001',(select id from profiles order by created_at limit 1),'Find Sharma Dental owner''s direct number', null, false),
('de300000-0000-4000-8000-000000000306','de300000-0000-4000-8000-000000000007',(select id from profiles order by created_at limit 1),'Send Nova Health kickoff summary', now() - interval '38 days', true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- meetings (no google ids → sync-safe)
insert into meetings (id, company_id, created_by, title, meeting_type, starts_at, ends_at, location, status) values
('de300000-0000-4000-8000-000000000401','de300000-0000-4000-8000-000000000004',(select id from profiles order by created_at limit 1),'Discovery Call — Coastal Interiors','Discovery Call', now() + interval '1 day', now() + interval '1 day' + interval '30 minutes','Google Meet','scheduled'),
('de300000-0000-4000-8000-000000000402','de300000-0000-4000-8000-000000000006',(select id from profiles order by created_at limit 1),'Agreement walkthrough — Bluewave','Close Call', now() + interval '3 days', now() + interval '3 days' + interval '45 minutes','Google Meet','scheduled'),
('de300000-0000-4000-8000-000000000403','de300000-0000-4000-8000-000000000007',(select id from profiles order by created_at limit 1),'Monthly review — Nova Health','Retainer Review', now() + interval '6 days', now() + interval '6 days' + interval '30 minutes','Google Meet','scheduled'),
('de300000-0000-4000-8000-000000000404','de300000-0000-4000-8000-000000000007',(select id from profiles order by created_at limit 1),'Kickoff — Nova Health','Onboarding', now() - interval '40 days', now() - interval '40 days' + interval '1 hour','Google Meet','completed')
on conflict (id) do nothing;

-- ---------------------------------------------------------------- milestones (Projects board/table)
-- Nova Health: growth retainer in full swing — every status represented.
insert into milestones (id, company_id, title, category, cadence, target_date, status, priority, progress) values
('de300000-0000-4000-8000-000000000501','de300000-0000-4000-8000-000000000007','Monthly report (GA4 + GBP)','goal','monthly', now() + interval '5 days','in_progress','Medium',60),
('de300000-0000-4000-8000-000000000502','de300000-0000-4000-8000-000000000007','GBP weekly post','goal','weekly', now() + interval '2 days','in_progress','Low',40),
('de300000-0000-4000-8000-000000000503','de300000-0000-4000-8000-000000000007','Keyword tracking (5 keywords)','goal','monthly', now() + interval '12 days','pending','Medium',0),
('de300000-0000-4000-8000-000000000504','de300000-0000-4000-8000-000000000007','Blog: "Full-body checkup guide"','deliverable','once', now() - interval '3 days','in_progress','High',75),
('de300000-0000-4000-8000-000000000505','de300000-0000-4000-8000-000000000007','Homepage speed optimization','deliverable','once', now() - interval '20 days','done','High',100),
('de300000-0000-4000-8000-000000000506','de300000-0000-4000-8000-000000000007','Diwali landing page','deliverable','once', now() - interval '10 days','missed','Medium',20),
-- Pixel & Thread: onboarding checklist just starting.
('de300000-0000-4000-8000-000000000507','de300000-0000-4000-8000-000000000008','Collect brand assets + product photos','deliverable','once', now() + interval '3 days','in_progress','High',30),
('de300000-0000-4000-8000-000000000508','de300000-0000-4000-8000-000000000008','Sitemap + wireframe approval','deliverable','once', now() + interval '7 days','pending','High',0),
('de300000-0000-4000-8000-000000000509','de300000-0000-4000-8000-000000000008','Domain + hosting handover','deliverable','once', now() + interval '10 days','pending','Low',0)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- retainers
-- Every row states its FINAL status and supplies its own dates, so nothing here depends on the
-- activation trigger firing. The trigger only acts on a row that is 'pending' AND has a first
-- invoice date, which no row below is — the pending row has no invoice date, and the rest are
-- already past 'pending'. Seed data stays deterministic; the trigger gets exercised for real when
-- you click Record First Invoice on Silverleaf.
--
-- Note the conflict clause: bare `on conflict do nothing`, not `on conflict (id)` like the blocks
-- above. retainers carries a partial unique index allowing one non-churned row per company, so if
-- you have already converted one of these companies by hand, an id-only clause would let the
-- insert through to a unique-violation error and abort the whole script. The bare form absorbs
-- both collisions.
--
-- monthly_amount is per engagement, never derived from tier: Vertex sits at a negotiated ₹14,000
-- rather than the ₹12,500 Full-Service default, which is what makes the tier-change prompt in the
-- Retainer view worth testing — it should offer the default and keep ₹14,000 if you cancel.
insert into retainers (id, company_id, tier, monthly_amount, status, agreement_signed_on, first_invoice_issued_on, started_at, billing_anchor, next_invoice_due, churned_at) values
-- PENDING — signed, never invoiced. Record First Invoice should flip this to active and stamp
-- started_at, billing_anchor and next_invoice_due (anchor + 1 month) all at once.
('de300000-0000-4000-8000-000000000601','de300000-0000-4000-8000-000000000013','Growth',6500,'pending', current_date - 12, null, null, null, null, null),
-- ACTIVE x2, different tiers. next_invoice_due is deliberately split: one upcoming, one already
-- past, so an overdue invoice date is visible in the list.
('de300000-0000-4000-8000-000000000602','de300000-0000-4000-8000-000000000014','Maintenance',2500,'active', current_date - 120, current_date - 90, current_date - 90, current_date - 90, current_date + 5, null),
('de300000-0000-4000-8000-000000000603','de300000-0000-4000-8000-000000000015','Full-Service',14000,'active', current_date - 75, current_date - 60, current_date - 60, current_date - 60, current_date - 3, null),
-- PAUSED — was active, so it keeps its billing dates. Resume must return it to 'active' (it has a
-- first invoice date), not to 'pending'.
('de300000-0000-4000-8000-000000000604','de300000-0000-4000-8000-000000000016','Growth',6500,'paused', current_date - 200, current_date - 180, current_date - 180, current_date - 180, current_date - 20, null),
-- CHURNED — excluded from current_retainers, so it must not appear in the Active/Paused/MRR tiles
-- and must still be listed under the Churned filter.
('de300000-0000-4000-8000-000000000605','de300000-0000-4000-8000-000000000017','Maintenance',2500,'churned', current_date - 365, current_date - 335, current_date - 335, current_date - 335, current_date - 30, current_date - 25)
on conflict do nothing;

-- ================================================================ CLEANUP
-- To remove ALL demo data later, run just the block below (cascades handle children):
-- delete from companies where id::text like 'de300000%';
-- delete from tasks where id::text like 'de300000%';
-- delete from meetings where id::text like 'de300000%';
-- retainers cascade when their company is deleted, so the first line already removes them — this
-- is here only for a partial cleanup where the companies are being kept.
-- delete from retainers where id::text like 'de300000%';
