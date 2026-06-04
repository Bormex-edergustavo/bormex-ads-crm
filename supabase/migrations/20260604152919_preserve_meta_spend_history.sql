create or replace function public.bormex_preserve_meta_spend_history()
returns trigger
language plpgsql
as $$
begin
  if old.data->>'source' = 'meta' then
    return null;
  end if;

  return old;
end;
$$;

drop trigger if exists bormex_preserve_meta_spend_history on public.bormex_spend;

create trigger bormex_preserve_meta_spend_history
before delete on public.bormex_spend
for each row
execute function public.bormex_preserve_meta_spend_history();
