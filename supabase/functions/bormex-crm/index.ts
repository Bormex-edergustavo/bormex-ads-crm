import { STATIC_HTML } from "./static-html.ts";

const defaultDb = {
  conversations: [],
  messages: [],
  sales: [],
  leads: [],
  spend: [],
  ads: [],
  rules: {
    targetCpa: 600,
    minRoas: 2,
    minLeads: 8,
  },
  lastAdsSync: null,
  lastWebhookAt: null,
};

const tableMap = {
  conversations: "bormex_conversations",
  messages: "bormex_messages",
  sales: "bormex_sales",
  leads: "bormex_leads",
  spend: "bormex_spend",
  ads: "bormex_ads",
} as const;

type Collection = keyof typeof tableMap;

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(req.url);
    const pathname = normalizePath(url.pathname);

    if (!isPublicPath(pathname) && !isAuthorized(req)) return unauthorized();

    if ((pathname === "/" || pathname === "/index.html") && req.method === "GET") {
      return html(STATIC_HTML);
    }

    if (pathname === "/health" && req.method === "GET") {
      return json({ ok: true, at: new Date().toISOString() });
    }

    if (pathname === "/api/config" && req.method === "GET") {
      return json(configPayload());
    }

    if (pathname === "/api/state" && req.method === "GET") {
      return json(await readDb());
    }

    if (pathname === "/api/messages" && req.method === "POST") {
      const body = await readJson(req);
      const message = await sendCrmMessage(body);
      await upsertItems("conversations", [message.conversation]);
      await upsertItems("messages", [message.record]);
      return json(await readDb());
    }

    if (pathname === "/api/sync/ads" && req.method === "POST") {
      const payload = await syncMetaAds();
      await replaceCollection("ads", payload.ads);
      await replaceCollection("spend", payload.spend);
      await setSetting("lastAdsSync", new Date().toISOString());
      return json(await readDb());
    }

    if (pathname === "/api/cron/sync" && req.method === "POST") {
      const secret = url.searchParams.get("secret") || req.headers.get("x-cron-secret") || "";
      if (!Deno.env.get("CRON_SECRET") || secret !== Deno.env.get("CRON_SECRET")) {
        return text("Forbidden", 403);
      }
      const payload = await syncMetaAds();
      await replaceCollection("ads", payload.ads);
      await replaceCollection("spend", payload.spend);
      await setSetting("lastAdsSync", new Date().toISOString());
      return json({ ok: true, ads: payload.ads.length });
    }

    if (pathname === "/api/sales" && req.method === "POST") {
      const sale = normalizeSale(await readJson(req));
      await upsertItems("sales", [sale]);
      return json(await readDb());
    }

    if (pathname.startsWith("/api/sales/") && req.method === "DELETE") {
      await deleteItem("sales", decodeURIComponent(pathname.replace("/api/sales/", "")));
      return json(await readDb());
    }

    if (pathname === "/api/rules" && req.method === "POST") {
      await setSetting("rules", normalizeRules(await readJson(req)));
      return json(await readDb());
    }

    if (pathname === "/api/import" && req.method === "POST") {
      const body = await readJson(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (body.type === "sales") await upsertItems("sales", rows.map(normalizeSale));
      if (body.type === "leads") await upsertItems("leads", rows.map(normalizeLead));
      if (body.type === "spend") await upsertItems("spend", rows.map(normalizeSpend));
      return json(await readDb());
    }

    if (pathname.startsWith("/api/records/") && req.method === "DELETE") {
      const [, , , collection, rawId] = pathname.split("/");
      if (!["sales", "leads", "spend"].includes(collection)) return text("Not found", 404);
      await deleteItem(collection as Collection, decodeURIComponent(rawId || ""));
      return json(await readDb());
    }

    if (pathname === "/webhooks/whatsapp" && req.method === "GET") {
      return verifyWhatsAppWebhook(url);
    }

    if (pathname === "/webhooks/whatsapp" && req.method === "POST") {
      const payload = extractWhatsAppEvents(await readJson(req));
      await upsertItems("leads", payload.leads);
      await upsertItems("conversations", payload.conversations);
      await upsertItems("messages", payload.messages);
      await setSetting("lastWebhookAt", new Date().toISOString());
      return json({ ok: true, leads: payload.leads.length, messages: payload.messages.length });
    }

    if (pathname === "/webhooks/meta" && req.method === "GET") {
      return verifyWhatsAppWebhook(url);
    }

    if (pathname === "/webhooks/meta" && req.method === "POST") {
      const payload = extractMetaMessagingEvents(await readJson(req));
      await upsertItems("conversations", payload.conversations);
      await upsertItems("messages", payload.messages);
      await setSetting("lastWebhookAt", new Date().toISOString());
      return json({ ok: true, messages: payload.messages.length });
    }

    return text("Not found", 404);
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Error interno" }, 500);
  }
});

