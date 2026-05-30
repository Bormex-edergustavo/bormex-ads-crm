grant usage on schema public to service_role;

grant all on table public.bormex_conversations to service_role;
grant all on table public.bormex_messages to service_role;
grant all on table public.bormex_sales to service_role;
grant all on table public.bormex_leads to service_role;
grant all on table public.bormex_spend to service_role;
grant all on table public.bormex_ads to service_role;
grant all on table public.bormex_settings to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bormex_conversations'
      and policyname = 'bormex_conversations_service_role_all'
  ) then
    create policy "bormex_conversations_service_role_all"
      on public.bormex_conversations
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bormex_messages'
      and policyname = 'bormex_messages_service_role_all'
  ) then
    create policy "bormex_messages_service_role_all"
      on public.bormex_messages
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bormex_sales'
      and policyname = 'bormex_sales_service_role_all'
  ) then
    create policy "bormex_sales_service_role_all"
      on public.bormex_sales
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bormex_leads'
      and policyname = 'bormex_leads_service_role_all'
  ) then
    create policy "bormex_leads_service_role_all"
      on public.bormex_leads
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bormex_spend'
      and policyname = 'bormex_spend_service_role_all'
  ) then
    create policy "bormex_spend_service_role_all"
      on public.bormex_spend
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bormex_ads'
      and policyname = 'bormex_ads_service_role_all'
  ) then
    create policy "bormex_ads_service_role_all"
      on public.bormex_ads
      for all
      to service_role
      using (true)
      with check (true);
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'bormex_settings'
      and policyname = 'bormex_settings_service_role_all'
  ) then
    create policy "bormex_settings_service_role_all"
      on public.bormex_settings
      for all
      to service_role
      using (true)
      with check (true);
  end if;
end $$;

create index if not exists bormex_leads_phone_idx
  on public.bormex_leads ((data->>'phone'));

create index if not exists bormex_sales_phone_idx
  on public.bormex_sales ((data->>'phone'));

create index if not exists bormex_spend_ad_date_idx
  on public.bormex_spend ((data->>'adId'), (data->>'date'));
