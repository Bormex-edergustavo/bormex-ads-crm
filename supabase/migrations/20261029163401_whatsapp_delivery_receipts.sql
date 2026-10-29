-- Keep provider receipts and message content together even when Meta calls back
-- before the send request finishes, or sends duplicate/out-of-order events.
create or replace function public.bormex_merge_whatsapp_delivery(previous jsonb, incoming jsonb)
returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare
  merged jsonb := coalesce(previous, '{}'::jsonb) || coalesce(incoming, '{}'::jsonb);
  field text;
  stamp text;
  chosen text;
begin
  foreach field in array array['sentAt', 'deliveredAt', 'readAt', 'failedAt'] loop
    stamp := greatest(previous->>field, incoming->>field);
    if stamp is not null then merged := jsonb_set(merged, array[field], to_jsonb(stamp)); end if;
  end loop;
  if merged->>'readAt' is not null or previous->>'status' = 'read' or incoming->>'status' = 'read' then
    chosen := 'read';
  elsif merged->>'deliveredAt' is not null or previous->>'status' = 'delivered' or incoming->>'status' = 'delivered' then
    chosen := 'delivered';
  elsif merged->>'failedAt' is not null and (merged->>'sentAt' is null or merged->>'failedAt' >= merged->>'sentAt') then
    chosen := 'failed';
  else
    chosen := coalesce(incoming->>'status', previous->>'status', 'sent');
  end if;
  merged := jsonb_set(merged, '{status}', to_jsonb(chosen));
  if chosen <> 'failed' then merged := merged - 'deliveryError';
  elsif previous->>'failedAt' is not null and (incoming->>'failedAt' is null or previous->>'failedAt' > incoming->>'failedAt') then
    merged := jsonb_set(merged, '{deliveryError}', coalesce(previous->'deliveryError', '{}'::jsonb));
  end if;
  -- A phone echo can omit the caption or private attachment references.
  if incoming->>'sourceField' = 'smb_message_echoes' and previous is not null then
    if coalesce(incoming->>'text', '') in ('', '[image]', '[video]', '[audio]', '[document]', '[sticker]') and previous ? 'text' then merged := jsonb_set(merged, '{text}', previous->'text'); end if;
    if previous->'attachments' is not null and previous->'attachments' <> '[]'::jsonb then merged := jsonb_set(merged, '{attachments}', previous->'attachments'); end if;
  end if;
  return merged;
end;
$$;

create or replace function public.bormex_store_whatsapp_messages(p_messages jsonb, p_receipts boolean default false)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  item jsonb;
  message_id text;
  existing jsonb;
  receipt jsonb;
  saved jsonb;
  result jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) > 1000 then raise exception 'Invalid WhatsApp batch'; end if;
  -- All writers acquire locks in the same order. No global settings lock.
  for item in select value from jsonb_array_elements(p_messages) order by value->>'id' loop
    message_id := item->>'id';
    if coalesce(message_id, '') = '' then raise exception 'Missing message ID'; end if;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bormex-wa:' || message_id, 0));
    select data into existing from public.bormex_messages where id = message_id;
    select value into receipt from public.bormex_settings where key = 'whatsappReceipt:' || message_id;
    if p_receipts then
      if item->>'status' not in ('sent', 'delivered', 'read', 'failed') then raise exception 'Invalid receipt'; end if;
      -- Whitelist fields: a receipt cannot overwrite the message, chat or media.
      item := jsonb_strip_nulls(jsonb_build_object('id', message_id, 'status', item->>'status', 'sentAt', item->>'sentAt', 'deliveredAt', item->>'deliveredAt', 'readAt', item->>'readAt', 'failedAt', item->>'failedAt', 'deliveryError', item->'deliveryError'));
      receipt := public.bormex_merge_whatsapp_delivery(receipt, item);
      insert into public.bormex_settings(key, value) values ('whatsappReceipt:' || message_id, receipt)
        on conflict (key) do update set value = excluded.value;
      -- Unknown receipts wait for the real message; never create empty chats.
      if existing->>'channel' = 'whatsapp' and existing->>'direction' = 'outbound' then
        saved := public.bormex_merge_whatsapp_delivery(existing, receipt);
        update public.bormex_messages set data = saved where id = message_id;
        result := result || jsonb_build_array(saved);
      end if;
    else
      if item->>'channel' <> 'whatsapp' then raise exception 'Invalid channel'; end if;
      saved := public.bormex_merge_whatsapp_delivery(existing, item);
      if receipt is not null and saved->>'direction' = 'outbound' then saved := public.bormex_merge_whatsapp_delivery(saved, receipt); end if;
      insert into public.bormex_messages(id, data) values (message_id, saved)
        on conflict (id) do update set data = excluded.data;
      result := result || jsonb_build_array(saved);
    end if;
  end loop;
  return result;
end;
$$;

revoke all on function public.bormex_merge_whatsapp_delivery(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.bormex_store_whatsapp_messages(jsonb, boolean) from public, anon, authenticated;
grant execute on function public.bormex_merge_whatsapp_delivery(jsonb, jsonb) to service_role;
grant execute on function public.bormex_store_whatsapp_messages(jsonb, boolean) to service_role;