function normalizePath(pathname: string) {
  if (pathname === "/bormex-crm") return "/";
  if (pathname.startsWith("/bormex-crm/")) return pathname.slice("/bormex-crm".length);
  return pathname;
}

function configPayload() {
  return {
    metaAdsConfigured: Boolean(metaAdsAccessToken() && Deno.env.get("META_AD_ACCOUNT_ID")),
    whatsappWebhookConfigured: Boolean(Deno.env.get("WHATSAPP_VERIFY_TOKEN")),
    whatsappPhoneConfigured: Boolean(Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    whatsappApiConfigured: Boolean(whatsappAccessToken() && Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    adAccountId: maskValue(Deno.env.get("META_AD_ACCOUNT_ID") || ""),
    webhookPath: "/webhooks/whatsapp",
    graphVersion: graphVersion(),
    panelAuthConfigured: Boolean(Deno.env.get("PANEL_PASSWORD")),
    adsSyncIntervalMinutes: Number(Deno.env.get("ADS_SYNC_INTERVAL_MINUTES") || 15),
  };
}

function isPublicPath(pathname: string) {
  return pathname === "/webhooks/whatsapp" || pathname === "/webhooks/meta" || pathname === "/api/cron/sync";
}

function isAuthorized(req: Request) {
  const password = Deno.env.get("PANEL_PASSWORD") || "";
  if (!password) return true;
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = atob(header.slice(6));
  const separator = decoded.indexOf(":");
  const username = decoded.slice(0, separator);
  const incomingPassword = decoded.slice(separator + 1);
  const expectedUser = Deno.env.get("PANEL_USERNAME") || "";
  const userMatches = expectedUser ? username === expectedUser : true;
  return userMatches && incomingPassword === password;
}

function unauthorized() {
  return text("Autenticación requerida", 401, {
    "www-authenticate": 'Basic realm="Ventas Ads"',
  });
}

async function readDb() {
  const [conversations, messages, sales, leads, spend, ads, settings] = await Promise.all([
    readCollection("conversations"),
    readCollection("messages"),
    readCollection("sales"),
    readCollection("leads"),
    readCollection("spend"),
    readCollection("ads"),
    readSettings(),
  ]);
  return {
    ...structuredClone(defaultDb),
    conversations,
    messages,
    sales,
    leads,
    spend,
    ads,
    rules: settings.rules || defaultDb.rules,
    lastAdsSync: settings.lastAdsSync || null,
    lastWebhookAt: settings.lastWebhookAt || null,
  };
}

async function readCollection(collection: Collection) {
  const response = await supabaseFetch(`/rest/v1/${tableMap[collection]}?select=data`);
  const rows = await response.json();
  if (!response.ok) throw new Error(rows.message || `No se pudo leer ${collection}`);
  return rows.map((row: { data: unknown }) => row.data);
}

async function readSettings() {
  const response = await supabaseFetch("/rest/v1/bormex_settings?select=key,value");
  const rows = await response.json();
  if (!response.ok) throw new Error(rows.message || "No se pudo leer configuración");
  return Object.fromEntries(rows.map((row: { key: string; value: unknown }) => [row.key, row.value]));
}

async function setSetting(key: string, value: unknown) {
  const response = await supabaseFetch("/rest/v1/bormex_settings?on_conflict=key", {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates" },
    body: JSON.stringify([{ key, value }]),
  });
  if (!response.ok) throw new Error((await response.json()).message || "No se pudo guardar configuración");
}

async function upsertItems(collection: Collection, items: Array<Record<string, unknown>>) {
  if (!items.length) return;
  const table = tableMap[collection];
  const rows = items.map((item) => ({ id: String(item.id), data: item }));
  const response = await supabaseFetch(`/rest/v1/${table}?on_conflict=id`, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error((await response.json()).message || `No se pudo guardar ${collection}`);
}

async function replaceCollection(collection: Collection, items: Array<Record<string, unknown>>) {
  await supabaseFetch(`/rest/v1/${tableMap[collection]}?id=not.is.null`, { method: "DELETE" });
  await upsertItems(collection, items);
}

async function deleteItem(collection: Collection, id: string) {
  const response = await supabaseFetch(`/rest/v1/${tableMap[collection]}?id=eq.${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!response.ok) throw new Error((await response.json()).message || `No se pudo eliminar ${collection}`);
}

async function supabaseFetch(path: string, options: RequestInit = {}) {
  const baseUrl = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || readFirstSecretKey();
  if (!baseUrl || !key) throw new Error("Faltan secretos de Supabase en Edge Function");
  const headers = new Headers(options.headers);
  headers.set("apikey", key);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("content-type", "application/json");
  return fetch(`${baseUrl}${path}`, { ...options, headers });
}

function readFirstSecretKey() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (!raw) return "";
  const values = Object.values(JSON.parse(raw));
  return String(values[0] || "");
}

async function syncMetaAds() {
  const token = metaAdsAccessToken();
  const rawAccountId = Deno.env.get("META_AD_ACCOUNT_ID");
  if (!token || !rawAccountId) {
    throw new Error("Faltan META_ADS_ACCESS_TOKEN/META_ACCESS_TOKEN y META_AD_ACCOUNT_ID");
  }

  const accountId = rawAccountId.startsWith("act_") ? rawAccountId : `act_${rawAccountId}`;
  const today = new Date().toISOString().slice(0, 10);
  const fields = [
    "id",
    "name",
    "status",
    "effective_status",
    "campaign{id,name,effective_status}",
    "adset{id,name,effective_status,daily_budget,lifetime_budget}",
    `insights.time_range({'since':'${today}','until':'${today}'}){spend,impressions,clicks,actions,cost_per_action_type}`,
  ].join(",");

  const url = new URL(`https://graph.facebook.com/${graphVersion()}/${accountId}/ads`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("effective_status", JSON.stringify(["ACTIVE"]));
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", token);

  const ads = await fetchAllPages(url);
  const normalizedAds = ads.map(normalizeMetaAd);
  const spend = normalizedAds.map((ad: Record<string, unknown>) => ({
    id: `meta_spend_${ad.id}_${today}`,
    source: "meta",
    campaign: ad.campaign,
    adset: ad.adset,
    ad: ad.name,
    adId: ad.id,
    spend: ad.spend,
    dailyBudget: ad.dailyBudget,
    date: today,
  }));

  return { ads: normalizedAds, spend };
}

async function fetchAllPages(firstUrl: URL) {
  const rows = [];
  let next = firstUrl.toString();
  while (next) {
    const response = await fetch(next);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error?.message || `Meta API respondió ${response.status}`);
    rows.push(...(payload.data || []));
    next = payload.paging?.next || "";
  }
  return rows;
}

function normalizeMetaAd(ad: any) {
  const insights = ad.insights?.data?.[0] || {};
  const actions = insights.actions || [];
  const messages = pickActionValue(actions, [
    "onsite_conversion.messaging_conversation_started_7d",
    "onsite_conversion.total_messaging_connection",
    "onsite_conversion.messaging_first_reply",
  ]);
  return {
    id: ad.id,
    name: ad.name || "Sin nombre",
    status: ad.status || "",
    effectiveStatus: ad.effective_status || "",
    campaign: ad.campaign?.name || "Sin campaña",
    campaignId: ad.campaign?.id || "",
    adset: ad.adset?.name || "Sin conjunto",
    adsetId: ad.adset?.id || "",
    dailyBudget: centsToMoney(ad.adset?.daily_budget),
    spend: Number(insights.spend || 0),
    impressions: Number(insights.impressions || 0),
    clicks: Number(insights.clicks || 0),
    messages,
    metaLeads: pickActionValue(actions, ["onsite_conversion.lead_grouped", "onsite_conversion.lead", "lead"]),
  };
}

function pickActionValue(actions: any[], actionTypes: string[]) {
  for (const actionType of actionTypes) {
    const found = actions.find((item: any) => item.action_type === actionType);
    if (found) return Number(found.value || 0);
  }
  return 0;
}

async function sendCrmMessage(body: any) {
  const channel = String(body.channel || "").trim();
  const conversationId = String(body.conversationId || "").trim();
  const to = normalizePhone(body.to || body.phone || "");
  const textBody = String(body.text || "").trim();
  if (!channel || !conversationId || !to || !textBody) throw new Error("Faltan datos para enviar el mensaje");

  let providerMessageId = crypto.randomUUID();
  if (channel === "whatsapp") providerMessageId = await sendWhatsAppText(to, textBody);
  else throw new Error(`El envio por ${channel} queda pendiente de configurar con Meta`);

  const now = new Date().toISOString();
  return {
    conversation: {
      id: conversationId,
      channel,
      contactId: to,
      phone: to,
      name: String(body.name || to),
      lastMessage: textBody,
      lastAt: now,
      unread: 0,
    },
    record: {
      id: providerMessageId,
      conversationId,
      channel,
      direction: "outbound",
      from: Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "crm",
      to,
      text: textBody,
      at: now,
      status: "sent",
    },
  };
}

async function sendWhatsAppText(to: string, textBody: string) {
  const token = whatsappAccessToken();
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    throw new Error("Falta WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN/META_ACCESS_TOKEN");
  }
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: textBody },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Meta no acepto el mensaje de WhatsApp");
  return payload.messages?.[0]?.id || crypto.randomUUID();
}

function verifyWhatsAppWebhook(url: URL) {
  const verifyToken = Deno.env.get("WHATSAPP_VERIFY_TOKEN");
  if (!verifyToken) return text("Webhook sin configurar", 500);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === verifyToken) return text(challenge || "");
  return text("Forbidden", 403);
}

