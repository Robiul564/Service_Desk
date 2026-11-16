-- Passport Desk schema for Supabase Postgres.
-- Run in SQL Editor as project owner. Data rows may only be removed by setting deleted_at.
create extension if not exists pgcrypto;

create sequence if not exists public.worker_id_seq start with 1;
create sequence if not exists public.receipt_id_seq start with 1;

create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  email text not null,
  role text not null default 'viewer' check (role in ('admin','staff','viewer')),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agents (
  id text primary key check (id ~ '^AGT-[0-9]{3,}$'),
  ml_name text,
  ml_phone text,
  bd_name text,
  bd_phone text,
  status text not null default 'Active' check (status in ('Active','Inactive')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  vacancy integer not null default 0 check (vacancy >= 0),
  position text,
  fee numeric(14,2) not null default 700000 check (fee >= 0),
  status text not null default 'Active' check (status in ('Active','Inactive')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists companies_live_name_uq on public.companies (lower(name)) where deleted_at is null;

create table if not exists public.workers (
  id uuid primary key default gen_random_uuid(),
  wid text not null unique default ('WRK-' || lpad(nextval('public.worker_id_seq')::text, 3, '0')),
  name text not null check (length(trim(name)) > 0),
  phone text,
  passport_no text,
  passport_expiry date,
  dob date,
  sex text check (sex is null or sex in ('M','F')),
  nationality text default 'Bangladeshi',
  submission_agency text,
  submission_status text not null default 'In Office (Not Submitted)',
  submission_date date,
  passport_withdrawn_date date,
  passport_withdrawn_by text,
  passport_withdrawn_reason text,
  passport_withdrawn_notes text,
  agent_id text references public.agents(id) on update cascade on delete restrict,
  company text,
  company_id uuid references public.companies(id) on update cascade on delete restrict,
  position text,
  received date,
  passenger_status text not null default 'New',
  passport_status text not null default 'Pending' check (passport_status in ('Pending','Received')),
  photo_status text not null default 'Pending' check (photo_status in ('Pending','Received')),
  bgmt_status text not null default 'Pending' check (bgmt_status in ('Pending','Received')),
  medical_status text not null default 'Pending' check (medical_status in ('Pending','Fit','Failed/Issue','Not Required')),
  medical_expiry date,
  contract_fee numeric(14,2) not null default 700000 check (contract_fee >= 0),
  notes text,
  review boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index if not exists workers_live_passport_uq on public.workers (upper(passport_no)) where deleted_at is null and passport_no is not null;
create index if not exists workers_updated_idx on public.workers(updated_at);
create index if not exists workers_agent_idx on public.workers(agent_id) where deleted_at is null;
create index if not exists workers_company_idx on public.workers(company_id) where deleted_at is null;

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references public.workers(id) on update cascade on delete restrict,
  stage text not null check (stage in ('Advance','Calling Visa','Flight/BMET')),
  amount numeric(14,2) not null check (amount >= 0),
  paid_at date default current_date,
  method text not null default 'Cash',
  receipt_no text unique default ('RCT-' || lpad(nextval('public.receipt_id_seq')::text, 5, '0')),
  collector text,
  notes text,
  overpayment boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists payments_worker_idx on public.payments(worker_id) where deleted_at is null;
create index if not exists payments_updated_idx on public.payments(updated_at);

create table if not exists public.handovers (
  id uuid primary key default gen_random_uuid(),
  paid_at date not null default current_date,
  company text,
  handover_type text not null default 'Other',
  recipient text,
  amount numeric(14,2) not null check (amount >= 0),
  given_by text,
  method text not null default 'Cash',
  reference text,
  status text not null default 'Completed' check (status in ('Pending','Completed')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists handovers_updated_idx on public.handovers(updated_at);

create table if not exists public.expenses (
  id uuid primary key default gen_random_uuid(),
  paid_at date not null default current_date,
  category text not null default 'Other',
  description text not null,
  amount numeric(14,2) not null check (amount >= 0),
  method text not null default 'Cash',
  vendor text,
  company text,
  worker_id uuid references public.workers(id) on update cascade on delete restrict,
  voucher_no text,
  entered_by text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index if not exists expenses_updated_idx on public.expenses(updated_at);

create table if not exists public.history (
  id bigint generated always as identity primary key,
  table_name text not null,
  row_id text not null,
  old_row jsonb not null,
  changed_at timestamptz not null default now(),
  changed_by uuid references auth.users(id) on delete set null
);
create index if not exists history_record_idx on public.history(table_name, row_id, changed_at desc);

create or replace function public.current_role()
returns text language sql stable security definer set search_path = public, auth
as $$
  select role from public.user_profiles where id = auth.uid() and enabled
$$;

create or replace function public.can_access()
returns boolean language sql stable security definer set search_path = public, auth
as $$
  select exists (select 1 from public.user_profiles where id = auth.uid() and enabled)
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public, auth
as $$
  select exists (select 1 from public.user_profiles where id = auth.uid() and enabled and role = 'admin')
$$;

create or replace function public.touch_record()
returns trigger language plpgsql set search_path = public
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then new.created_at := now(); end if;
  return new;
end
$$;

create or replace function public.log_previous_version()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.history(table_name, row_id, old_row, changed_by)
  values (tg_table_name, old.id::text, to_jsonb(old), auth.uid());
  return new;
end
$$;

create or replace function public.prevent_hard_delete()
returns trigger language plpgsql
as $$
begin
  raise exception 'Hard delete is disabled. Set deleted_at to move this record to trash.';
end
$$;

create or replace function public.set_worker_company_reference()
returns trigger language plpgsql set search_path = public
as $$
begin
  if new.company is null or trim(new.company) = '' then
    new.company_id := null;
  else
    select id into new.company_id from public.companies
      where lower(name) = lower(trim(new.company)) and deleted_at is null limit 1;
  end if;
  return new;
end
$$;

create or replace function public.flag_payment_overpayment()
returns trigger language plpgsql set search_path = public
as $$
declare
  contract numeric(14,2);
  already_paid numeric(14,2);
begin
  select contract_fee into contract from public.workers where id = new.worker_id;
  select coalesce(sum(amount), 0) into already_paid from public.payments
    where worker_id = new.worker_id and deleted_at is null and id <> new.id;
  new.overpayment := already_paid + new.amount > coalesce(contract, 0);
  return new;
end
$$;

create or replace function public.create_profile_for_new_auth_user()
returns trigger language plpgsql security definer set search_path = public
as $$
begin
  insert into public.user_profiles(id, email, role, enabled)
  values (new.id, coalesce(new.email, ''), 'viewer', true)
  on conflict (id) do update set email = excluded.email;
  return new;
end
$$;

drop trigger if exists auth_user_profile on auth.users;
create trigger auth_user_profile after insert on auth.users
for each row execute function public.create_profile_for_new_auth_user();

do $$
declare table_name text;
begin
  foreach table_name in array array['agents','companies','workers','payments','handovers','expenses','user_profiles'] loop
    execute format('drop trigger if exists record_touch on public.%I', table_name);
    execute format('create trigger record_touch before insert or update on public.%I for each row execute function public.touch_record()', table_name);
    execute format('drop trigger if exists record_history on public.%I', table_name);
    execute format('create trigger record_history after update on public.%I for each row execute function public.log_previous_version()', table_name);
    execute format('drop trigger if exists no_hard_delete on public.%I', table_name);
    execute format('create trigger no_hard_delete before delete on public.%I for each row execute function public.prevent_hard_delete()', table_name);
    execute format('alter table public.%I enable row level security', table_name);
  end loop;
end
$$;

drop trigger if exists worker_company_reference on public.workers;
create trigger worker_company_reference before insert or update of company on public.workers
for each row execute function public.set_worker_company_reference();
drop trigger if exists payment_overpayment on public.payments;
create trigger payment_overpayment before insert or update of worker_id, amount on public.payments
for each row execute function public.flag_payment_overpayment();

alter table public.history enable row level security;

do $$
declare table_name text;
begin
  foreach table_name in array array['agents','companies','workers','payments','handovers','expenses'] loop
    execute format('drop policy if exists read_enabled on public.%I', table_name);
    execute format('create policy read_enabled on public.%I for select to authenticated using (public.can_access())', table_name);
    execute format('drop policy if exists write_staff on public.%I', table_name);
    execute format('create policy write_staff on public.%I for all to authenticated using (public.current_role() in (''admin'',''staff'')) with check (public.current_role() in (''admin'',''staff''))', table_name);
  end loop;
end
$$;

drop policy if exists profile_read on public.user_profiles;
create policy profile_read on public.user_profiles for select to authenticated
using (id = auth.uid() or public.is_admin());
drop policy if exists profile_admin_write on public.user_profiles;
create policy profile_admin_write on public.user_profiles for update to authenticated
using (public.is_admin()) with check (public.is_admin());
drop policy if exists history_read on public.history;
create policy history_read on public.history for select to authenticated using (public.can_access());

revoke all on public.history from anon, authenticated;
grant select on public.history to authenticated;
grant select, insert, update on public.user_profiles, public.agents, public.companies, public.workers,
  public.payments, public.handovers, public.expenses to authenticated;
revoke delete, truncate on public.user_profiles, public.agents, public.companies, public.workers,
  public.payments, public.handovers, public.expenses, public.history from anon, authenticated;
revoke all on sequence public.worker_id_seq, public.receipt_id_seq from anon, authenticated;
grant usage, select on sequence public.worker_id_seq, public.receipt_id_seq to authenticated;
grant execute on function public.current_role(), public.can_access(), public.is_admin() to authenticated;

-- Create a unique constraint by index for active passports; duplicate/blank passport values remain allowed in trash.
-- Audit rows are append-only and cannot be changed through the client API.

-- Safe migrations for existing databases:
alter table if exists public.workers add column if not exists submission_agency text;
alter table if exists public.workers add column if not exists submission_status text not null default 'In Office (Not Submitted)';
alter table if exists public.workers add column if not exists submission_date date;
alter table if exists public.workers add column if not exists passport_withdrawn_date date;
alter table if exists public.workers add column if not exists passport_withdrawn_by text;
alter table if exists public.workers add column if not exists passport_withdrawn_reason text;
alter table if exists public.workers add column if not exists passport_withdrawn_notes text;
create index if not exists workers_submission_agency_idx on public.workers(submission_agency) where deleted_at is null;
create index if not exists workers_submission_status_idx on public.workers(submission_status) where deleted_at is null;
