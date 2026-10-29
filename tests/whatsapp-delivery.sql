-- Integration checks run inside a rollback-only transaction; no Meta sends.
begin;
set local role service_role;
do $$
declare
  fixture_id text := 'crm-receipt-test-' || gen_random_uuid()::text;
  saved jsonb;
  receipt jsonb;
begin
  receipt := jsonb_build_object('id', fixture_id, 'status', 'read', 'readAt', '2026-10-29T16:00:05.000Z');
  perform public.bormex_store_whatsapp_messages(jsonb_build_array(receipt), true);
  if exists(select 1 from public.bormex_messages where id = fixture_id) then raise exception 'Receipt created a blank message'; end if;
  perform public.bormex_store_whatsapp_messages(jsonb_build_array(jsonb_build_object(
    'id', fixture_id, 'channel', 'whatsapp', 'conversationId', 'whatsapp_test_only', 'direction', 'outbound',
    'text', 'original caption', 'status', 'sent', 'attachments', jsonb_build_array(jsonb_build_object('storagePath', 'test-only/video.mp4')))));
  select data into saved from public.bormex_messages where id = fixture_id;
  if saved->>'status' <> 'read' or saved->>'text' <> 'original caption' then raise exception 'Early receipt lost'; end if;
  -- A late sent callback and a phone echo cannot erase a read receipt or media.
  perform public.bormex_store_whatsapp_messages(jsonb_build_array(jsonb_build_object('id', fixture_id, 'status', 'sent', 'sentAt', '2026-10-29T16:00:01.000Z', 'text', 'must not replace')), true);
  perform public.bormex_store_whatsapp_messages(jsonb_build_array(jsonb_build_object('id', fixture_id, 'channel', 'whatsapp', 'direction', 'outbound', 'status', 'sent', 'sourceField', 'smb_message_echoes', 'text', '[video]', 'attachments', '[]'::jsonb)));
  select data into saved from public.bormex_messages where id = fixture_id;
  if saved->>'status' <> 'read' or saved->>'text' <> 'original caption' or saved->'attachments'->0->>'storagePath' <> 'test-only/video.mp4' then raise exception 'Duplicate/echo damaged a message'; end if;
  -- A provider failure remains authoritative over the initial HTTP 200 result.
  saved := public.bormex_merge_whatsapp_delivery('{"status":"sent","text":"keep"}', '{"status":"failed","failedAt":"2026-10-29T16:00:03.000Z","deliveryError":{"code":131047}}');
  saved := public.bormex_merge_whatsapp_delivery(saved, '{"status":"sent"}');
  if saved->>'status' <> 'failed' or saved->'deliveryError'->>'code' <> '131047' or saved->>'text' <> 'keep' then raise exception 'False success after failure'; end if;
  saved := public.bormex_merge_whatsapp_delivery(saved, '{"status":"delivered","deliveredAt":"2026-10-29T16:00:04.000Z"}');
  saved := public.bormex_merge_whatsapp_delivery(saved, '{"status":"failed","failedAt":"2026-10-29T16:00:06.000Z"}');
  if saved->>'status' <> 'delivered' or saved ? 'deliveryError' then raise exception 'Failure overwrote proven delivery'; end if;
  if has_function_privilege('anon', 'public.bormex_store_whatsapp_messages(jsonb,boolean)', 'execute')
    or has_function_privilege('authenticated', 'public.bormex_store_whatsapp_messages(jsonb,boolean)', 'execute') then raise exception 'Receipt RPC exposed publicly'; end if;
end;
$$;
rollback;