function extractWhatsAppEvents(payload: any) {
  const leads = [];
  const conversations = [];
  const messages = [];
  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const field = String(change.field || "messages");
      const value = change.value || {};
      const businessPhone = normalizePhone(value.metadata?.display_phone_number || Deno.env.get("WHATSAPP_DISPLAY_PHONE_NUMBER") || "");
      const contacts = new Map((value.contacts || []).map((contact: any) => [contact.wa_id, contact]));
      for (const message of getWhatsAppMessageItems(value)) {
        const fromPhone = normalizePhone(message.from || message.sender?.wa_id || message.sender?.id || "");
        const toPhone = normalizePhone(message.to || message.recipient_id || message.recipient?.wa_id || message.recipient?.id || "");
        const isEcho = isWhatsAppEcho(message, field, fromPhone, businessPhone);
        const phone = isEcho ? toPhone || fromPhone : fromPhone || toPhone;
        if (!phone) continue;
        const contact = ((contacts.get(phone) || contacts.get(message.from) || {}) as any);
        const textBody = extractMessageText(message);
        const at = timestampToIso(message.timestamp);
        const conversationId = `whatsapp_${phone}`;
        conversations.push({
          id: conversationId,
          channel: "whatsapp",
          contactId: phone,
          phone,
          name: contact.profile?.name || phone,
          lastMessage: textBody,
          lastAt: at,
          unread: isEcho ? 0 : 1,
        });
        messages.push({
          id: message.id || crypto.randomUUID(),
          conversationId,
          channel: "whatsapp",
          direction: isEcho ? "outbound" : "inbound",
          from: isEcho ? businessPhone || fromPhone || "business" : phone,
          to: isEcho ? phone : businessPhone || value.metadata?.display_phone_number || "",
          text: textBody,
          at,
          status: isEcho ? "sent" : "received",
          sourceField: field,
          attachments: extractMessageAttachments(message),
        });
        const referral = message.referral || message.context?.referral || {};
        if (isEcho || (!referral.source_id && !referral.ctwa_clid)) continue;
        leads.push({
          id: `wa_${message.id || crypto.randomUUID()}`,
          source: "whatsapp_cloud",
          phone,
          campaign: referral.headline || "Click-to-WhatsApp",
          adset: "",
          ad: referral.body || referral.source_url || referral.source_id || "Anuncio WhatsApp",
          adId: referral.source_id || "",
          ctwaClid: referral.ctwa_clid || "",
          date: timestampToDate(message.timestamp),
          message: textBody,
        });
      }
    }
  }
  return { leads, conversations, messages };
}

