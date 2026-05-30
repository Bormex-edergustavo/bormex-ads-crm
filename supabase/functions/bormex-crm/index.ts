import { STATIC_HTML } from "./static-html.ts";

const defaultDb = {
  conversations: [],
  messages: [],
  sales: [],
  leads: [],
  spend: [],
  ads: [],
  campaignPeriods: [],
  rules: {
    targetCpa: 600,
    minRoas: 2,
    minLeads: 8,
  },
  webhookEvents: [],
  lastAdsSync: null,
  lastAdsRange: null,
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
    const accessRole = getAccessRole(req);

    if (!isPublicPath(pathname) && !accessRole) return unauthorized();
    if (!isPublicPath(pathname) && !isPathAllowed(pathname, req.method, accessRole)) {
      return text("Acceso no permitido para este usuario", 403);
    }

    if ((pathname === "/" || pathname === "/index.html") && req.method === "GET") {
      return html(STATIC_HTML);
    }

    if (pathname === "/oauth/meta" && req.method === "GET") {
      return await handleMetaOAuthCallback(url);
    }

    if (pathname === "/health" && req.method === "GET") {
      return json({ ok: true, at: new Date().toISOString() });
    }

    if (pathname === "/api/config" && req.method === "GET") {
      return json(configPayload(accessRole));
    }

    if (pathname === "/api/state" && req.method === "GET") {
      return json(filterStateForRole(await readDb(), accessRole));
    }

    if (pathname === "/api/debug/parse-whatsapp" && req.method === "POST") {
      return json(extractWhatsAppEvents(await readJson(req)));
    }

    if (pathname === "/api/ads-range" && req.method === "POST") {
      return json(await syncMetaAds(await readJson(req)));
    }

    if (pathname === "/api/messages" && req.method === "POST") {
      const body = await readJson(req);
      const message = await sendCrmMessage(body);
      await upsertItems("conversations", [message.conversation]);
      await upsertItems("messages", [message.record]);
      return json(await readDb());
    }

    if (pathname === "/api/sync/ads" && req.method === "POST") {
      const payload = await syncMetaAds(await readJson(req));
      await replaceCollection("ads", payload.ads);
      await replaceCollection("spend", payload.spend);
      await setSetting("lastAdsSync", new Date().toISOString());
      await setSetting("lastAdsRange", payload.range);
      return json(await readDb());
    }

    if (pathname === "/api/cron/sync" && req.method === "POST") {
      const secret = url.searchParams.get("secret") || req.headers.get("x-cron-secret") || "";
      if (!Deno.env.get("CRON_SECRET") || secret !== Deno.env.get("CRON_SECRET")) {
        return text("Forbidden", 403);
      }
      const payload = await syncMetaAds({});
      await replaceCollection("ads", payload.ads);
      await replaceCollection("spend", payload.spend);
      await setSetting("lastAdsSync", new Date().toISOString());
      await setSetting("lastAdsRange", payload.range);
      return json({ ok: true, ads: payload.ads.length });
    }

    if (pathname === "/api/sales" && req.method === "POST") {
      const sale = normalizeSale(await readJson(req));
      await upsertItems("sales", [sale]);
      return json(filterStateForRole(await readDb(), accessRole));
    }

    if (pathname.startsWith("/api/sales/") && req.method === "DELETE") {
      await deleteItem("sales", decodeURIComponent(pathname.replace("/api/sales/", "")));
      return json(filterStateForRole(await readDb(), accessRole));
    }

    if (pathname === "/api/rules" && req.method === "POST") {
      await setSetting("rules", normalizeRules(await readJson(req)));
      return json(await readDb());
    }

    if (pathname === "/api/campaign-periods" && req.method === "POST") {
      const body = await readJson(req);
      const periods = Array.isArray(body.periods) ? body.periods.map(normalizeCampaignPeriod) : [];
      await setSetting("campaignPeriods", periods);
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
      return json(filterStateForRole(await readDb(), accessRole));
    }

    if (pathname === "/webhooks/whatsapp" && req.method === "GET") {
      return verifyWhatsAppWebhook(url);
    }

    if (pathname === "/webhooks/whatsapp" && req.method === "POST") {
      const body = await readJson(req);
      const payload = extractWhatsAppEvents(body);
      await upsertItems("leads", payload.leads);
      await upsertItems("conversations", payload.conversations);
      await upsertItems("messages", payload.messages);
      await rememberWebhookEvent("whatsapp", body, payload);
      await setSetting("lastWebhookAt", new Date().toISOString());
      return json({ ok: true, leads: payload.leads.length, messages: payload.messages.length });
    }

    if (pathname === "/webhooks/meta" && req.method === "GET") {
      return verifyWhatsAppWebhook(url);
    }

    if (pathname === "/webhooks/meta" && req.method === "POST") {
      const body = await readJson(req);
      const payload = extractMetaMessagingEvents(body);
      await upsertItems("conversations", payload.conversations);
      await upsertItems("messages", payload.messages);
      await rememberWebhookEvent("meta", body, { leads: [], ...payload });
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

function configPayload(role = "") {
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
    role,
  };
}

function isPublicPath(pathname: string) {
  return pathname === "/webhooks/whatsapp" || pathname === "/webhooks/meta" || pathname === "/api/cron/sync" || pathname === "/oauth/meta";
}

function getAccessRole(req: Request) {
  const password = Deno.env.get("PANEL_PASSWORD") || "";
  if (!password) return "ads";
  const header = req.headers.get("authorization") || "";
  if (!header.startsWith("Basic ")) return "";
  const decoded = atob(header.slice(6));
  const separator = decoded.indexOf(":");
  const username = decoded.slice(0, separator);
  const incomingPassword = decoded.slice(separator + 1);
  const expectedUser = Deno.env.get("PANEL_USERNAME") || "";
  const userMatches = expectedUser ? username === expectedUser : true;
  if (!userMatches) return "";
  if (incomingPassword === password) return "ads";
  if (incomingPassword === (Deno.env.get("SALES_PANEL_PASSWORD") || "1234")) return "sales";
  return "";
}

function isPathAllowed(pathname: string, method: string, role: string) {
  if (role === "ads") return true;
  if (role !== "sales") return false;
  if (method === "GET" && ["/", "/index.html", "/styles.css", "/app.js", "/privacy.html"].includes(pathname)) return true;
  if (method === "GET" && ["/api/config", "/api/state"].includes(pathname)) return true;
  if (method === "POST" && pathname === "/api/sales") return true;
  if (method === "DELETE" && pathname.startsWith("/api/sales/")) return true;
  if (method === "DELETE" && pathname.startsWith("/api/records/sales/")) return true;
  return false;
}

function filterStateForRole(db: typeof defaultDb, role: string) {
  if (role !== "sales") return db;
  return {
    ...structuredClone(defaultDb),
    sales: db.sales || [],
    rules: db.rules || defaultDb.rules,
  };
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
    campaignPeriods: settings.campaignPeriods || [],
    webhookEvents: settings.webhookEvents || [],
    lastAdsSync: settings.lastAdsSync || null,
    lastAdsRange: settings.lastAdsRange || null,
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

async function syncMetaAds(options: any = {}) {
  const token = metaAdsAccessToken();
  const rawAccountId = Deno.env.get("META_AD_ACCOUNT_ID");
  if (!token || !rawAccountId) {
    throw new Error("Faltan META_ADS_ACCESS_TOKEN/META_ACCESS_TOKEN y META_AD_ACCOUNT_ID");
  }

  const accountId = rawAccountId.startsWith("act_") ? rawAccountId : `act_${rawAccountId}`;
  const range = normalizeSyncRange(options);
  const fields = [
    "id",
    "name",
    "status",
    "effective_status",
    "campaign{id,name,effective_status}",
    "adset{id,name,effective_status,daily_budget,lifetime_budget}",
    `insights.time_range({'since':'${range.since}','until':'${range.until}'}){spend,impressions,clicks,actions,cost_per_action_type}`,
  ].join(",");

  const url = new URL(`https://graph.facebook.com/${graphVersion()}/${accountId}/ads`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("limit", "100");
  url.searchParams.set("access_token", token);

  const ads = await fetchAllPages(url);
  const normalizedAds = ads
    .map((ad: any) => normalizeMetaAd(ad, range))
    .filter((ad: Record<string, unknown>) => ad.effectiveStatus === "ACTIVE" || Number(ad.spend || 0) > 0 || Number(ad.messages || 0) > 0);
  const spend = normalizedAds.map((ad: Record<string, unknown>) => ({
    id: `meta_spend_${ad.id}_${range.since}_${range.until}`,
    source: "meta",
    campaign: ad.campaign,
    campaignId: ad.campaignId,
    adset: ad.adset,
    adsetId: ad.adsetId,
    ad: ad.name,
    adId: ad.id,
    spend: ad.spend,
    dailyBudget: ad.dailyBudget,
    date: range.since === range.until ? range.since : `${range.since} - ${range.until}`,
    rangeStart: range.since,
    rangeEnd: range.until,
    messages: ad.messages,
  }));

  return { ads: normalizedAds, spend, range };
}

function normalizeSyncRange(options: any) {
  const today = todayInBusinessTimeZone();
  const since = validDate(options?.since || options?.startDate) || today;
  const until = validDate(options?.until || options?.endDate) || since;
  if (since > until) throw new Error("La fecha de inicio no puede ser mayor que la fecha fin");
  return { since, until };
}

function validDate(value: unknown) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
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

function normalizeMetaAd(ad: any, range: { since: string; until: string }) {
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
    rangeStart: range.since,
    rangeEnd: range.until,
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

function businessTimeZone() {
  return Deno.env.get("BUSINESS_TIME_ZONE") || Deno.env.get("ADS_TIME_ZONE") || "America/Mexico_City";
}

function todayInBusinessTimeZone() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: businessTimeZone(),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
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

async function handleMetaOAuthCallback(url: URL) {
  const code = url.searchParams.get("code") || "";
  const error = url.searchParams.get("error") || "";
  const errorDescription = url.searchParams.get("error_description") || "";
  const assetParams = Object.fromEntries(
    ["business_id", "waba_id", "phone_number_id", "state"].map((key) => [key, url.searchParams.get(key) || ""]),
  );

  await setSetting("lastMetaOAuthCallback", {
    at: new Date().toISOString(),
    hasCode: Boolean(code),
    codeLength: code.length,
    error,
    errorDescription,
    ...assetParams,
  });

  const title = error ? "Meta devolvio un error" : code ? "Registro recibido" : "Callback recibido";
  const message = error
    ? errorDescription || error
    : code
      ? "Meta regreso correctamente al CRM. Ya puedes cerrar esta ventana y volver al panel."
      : "Meta regreso al CRM, pero no incluyo codigo de autorizacion.";

  return text(`${title}\n\n${message}`);
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
    value.history?.messages,
    value.history?.data?.messages,
    value.history?.payload?.messages,
    value.history,
  ];
  const direct = candidates.flatMap((candidate) => {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") return [candidate];
    return [];
  }).filter(looksLikeWhatsAppMessage);
  if (direct.length) return direct;
  return collectNestedWhatsAppMessages(value);
}

function collectNestedWhatsAppMessages(root: any) {
  const found = new Map<string, any>();
  const visit = (node: any, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    if (looksLikeWhatsAppMessage(node)) {
      found.set(String(node.id || `${node.from || ""}_${node.to || ""}_${node.timestamp || crypto.randomUUID()}`), node);
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(root);
  return [...found.values()];
}

function looksLikeWhatsAppMessage(value: any) {
  if (!value || typeof value !== "object") return false;
  const hasSenderOrRecipient = Boolean(value.from || value.to || value.recipient_id || value.sender || value.recipient);
  const hasMessageShape = Boolean(
    value.text ||
      value.button ||
      value.interactive ||
      value.image ||
      value.video ||
      value.audio ||
      value.document ||
      value.sticker ||
      value.reaction ||
      value.type,
  );
  return hasSenderOrRecipient && hasMessageShape;
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
    adId: normalizeAdId(body.adId || body.ad_id || body.metaAdId || ""),
    ad: String(body.ad || ""),
    adset: String(body.adset || ""),
    campaign: String(body.campaign || ""),
    campaignId: String(body.campaignId || ""),
    attributionSource: String(body.attributionSource || ""),
  };
}

function normalizeCampaignPeriod(body: any) {
  return {
    id: String(body.id || body.key || crypto.randomUUID()),
    campaignId: String(body.campaignId || ""),
    campaign: String(body.campaign || "Sin campaña"),
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
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
  if (!digits) return "";
  if (digits.length === 10) return `52${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `52${digits.slice(1)}`;
  if (digits.length >= 13 && digits.startsWith("521")) return `52${digits.slice(3)}`;
  return digits;
}

function normalizeAdId(value: unknown) {
  const text = String(value || "").trim();
  if (!text) return "";
  const numeric = text.match(/(?:ad[_\s-]?id|source[_\s-]?id)?\D*(\d{8,})/i);
  if (numeric) return numeric[1];
  return text.replace(/^ad[_\s-]?id[:\s-]*/i, "").trim();
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

async function rememberWebhookEvent(source: string, body: any, parsed: { leads?: unknown[]; messages?: unknown[]; conversations?: unknown[] }) {
  const settings = await readSettings();
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    source,
    object: body.object || "",
    fields: getWebhookFields(body),
    entries: Array.isArray(body.entry) ? body.entry.length : 0,
    leads: parsed.leads?.length || 0,
    messages: parsed.messages?.length || 0,
    conversations: parsed.conversations?.length || 0,
    sample: summarizeWebhookPayload(body),
  };
  const previous = Array.isArray(settings.webhookEvents) ? settings.webhookEvents : [];
  await setSetting("webhookEvents", [entry, ...previous].slice(0, 20));
}

function getWebhookFields(body: any) {
  const fields = new Set<string>();
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) fields.add(String(change.field || "messages"));
  }
  return [...fields];
}

function summarizeWebhookPayload(body: any) {
  return {
    entryIds: (body.entry || []).map((entry: any) => entry.id).filter(Boolean).slice(0, 5),
    phoneNumberIds: (body.entry || [])
      .flatMap((entry: any) => entry.changes || [])
      .map((change: any) => change.value?.metadata?.phone_number_id)
      .filter(Boolean)
      .slice(0, 5),
  };
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
