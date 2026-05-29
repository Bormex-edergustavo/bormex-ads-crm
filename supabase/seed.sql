insert into public.bormex_settings (key, value)
values ('rules', '{"targetCpa":600,"minRoas":2,"minLeads":8}'::jsonb)
on conflict (key) do nothing;