function getWhatsAppMessageItems(value: any) {
  const candidates = [
    value.messages,
    value.message_echoes,
    value.smb_message_echoes,
    value.echoes,
  ];
  return candidates.flatMap((candidate) => {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") return [candidate];
    return [];
  });
}

function isWhatsAppEcho(message: any, field: string, fromPhone: string, businessPhone: string) {
  const normalizedField = field.toLowerCase();
  return Boolean(
    normalizedField.includes("echo") ||
      message.from_me === true ||
      message.fromMe === true ||
      message.echo === true ||
      message.direction === "outbound" ||
      (businessPhone && fromPhone && businessPhone === fromPhone),
  );
}

function extractMetaMessagingEvents(payload: any) {
  const channel = payload.object === "instagram" ? "instagram" : "messenger";
  const conversations = [];
  const messages = [];
  for (const entry of payload.entry || []) {
    for (const event of entry.messaging || []) {
      const sender = String(event.sender?.id || "");
      const recipient = String(event.recipient?.id || "");
      if (!sender || !event.message) continue;
      const conversationId = `${channel}_${sender}`;
      const textBody = event.message.text || "[mensaje sin texto]";
      const at = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
      conversations.push({ id: conversationId, channel, contactId: sender, phone: "", name: sender, lastMessage: textBody, lastAt: at, unread: 1 });
      messages.push({ id: event.message.mid || crypto.randomUUID(), conversationId, channel, direction: "inbound", from: sender, to: recipient, text: textBody, at, status: "received" });
    }
  }
  return { conversations, messages };
}

