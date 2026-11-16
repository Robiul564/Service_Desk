-- PASSPORT DESK — Sample Seed Template (Synthetic data, zero real PII)
-- Run this in your Supabase SQL Editor if you want to preload sample agents and companies.

-- 1. Sample Agent Pairs
insert into public.agents (id, ml_name, ml_phone, bd_name, bd_phone, status) values
  ('AGT-001', 'Kuala Lumpur Partner A', '+60120000001', 'Dhaka Agent A', '+8801700000001', 'Active'),
  ('AGT-002', 'Penang Partner B', '+60120000002', 'Chittagong Agent B', '+8801700000002', 'Active'),
  ('AGT-003', 'Johor Partner C', '+60120000003', 'Sylhet Agent C', '+8801700000003', 'Active')
on conflict (id) do nothing;

-- 2. Sample Employer Companies
insert into public.companies (name, vacancy, fee, position, status) values
  ('Apex Manufacturing Ltd', 50, 700000, 'Factory Worker', 'Active'),
  ('Global Logistics Berhad', 40, 700000, 'Warehouse Assistant', 'Active'),
  ('Crest Engineering Works', 25, 700000, 'General Technician', 'Active')
on conflict (name) do nothing;

-- 3. Sample Workers / Passports
insert into public.workers (
  wid, name, phone, passport_no, passport_expiry, dob, sex, nationality,
  agent_id, company, position, received, passenger_status,
  passport_status, photo_status, bgmt_status, medical_status,
  submission_agency, submission_status, submission_date, contract_fee
) values
  (
    'WRK-001', 'SAMPLE CANDIDATE ALAM', '+8801700000001', 'A00000001', '2034-01-01', '1995-05-10', 'M', 'Bangladeshi',
    'AGT-001', 'Apex Manufacturing Ltd', 'Factory Worker', current_date, 'In Processing',
    'Received', 'Received', 'Pending', 'Fit',
    'Eastern Agency', 'Submitted to Agency', current_date, 700000
  ),
  (
    'WRK-002', 'SAMPLE CANDIDATE HASAN', '+8801700000002', 'A00000002', '2033-05-15', '1998-08-20', 'M', 'Bangladeshi',
    'AGT-001', 'Global Logistics Berhad', 'Warehouse Assistant', current_date, 'New',
    'Received', 'Pending', 'Pending', 'Pending',
    NULL, 'In Office (Not Submitted)', NULL, 700000
  )
on conflict do nothing;
