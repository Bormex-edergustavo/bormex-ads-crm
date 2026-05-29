create table if not exists public.bormex_conversations (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bormex_messages (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bormex_sales (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bormex_leads (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bormex_spend (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bormex_ads (
  id text primary key,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bormex_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create or replace function public.bormex_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists bormex_conversations_touch on public.bormex_conversations;
create trigger bormex_conversations_touch
before update on public.bormex_conversations
for each row execute function public.bormex_touch_updated_at();

drop trigger if exists bormex_messages_touch on public.bormex_messages;
create trigger bormex_messages_touch
before update on public.bormex_messages
for each row execute function public.bormex_touch_updated_at();

drop trigger if exists bormex_sales_touch on public.bormex_sales;
create trigger bormex_sales_touch
before update on public.bormex_sales
for each row execute function public.bormex_touch_updated_at();

drop trigger if exists bormex_leads_touch on public.bormex_leads;
create trigger bormex_leads_touch
before update on public.bormex_leads
for each row execute function public.bormex_touch_updated_at();

drop trigger if exists bormex_spend_touch on public.bormex_spend;
create trigger bormex_spend_touch
before update on public.bormex_spend
for each row execute function public.bormex_touch_updated_at();

drop trigger if exists bormex_ads_touch on public.bormex_ads;
create trigger bormex_ads_touch
before update on public.bormex_ads
for each row execute function public.bormex_touch_updated_at();

alter table public.bormex_conversations enable row level security;
alter table public.bormex_messages enable row level security;
alter table public.bormex_sales enable row level security;
alter table public.bormex_leads enable row level security;
alter table public.bormex_spend enable row level security;
alter table public.bormex_ads enable row level security;
alter table public.bormex_settings enable row level security;

insert into public.bormex_settings (key, value)
values ('rules', '{"targetCpa":600,"minRoas":2,"minLeads":8}'::jsonb)
on conflict (key) do nothing;