function normalizeSale(body: any) {
  const products = Array.isArray(body.products)
    ? body.products.map((product: unknown) => String(product).trim()).filter(Boolean)
    : String(body.product || "").split(/[|,]/).map((product) => product.trim()).filter(Boolean);
  return {
    id: String(body.id || crypto.randomUUID()),
    phone: normalizePhone(body.phone || ""),
    products,
    product: products.join(", "),
    amount: Number(body.amount || 0),
    date: String(body.date || new Date().toISOString().slice(0, 10)),
  };
}

function normalizeLead(body: any) {
  return {
    id: String(body.id || crypto.randomUUID()),
    source: body.source || "manual_import",
    phone: normalizePhone(body.phone || ""),
    campaign: String(body.campaign || ""),
    adset: String(body.adset || ""),
    ad: String(body.ad || ""),
    adId: String(body.adId || ""),
    ctwaClid: String(body.ctwaClid || ""),
    date: String(body.date || new Date().toISOString().slice(0, 10)),
    message: String(body.message || ""),
  };
}

function normalizeSpend(body: any) {
  return {
    id: String(body.id || crypto.randomUUID()),
    source: body.source || "manual_import",
    campaign: String(body.campaign || ""),
    adset: String(body.adset || ""),
    ad: String(body.ad || ""),
    adId: String(body.adId || ""),
    spend: Number(body.spend || 0),
    dailyBudget: Number(body.dailyBudget || 0),
    date: String(body.date || new Date().toISOString().slice(0, 10)),
  };
}

