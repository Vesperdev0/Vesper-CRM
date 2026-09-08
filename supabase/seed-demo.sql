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

-- ---------------------------------------------------------------- schema catch-up
-- Your live DB was created before the later additions in schema.sql, so bring it up to
-- date first. Every statement is guarded (if not exists / if exists) — safe to re-run.
alter table companies add column if not exists outreach_status text
  check (outreach_status in ('Not Contacted','DM Reply','DM No Reply','Call Successful','Call Failed'))
  default 'Not Contacted';
alter table companies add column if not exists project_stage text
  check (project_stage in ('Onboarding','Active Project','Waiting on Client','Ready for Launch','Won Opportunity / Active Retainer'));
alter table companies add column if not exists retainer_tier text
  check (retainer_tier in ('maintenance','growth','full-service'));
alter table milestones add column if not exists priority text not null default 'Medium' check (priority in ('Low','Medium','High'));
alter table milestones add column if not exists progress smallint not null default 0 check (progress >= 0 and progress <= 100);
alter table milestones drop constraint if exists milestones_status_check;
alter table milestones add constraint milestones_status_check check (status in ('pending','in_progress','done','missed'));

-- ---------------------------------------------------------------- companies
insert into companies (id, name, lead_status, lead_score, website, site_condition, gbp, deal_value, company_email, company_phone, instagram, address, client_type, remarks, outreach_status, project_stage, retainer_tier, owner_id, created_at, updated_at) values
('de300000-0000-4000-8000-000000000001','Sharma Dental Clinic','Prospect',35,null,'No Site',false,45000,'contact@sharmadental.in','+91 98200 11223','sharmadentalmumbai','Andheri West, Mumbai, Maharashtra','not active','[DEMO] Found via Google Maps — no website at all, strong reviews (4.7★).','Not Contacted',null,null,(select id from profiles order by created_at limit 1), now() - interval '2 days', now() - interval '2 days'),
('de300000-0000-4000-8000-000000000002','GreenLeaf Organics','Prospect',48,'greenleaforganics.in','Outdated',true,60000,'hello@greenleaforganics.in','+91 98111 40567','greenleaf.organics','Koregaon Park, Pune, Maharashtra','not active','[DEMO] DMed on Instagram, no reply yet. Site is from 2018.','DM No Reply',null,null,(select id from profiles order by created_at limit 1), now() - interval '25 days', now() - interval '21 days'),
('de300000-0000-4000-8000-000000000003','Iron Temple Fitness','Qualified Lead',72,'irontemplegym.com','Not Good',true,90000,'info@irontemplegym.com','+91 99999 88776','irontemple.delhi','Hauz Khas, New Delhi','not active','[DEMO] Cold call went well — owner wants a new site before their January membership push.','Call Successful',null,null,(select id from profiles order by created_at limit 1), now() - interval '6 days', now() - interval '1 day'),
('de300000-0000-4000-8000-000000000004','Coastal Interiors','Discovery Call',80,'coastalinteriors.co.in','Decent',false,150000,'studio@coastalinteriors.co.in','+91 98500 22334','coastal.interiors','Panaji, Goa','not active','[DEMO] Discovery call booked. Wants portfolio-heavy redesign + GBP setup.','DM Reply',null,null,(select id from profiles order by created_at limit 1), now() - interval '5 days', now() - interval '12 hours'),
('de300000-0000-4000-8000-000000000005','Zenith Ayurveda','Proposal Agreement Sent',85,'zenithayurveda.in','Outdated',true,120000,'care@zenithayurveda.in','+91 94140 55667','zenith.ayurveda','Malviya Nagar, Jaipur, Rajasthan','not active','[DEMO] Proposal sent 3 days ago — follow up if no response by Friday.','Call Successful',null,null,(select id from profiles order by created_at limit 1), now() - interval '10 days', now() - interval '3 days'),
('de300000-0000-4000-8000-000000000006','Bluewave Cafés','Verbal Approval',90,'bluewavecafes.in','Not Working',true,200000,'owner@bluewavecafes.in','+91 98450 66778','bluewave.cafes','Indiranagar, Bengaluru, Karnataka','not active','[DEMO] Verbal yes on ₹2L for 3-location site + online ordering. Drafting agreement.','Call Successful',null,null,(select id from profiles order by created_at limit 1), now() - interval '14 days', now() - interval '1 day'),
('de300000-0000-4000-8000-000000000007','Nova Health Diagnostics','Closed & Onboarding',95,'novahealthlabs.in','Good',true,250000,'admin@novahealthlabs.in','+91 98200 77889','novahealth.labs','Bandra East, Mumbai, Maharashtra','active','[DEMO] Signed + paid. Growth retainer. Main contact prefers WhatsApp.','Call Successful','Active Project','growth',(select id from profiles order by created_at limit 1), now() - interval '45 days', now() - interval '2 days'),
('de300000-0000-4000-8000-000000000008','Pixel & Thread Boutique','Initial Payment Received',88,'pixelandthread.in','Coming Soon / Under Construction',false,80000,'hello@pixelandthread.in','+91 90040 33445','pixelandthread','Kala Ghoda, Mumbai, Maharashtra','active','[DEMO] 50% advance received. Maintenance tier after launch.','Call Successful','Onboarding','maintenance',(select id from profiles order by created_at limit 1), now() - interval '8 days', now() - interval '1 day'),
('de300000-0000-4000-8000-000000000009','Apex Realty Group','Lost Opportunity',40,'apexrealty.in','Decent',true,175000,'sales@apexrealty.in','+91 98333 99001',null,'Viman Nagar, Pune, Maharashtra','old','[DEMO] Went with their nephew''s agency. Revisit in 6 months.','Call Failed',null,null,(select id from profiles order by created_at limit 1), now() - interval '30 days', now() - interval '18 days'),
('de300000-0000-4000-8000-000000000010','Sunrise Academy','Future Opportunity',65,'sunriseacademy.edu.in','Outdated',true,110000,'office@sunriseacademy.edu.in','+91 94480 12123',null,'Jayanagar, Bengaluru, Karnataka','not active','[DEMO] Budget frozen till new academic year (April). Warm — principal loved the audit.','DM Reply',null,null,(select id from profiles order by created_at limit 1), now() - interval '20 days', now() - interval '9 days')
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
('de300000-0000-4000-8000-000000000108','de300000-0000-4000-8000-000000000008','Ananya Iyer','Founder','ananya@pixelandthread.in','+91 90040 33445','ananya.threads',true)
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
('de300000-0000-4000-8000-000000000212','de300000-0000-4000-8000-000000000010',(select id from profiles order by created_at limit 1),'linkedin','Connected with principal','Shared the free mini-audit. Very positive, but budget locked till April.', now() - interval '9 days')
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

-- ================================================================ CLEANUP
-- To remove ALL demo data later, run just the block below (cascades handle children):
-- delete from companies where id::text like 'de300000%';
-- delete from tasks where id::text like 'de300000%';
-- delete from meetings where id::text like 'de300000%';
