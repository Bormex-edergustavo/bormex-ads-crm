create index if not exists bormex_conversations_updated_at_idx
  on public.bormex_conversations (updated_at desc);

create index if not exists bormex_conversations_phone_idx
  on public.bormex_conversations ((data->>'phone'));

create index if not exists bormex_conversations_contact_id_idx
  on public.bormex_conversations ((data->>'contactId'));

create index if not exists bormex_messages_conversation_at_idx
  on public.bormex_messages ((data->>'conversationId'), (data->>'at') desc);

create index if not exists bormex_sales_updated_at_idx
  on public.bormex_sales (updated_at);

create index if not exists bormex_leads_updated_at_idx
  on public.bormex_leads (updated_at);

create index if not exists bormex_spend_updated_at_idx
  on public.bormex_spend (updated_at);

create index if not exists bormex_ads_updated_at_idx
  on public.bormex_ads (updated_at);