function normalizeRules(body: any) {
  return {
    targetCpa: Number(body.targetCpa || 0),
    minRoas: Number(body.minRoas || 0),
    minLeads: Number(body.minLeads || 0),
  };
}

function extractMessageText(message: any) {
  if (message.text?.body) return message.text.body;
  if (message.button?.text) return message.button.text;
  if (message.interactive?.button_reply?.title) return message.interactive.button_reply.title;
  if (message.interactive?.list_reply?.title) return message.interactive.list_reply.title;
  if (message.image?.caption) return message.image.caption;
  if (message.video?.caption) return message.video.caption;
  if (message.document?.caption) return message.document.caption;
  if (message.reaction?.emoji) return `Reaccionó ${message.reaction.emoji}`;
  return `[${message.type || "mensaje"}]`;
}

function extractMessageAttachments(message: any) {
  return ["image", "video", "audio", "document", "sticker"]
    .filter((type) => message[type])
    .map((type) => ({
      type,
      id: message[type]?.id || "",
      mimeType: message[type]?.mime_type || "",
      filename: message[type]?.filename || "",
      caption: message[type]?.caption || "",
    }));
}

function normalizePhone(value: unknown) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) return `52${digits}`;
  if (digits.length >= 12 && digits.startsWith("521")) return `52${digits.slice(3)}`;
  return digits;
}

function timestampToDate(value: unknown) {
  const numeric = Number(value || 0);
  if (!numeric) return new Date().toISOString().slice(0, 10);
  return new Date(numeric * 1000).toISOString().slice(0, 10);
}

function timestampToIso(value: unknown) {
  const numeric = Number(value || 0);
  if (!numeric) return new Date().toISOString();
  return new Date(numeric * 1000).toISOString();
}

function centsToMoney(value: unknown) {
  const amount = Number(value || 0);
  return amount ? amount / 100 : 0;
}

function graphVersion() {
  return Deno.env.get("META_GRAPH_VERSION") || "v25.0";
}

function metaAdsAccessToken() {
  return Deno.env.get("META_ADS_ACCESS_TOKEN") || Deno.env.get("META_ACCESS_TOKEN") || "";
}

function whatsappAccessToken() {
  return Deno.env.get("WHATSAPP_ACCESS_TOKEN") || Deno.env.get("META_ACCESS_TOKEN") || "";
}

function maskValue(value: string) {
  if (!value) return "";
  if (value.length <= 8) return "configurado";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

async function readJson(req: Request) {
  const textBody = await req.text();
  return textBody ? JSON.parse(textBody) : {};
}

function html(payload: string, status = 200) {
  return cors(new Response(payload, { status, headers: { "content-type": "text/html; charset=utf-8" } }));
}

function json(payload: unknown, status = 200) {
  return cors(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } }));
}

function text(payload: string, status = 200, headers: HeadersInit = {}) {
  return cors(new Response(payload, { status, headers: { "content-type": "text/plain; charset=utf-8", ...headers } }));
}

function cors(response: Response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-headers", "authorization, content-type, x-cron-secret");
  response.headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  return response;
}
