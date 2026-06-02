const defaultDb = {
  conversations: [],
  messages: [],
  sales: [],
  leads: [],
  spend: [],
  ads: [],
  crmTags: [
    { id: "tag_pago", name: "Pago pendiente", color: "#f97316", action: "sale", followUpDays: 0, notifyPhone: "" },
    { id: "tag_retro", name: "Necesita retro", color: "#2563eb", action: "followup", followUpDays: 3, notifyPhone: "" },
    { id: "tag_diseno", name: "Diseños", color: "#0ea5e9", action: "none", followUpDays: 0, notifyPhone: "" },
  ],
  campaignPeriods: [],
  rules: {
    targetCpa: 600,
    minRoas: 2,
    minLeads: 8,
  },
  webhookEvents: [],
  lastCoexistenceSync: null,
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
      return html(frontendRedirectHtml());
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

    if (pathname === "/api/debug/parse-meta" && req.method === "POST") {
      return json(extractMetaMessagingEvents(await readJson(req)));
    }

    if (pathname === "/api/meta/subscriptions" && req.method === "GET") {
      return json(await getMetaSubscriptionDiagnostics());
    }

    if (pathname === "/api/meta/coexistence" && req.method === "GET") {
      return json(await getMetaCoexistenceSetup(url));
    }

    if (pathname === "/api/meta/subscribe" && req.method === "POST") {
      return json(await subscribeMetaWebhooks(url));
    }

    if (pathname === "/api/meta/coexistence/sync" && req.method === "POST") {
      return json(await initiateWhatsAppCoexistenceSync(await readJson(req)));
    }

    if (pathname === "/api/meta/webhook-token" && req.method === "POST") {
      return json(await saveAdditionalWebhookVerifyToken(await readJson(req)));
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

    if (pathname.startsWith("/api/conversations/") && req.method === "POST") {
      await updateConversation(decodeURIComponent(pathname.replace("/api/conversations/", "")), await readJson(req));
      return json(filterStateForRole(await readDb(), accessRole));
    }

    if (pathname === "/api/crm-tags" && req.method === "POST") {
      await saveCrmTag(await readJson(req));
      return json(filterStateForRole(await readDb(), accessRole));
    }

    if (pathname === "/api/followups/run" && req.method === "POST") {
      return json(await runFollowUpNotifications());
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

    if (pathname === "/api/cron/followups" && req.method === "POST") {
      const secret = url.searchParams.get("secret") || req.headers.get("x-cron-secret") || "";
      if (!Deno.env.get("CRON_SECRET") || secret !== Deno.env.get("CRON_SECRET")) {
        return text("Forbidden", 403);
      }
      return json(await runFollowUpNotifications());
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
      return await verifyWhatsAppWebhook(url);
    }

    if (pathname === "/webhooks/whatsapp" && req.method === "POST") {
      const body = await readVerifiedMetaJson(req);
      const payload = extractWhatsAppEvents(body);
      await upsertItems("leads", payload.leads);
      await upsertItems("conversations", payload.conversations);
      await upsertItems("messages", payload.messages);
      await rememberWebhookEvent("whatsapp", body, payload);
      await setSetting("lastWebhookAt", new Date().toISOString());
      return json({ ok: true, leads: payload.leads.length, messages: payload.messages.length });
    }

    if (pathname === "/webhooks/meta" && req.method === "GET") {
      return await verifyWhatsAppWebhook(url);
    }

    if (pathname === "/webhooks/meta" && req.method === "POST") {
      const body = await readVerifiedMetaJson(req);
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
    const status = error instanceof HttpError ? error.status : 500;
    return json({ error: error instanceof Error ? error.message : "Error interno" }, status);
  }
});

class HttpError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function frontendRedirectHtml() {
  const frontendUrl = Deno.env.get("BORMEX_FRONTEND_URL") || "https://bormex-edergustavo.github.io/bormex-ads-crm/";
  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="0; url=${frontendUrl}" />
    <title>Bormex Ads CRM</title>
  </head>
  <body>
    <p><a href="${frontendUrl}">Abrir Bormex Ads CRM</a></p>
  </body>
</html>`;
}

function normalizePath(pathname: string) {
  if (pathname === "/bormex-crm") return "/";
  if (pathname.startsWith("/bormex-crm/")) return pathname.slice("/bormex-crm".length);
  return pathname;
}

function configPayload(role = "") {
  return {
    metaAdsConfigured: Boolean(metaAdsAccessToken() && Deno.env.get("META_AD_ACCOUNT_ID")),
    whatsappWebhookConfigured: Boolean(metaWebhookVerifyToken()),
    whatsappPhoneConfigured: Boolean(Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    whatsappApiConfigured: Boolean(whatsappAccessToken() && Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    whatsappCoexistenceReady: Boolean(metaWebhookVerifyToken() && whatsappAccessToken() && Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    whatsappCoexistenceOnboardingConfigured: Boolean(metaAppId() && metaEmbeddedSignupConfigId()),
    webhookSignatureConfigured: Boolean(metaAppSecret()),
    messengerWebhookConfigured: Boolean(metaWebhookVerifyToken()),
    messengerApiConfigured: Boolean(messengerAccessToken()),
    messengerPageConfigured: Boolean(messengerPageId()),
    instagramWebhookConfigured: Boolean(metaWebhookVerifyToken()),
    instagramApiConfigured: Boolean(instagramAccessToken()),
    instagramAccountConfigured: Boolean(instagramAccountId()),
    adAccountId: maskValue(Deno.env.get("META_AD_ACCOUNT_ID") || ""),
    webhookPath: "/webhooks/whatsapp",
    metaWebhookPath: "/webhooks/meta",
    graphVersion: graphVersion(),
    panelAuthConfigured: Boolean(Deno.env.get("PANEL_PASSWORD")),
    adsSyncIntervalMinutes: Number(Deno.env.get("ADS_SYNC_INTERVAL_MINUTES") || 15),
    role,
  };
}

function isPublicPath(pathname: string) {
  return ["/", "/index.html", "/health", "/webhooks/whatsapp", "/webhooks/meta", "/api/cron/sync", "/api/cron/followups", "/oauth/meta"].includes(pathname);
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
    crmTags: normalizeCrmTags(settings.crmTags || defaultDb.crmTags),
    campaignPeriods: settings.campaignPeriods || [],
    webhookEvents: settings.webhookEvents || [],
    lastCoexistenceSync: settings.lastCoexistenceSync || null,
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
  const compacted = compactItemsById(items);
  const existing = collection === "conversations" ? await readCollection("conversations") : [];
  const existingById = new Map(existing.map((item: any) => [String(item.id || ""), item]));
  const rows = compacted.map((item) => {
    const id = String(item.id);
    const data = collection === "conversations" ? mergeConversationData(existingById.get(id), item) : item;
    return { id, data };
  });
  const response = await supabaseFetch(`/rest/v1/${table}?on_conflict=id`, {
    method: "POST",
    headers: { prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(rows),
  });
  if (!response.ok) throw new Error((await response.json()).message || `No se pudo guardar ${collection}`);
}

function compactItemsById(items: Array<Record<string, unknown>>) {
  const map = new Map<string, Record<string, unknown>>();
  for (const item of items) {
    const id = String(item.id || "");
    if (!id) continue;
    const previous = map.get(id);
    if (!previous) {
      map.set(id, item);
      continue;
    }
    const previousAt = Date.parse(String(previous.lastAt || previous.at || ""));
    const nextAt = Date.parse(String(item.lastAt || item.at || ""));
    if (Number.isFinite(nextAt) && (!Number.isFinite(previousAt) || nextAt >= previousAt)) {
      map.set(id, { ...previous, ...item });
    }
  }
  return [...map.values()];
}

function mergeConversationData(existing: any, incoming: Record<string, unknown>) {
  const merged: Record<string, unknown> = { ...(existing || {}), ...incoming };
  for (const field of [
    "tags",
    "followUpAt",
    "followUpDays",
    "followUpContact",
    "followUpNote",
    "followUpNotifiedAt",
    "crmNote",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field) && existing?.[field] !== undefined) {
      merged[field] = existing[field];
    }
  }
  for (const field of ["adId", "ad", "adset", "campaign", "campaignId", "ctwaClid", "sourceUrl", "attributionSource"]) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field) && existing?.[field] !== undefined) {
      merged[field] = existing[field];
    }
    if (Object.prototype.hasOwnProperty.call(incoming, field) && !incoming[field] && existing?.[field] && !incoming.attributionSource) {
      merged[field] = existing[field];
    }
  }
  merged.tags = normalizeTagIds(merged.tags);
  merged.updatedAt = String(incoming.updatedAt || new Date().toISOString());
  return merged;
}

async function updateConversation(id: string, body: any) {
  if (!id) throw new HttpError(400, "Falta id de conversación");
  const existing = (await readCollection("conversations")).find((item: any) => String(item.id || "") === id) || {};
  const conversation = normalizeConversationPatch({ ...existing, ...body, id });
  await upsertItems("conversations", [conversation]);
  return conversation;
}

function normalizeConversationPatch(body: any) {
  const id = String(body.id || "");
  const channel = String(body.channel || "").trim();
  const phone = normalizePhone(body.phone || "");
  const contactId = String(body.contactId || body.contact_id || phone || "").trim();
  return {
    id,
    channel,
    contactId,
    phone,
    name: String(body.name || contactId || phone || ""),
    lastMessage: String(body.lastMessage || body.last_message || ""),
    lastAt: String(body.lastAt || body.last_at || new Date().toISOString()),
    unread: Number(body.unread || 0),
    tags: normalizeTagIds(body.tags),
    adId: normalizeAdId(body.adId || body.ad_id || ""),
    ad: String(body.ad || ""),
    adset: String(body.adset || ""),
    campaign: String(body.campaign || ""),
    campaignId: String(body.campaignId || ""),
    ctwaClid: String(body.ctwaClid || ""),
    sourceUrl: String(body.sourceUrl || ""),
    attributionSource: String(body.attributionSource || ""),
    followUpAt: String(body.followUpAt || ""),
    followUpDays: Number(body.followUpDays || 0),
    followUpContact: normalizePhone(body.followUpContact || ""),
    followUpNote: String(body.followUpNote || ""),
    followUpNotifiedAt: String(body.followUpNotifiedAt || ""),
    crmNote: String(body.crmNote || ""),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeTagIds(value: unknown) {
  const items = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(items.map((item) => String(item).trim()).filter(Boolean))];
}

async function saveCrmTag(body: any) {
  const tag = normalizeCrmTag(body);
  const settings = await readSettings();
  const tags = normalizeCrmTags(settings.crmTags || defaultDb.crmTags);
  const index = tags.findIndex((item) => item.id === tag.id);
  const next = index >= 0 ? tags.map((item, itemIndex) => (itemIndex === index ? { ...item, ...tag } : item)) : [...tags, tag];
  await setSetting("crmTags", next);
  return tag;
}

function normalizeCrmTags(value: unknown) {
  const source = Array.isArray(value) ? value : defaultDb.crmTags;
  return source.map(normalizeCrmTag).filter((tag) => tag.name);
}

function normalizeCrmTag(body: any) {
  const name = String(body.name || "").trim();
  const fallbackId = name
    ? `tag_${name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`
    : crypto.randomUUID();
  return {
    id: String(body.id || fallbackId),
    name,
    color: normalizeColor(body.color || "#2563eb"),
    action: ["none", "sale", "followup"].includes(String(body.action || "")) ? String(body.action) : "none",
    followUpDays: Math.max(0, Number(body.followUpDays || 0)),
    notifyPhone: normalizePhone(body.notifyPhone || ""),
  };
}

function normalizeColor(value: unknown) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : "#2563eb";
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
  const to = normalizeChannelRecipient(channel, body.to || body.phone || body.contactId || "");
  const textBody = String(body.text || "").trim();
  const media = normalizeOutgoingMedia(body);
  if (!channel || !conversationId || !to || (!textBody && !media.url)) throw new Error("Faltan datos para enviar el mensaje");

  let providerMessageId = crypto.randomUUID();
  if (channel === "whatsapp") providerMessageId = await sendWhatsAppMessage(to, textBody, media);
  else if (channel === "messenger") providerMessageId = await sendMessengerMessage(to, textBody, media);
  else if (channel === "instagram") providerMessageId = await sendInstagramMessage(to, textBody, media);
  else throw new Error(`Canal no soportado: ${channel}`);

  const now = new Date().toISOString();
  return {
    conversation: {
      id: conversationId,
      channel,
      contactId: to,
      phone: channel === "whatsapp" ? to : "",
      name: String(body.name || to),
      lastMessage: textBody || `[${media.type}]`,
      lastAt: now,
      unread: 0,
    },
    record: {
      id: providerMessageId,
      conversationId,
      channel,
      direction: "outbound",
      from: channelSenderId(channel),
      to,
      text: textBody,
      at: now,
      status: "sent",
      attachments: media.url ? [media] : [],
    },
  };
}

function normalizeChannelRecipient(channel: string, value: unknown) {
  if (channel === "whatsapp") return normalizePhone(value);
  return String(value || "").trim();
}

function channelSenderId(channel: string) {
  if (channel === "whatsapp") return Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || Deno.env.get("WHATSAPP_DISPLAY_PHONE_NUMBER") || "crm";
  if (channel === "messenger") return messengerPageId() || "page";
  if (channel === "instagram") return instagramAccountId() || "instagram";
  return "crm";
}

function normalizeOutgoingMedia(body: any) {
  const url = String(body.mediaUrl || body.media?.url || "").trim();
  const rawType = String(body.mediaType || body.media?.type || "").trim().toLowerCase();
  const type = ["image", "video", "audio", "document"].includes(rawType) ? rawType : inferMediaType(url);
  return {
    type,
    url,
    filename: String(body.mediaFilename || body.media?.filename || "").trim(),
  };
}

function inferMediaType(url: string) {
  if (/\.(mp4|mov|webm)(\?|$)/i.test(url)) return "video";
  if (/\.(mp3|ogg|wav|m4a)(\?|$)/i.test(url)) return "audio";
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)(\?|$)/i.test(url)) return "document";
  return "image";
}

async function sendWhatsAppText(to: string, textBody: string) {
  return await sendWhatsAppMessage(to, textBody, { type: "", url: "", filename: "" });
}

async function sendWhatsAppMessage(to: string, textBody: string, media: { type: string; url: string; filename?: string }) {
  const token = whatsappAccessToken();
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    throw new Error("Falta WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN/META_ACCESS_TOKEN");
  }
  const body = media.url
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: media.type,
        [media.type]: {
          link: media.url,
          ...(media.filename && media.type === "document" ? { filename: media.filename } : {}),
          ...(textBody && ["image", "video", "document"].includes(media.type) ? { caption: textBody } : {}),
        },
      }
    : {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: "text",
        text: { preview_url: false, body: textBody },
      };
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Meta no acepto el mensaje de WhatsApp");
  return payload.messages?.[0]?.id || crypto.randomUUID();
}

async function sendMessengerText(to: string, textBody: string) {
  return await sendMessengerMessage(to, textBody, { type: "", url: "", filename: "" });
}

async function sendMessengerMessage(to: string, textBody: string, media: { type: string; url: string }) {
  const token = messengerAccessToken();
  if (!token) throw new Error("Falta MESSENGER_PAGE_ACCESS_TOKEN o META_PAGE_ACCESS_TOKEN para Messenger");
  let lastMessageId = "";
  if (textBody) {
    lastMessageId = await sendMessengerApiMessage(token, to, { text: textBody }, "Meta no acepto el mensaje de Messenger");
  }
  if (media.url) {
    const attachmentType = media.type === "document" ? "file" : media.type;
    lastMessageId = await sendMessengerApiMessage(
      token,
      to,
      { attachment: { type: attachmentType, payload: { url: media.url, is_reusable: true } } },
      "Meta no acepto el adjunto de Messenger",
    );
  }
  return lastMessageId || crypto.randomUUID();
}

async function sendMessengerApiMessage(token: string, to: string, message: Record<string, unknown>, fallbackError: string) {
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/me/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_type: "RESPONSE",
      recipient: { id: to },
      message,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || fallbackError);
  return payload.message_id || crypto.randomUUID();
}

async function sendInstagramText(to: string, textBody: string) {
  return await sendInstagramMessage(to, textBody, { type: "", url: "", filename: "" });
}

async function sendInstagramMessage(to: string, textBody: string, media: { type: string; url: string }) {
  const token = instagramAccessToken();
  if (!token) throw new Error("Falta INSTAGRAM_ACCESS_TOKEN o META_INSTAGRAM_ACCESS_TOKEN para Instagram");
  if (media.url) {
    const fallbackToken = messengerAccessToken() || token;
    return await sendMessengerStyleInstagramMessage(to, textBody, media, fallbackToken);
  }
  const accountId = instagramAccountId() || "me";
  const response = await fetch(`https://graph.instagram.com/${graphVersion()}/${accountId}/messages`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      recipient: { id: to },
      message: { text: textBody },
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const fallbackToken = messengerAccessToken();
    if (fallbackToken && fallbackToken !== token) return await sendInstagramTextViaMessengerApi(to, textBody, fallbackToken);
    throw new Error(payload.error?.message || "Meta no acepto el mensaje de Instagram");
  }
  return payload.message_id || payload.messages?.[0]?.id || crypto.randomUUID();
}

async function sendInstagramTextViaMessengerApi(to: string, textBody: string, token: string) {
  return await sendMessengerStyleInstagramMessage(to, textBody, { type: "", url: "" }, token);
}

async function sendMessengerStyleInstagramMessage(to: string, textBody: string, media: { type: string; url: string }, token: string) {
  let lastMessageId = "";
  if (textBody) {
    lastMessageId = await sendMessengerApiMessage(token, to, { text: textBody }, "Meta no acepto el mensaje de Instagram");
  }
  if (media.url) {
    const attachmentType = media.type === "document" ? "file" : media.type;
    lastMessageId = await sendMessengerApiMessage(
      token,
      to,
      { attachment: { type: attachmentType, payload: { url: media.url, is_reusable: true } } },
      "Meta no acepto el adjunto de Instagram",
    );
  }
  return lastMessageId || crypto.randomUUID();
}

async function runFollowUpNotifications() {
  const db = await readDb();
  const tags = new Map(normalizeCrmTags(db.crmTags).map((tag) => [tag.id, tag]));
  const today = todayInBusinessTimeZone();
  const now = new Date().toISOString();
  const groups = new Map<string, any[]>();

  for (const conversation of db.conversations as any[]) {
    const followUpAt = String(conversation.followUpAt || "");
    if (!followUpAt || followUpAt > today || conversation.followUpNotifiedAt) continue;
    const tagIds = normalizeTagIds(conversation.tags);
    const followUpTag = tagIds.map((tagId) => tags.get(tagId)).find((tag) => tag?.action === "followup");
    const notifyPhone = normalizePhone(conversation.followUpContact || followUpTag?.notifyPhone || Deno.env.get("FOLLOWUP_NOTIFY_PHONE") || "");
    if (!notifyPhone) continue;
    const bucket = groups.get(notifyPhone) || [];
    bucket.push({ ...conversation, followUpTagName: followUpTag?.name || "" });
    groups.set(notifyPhone, bucket);
  }

  const results = [];
  const notified = [];
  for (const [notifyPhone, conversations] of groups) {
    const lines = conversations.slice(0, 20).map((conversation) => {
      const name = conversation.name || conversation.phone || conversation.contactId;
      const source = conversation.ad || conversation.campaign || conversation.adId || "Sin anuncio";
      const note = conversation.followUpNote ? ` - ${conversation.followUpNote}` : "";
      return `- ${name} (${conversation.phone || conversation.contactId}) | ${source}${note}`;
    });
    const textBody = [
      "CRM Bormex: contactos que necesitan retroalimentacion.",
      ...lines,
      conversations.length > lines.length ? `+ ${conversations.length - lines.length} contactos mas.` : "",
    ].filter(Boolean).join("\n");
    try {
      const messageId = await sendWhatsAppText(notifyPhone, textBody);
      results.push({ notifyPhone: maskValue(notifyPhone), ok: true, messageId, conversations: conversations.length });
      notified.push(...conversations);
    } catch (error) {
      results.push({ notifyPhone: maskValue(notifyPhone), ok: false, error: error instanceof Error ? error.message : "No se pudo avisar", conversations: conversations.length });
    }
  }

  if (notified.length) {
    await upsertItems("conversations", notified.map((conversation) => ({ ...conversation, followUpNotifiedAt: now })));
  }
  return {
    ok: results.every((result) => result.ok !== false),
    checkedAt: now,
    due: [...groups.values()].reduce((sum, conversations) => sum + conversations.length, 0),
    notified: notified.length,
    results,
  };
}

async function verifyWhatsAppWebhook(url: URL) {
  const verifyTokens = await metaWebhookVerifyTokens();
  if (!verifyTokens.length) return text("Webhook sin configurar", 500);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token && verifyTokens.includes(token)) return text(challenge || "");
  return text("Forbidden", 403);
}

async function handleMetaOAuthCallback(url: URL) {
  const code = url.searchParams.get("code") || "";
  const error = url.searchParams.get("error") || "";
  const errorDescription = url.searchParams.get("error_description") || "";
  const assetParams = Object.fromEntries(
    ["business_id", "waba_id", "phone_number_id", "state"].map((key) => [key, url.searchParams.get(key) || ""]),
  );
  const setupResults = code ? await completeCoexistenceSetup(url) : null;

  await setSetting("lastMetaOAuthCallback", {
    at: new Date().toISOString(),
    hasCode: Boolean(code),
    codeLength: code.length,
    error,
    errorDescription,
    ...assetParams,
    setupResults,
  });

  const title = error ? "Meta devolvio un error" : code ? "Registro recibido" : "Callback recibido";
  const message = error
    ? errorDescription || error
    : code
      ? "Meta regreso correctamente al CRM. Ya puedes cerrar esta ventana y volver al panel. El CRM intento suscribir webhooks e iniciar la sincronizacion COEX."
      : "Meta regreso al CRM, pero no incluyo codigo de autorizacion.";

  return text(`${title}\n\n${message}`);
}

async function completeCoexistenceSetup(url: URL) {
  const results: Record<string, unknown> = {};
  try {
    results.subscriptions = await subscribeMetaWebhooks(url);
  } catch (error) {
    results.subscriptions = { ok: false, error: error instanceof Error ? error.message : "No se pudo suscribir Meta" };
  }
  try {
    results.sync = await initiateWhatsAppCoexistenceSync({ reason: "oauth_callback" });
  } catch (error) {
    results.sync = { ok: false, error: error instanceof Error ? error.message : "No se pudo iniciar sync COEX" };
  }
  return results;
}

async function getMetaSubscriptionDiagnostics() {
  const pages = await discoverMetaPages();
  const whatsappBusinessAccountId = Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID") || "";
  const whatsappToken = whatsappAccessToken();
  const settings = await readSettings();
  return {
    whatsapp: {
      configured: Boolean(whatsappBusinessAccountId && whatsappToken),
      businessAccountId: maskValue(whatsappBusinessAccountId),
      phoneNumberId: maskValue(Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || ""),
      phoneNumbers: whatsappBusinessAccountId && whatsappToken
        ? sanitizeWhatsAppPhoneNumbers(await safeGraphGet(`/${whatsappBusinessAccountId}/phone_numbers?fields=id,display_phone_number,verified_name,quality_rating,code_verification_status,name_status`, whatsappToken))
        : null,
      subscribedApps: whatsappBusinessAccountId && whatsappToken
        ? await safeGraphGet(`/${whatsappBusinessAccountId}/subscribed_apps?fields=whatsapp_business_api_data`, whatsappToken)
        : null,
    },
    pages: await Promise.all(
      pages.map(async (page) => ({
        id: maskValue(page.id),
        name: page.name,
        hasToken: Boolean(page.accessToken),
        instagramBusinessAccount: page.instagramBusinessAccount
          ? { id: maskValue(page.instagramBusinessAccount.id), username: page.instagramBusinessAccount.username || "" }
          : null,
        subscribedApps: page.accessToken ? await safeGraphGet(`/${page.id}/subscribed_apps`, page.accessToken) : null,
      })),
    ),
    configuredIds: {
      messengerPageId: maskValue(messengerPageId()),
      instagramAccountId: maskValue(instagramAccountId()),
    },
    lastMetaOAuthCallback: sanitizeMetaOAuthCallback(settings.lastMetaOAuthCallback),
    lastCoexistenceSync: sanitizeCoexistenceSync(settings.lastCoexistenceSync),
  };
}

async function getMetaCoexistenceSetup(requestUrl: URL) {
  const explicitAppId = metaAppId();
  const appId = explicitAppId || await inferMetaAppIdFromWaba();
  const configId = metaEmbeddedSignupConfigId();
  const callbackUrl = metaOAuthRedirectUrl(requestUrl);
  const missing = [
    appId ? "" : "META_APP_ID",
    configId ? "" : "META_EMBEDDED_SIGNUP_CONFIG_ID",
  ].filter(Boolean);
  const settings = await readSettings();
  const onboardingUrl = appId && configId ? buildWhatsAppBusinessAppOnboardingUrl(appId, configId, callbackUrl) : "";

  return {
    connectable: Boolean(onboardingUrl),
    appIdConfigured: Boolean(appId),
    appIdSource: explicitAppId ? "env" : appId ? "waba_subscribed_app" : "",
    configIdConfigured: Boolean(configId),
    missing,
    feature: "whatsapp_business_app_onboarding",
    callbackUrl,
    onboardingUrl,
    safety: "Usa Coexistence oficial. No migra ni desregistra el numero de WhatsApp Business App.",
    lastMetaOAuthCallback: sanitizeMetaOAuthCallback(settings.lastMetaOAuthCallback),
    lastCoexistenceSync: sanitizeCoexistenceSync(settings.lastCoexistenceSync),
  };
}

async function inferMetaAppIdFromWaba() {
  const whatsappBusinessAccountId = Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID") || "";
  const token = whatsappAccessToken();
  if (!whatsappBusinessAccountId || !token) return "";
  const payload = await safeGraphGet(`/${whatsappBusinessAccountId}/subscribed_apps?fields=whatsapp_business_api_data`, token);
  const app = payload?.data?.find((item: any) => item?.whatsapp_business_api_data?.id)?.whatsapp_business_api_data;
  return String(app?.id || "");
}

function buildWhatsAppBusinessAppOnboardingUrl(appId: string, configId: string, callbackUrl: string) {
  const url = new URL(`https://www.facebook.com/${graphVersion()}/dialog/oauth`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("override_default_response_type", "true");
  url.searchParams.set("config_id", configId);
  url.searchParams.set("scope", Deno.env.get("META_ONBOARDING_SCOPES") || "whatsapp_business_management,whatsapp_business_messaging,business_management");
  url.searchParams.set(
    "extras",
    JSON.stringify({
      feature: "whatsapp_embedded_signup",
      featureType: "whatsapp_business_app_onboarding",
      sessionInfoVersion: "3",
      setup: {
        external_business_id: Deno.env.get("META_EXTERNAL_BUSINESS_ID") || "bormex-ads-crm",
      },
    }),
  );
  return url.toString();
}

function metaOAuthRedirectUrl(requestUrl: URL) {
  return Deno.env.get("META_OAUTH_REDIRECT_URI") || absoluteWebhookUrl(requestUrl, "/oauth/meta");
}

function sanitizeMetaOAuthCallback(value: any) {
  if (!value || typeof value !== "object") return null;
  return {
    at: value.at || "",
    hasCode: Boolean(value.hasCode),
    codeLength: Number(value.codeLength || 0),
    error: value.error || "",
    errorDescription: value.errorDescription || "",
    businessId: maskValue(String(value.business_id || "")),
    wabaId: maskValue(String(value.waba_id || "")),
    phoneNumberId: maskValue(String(value.phone_number_id || "")),
    state: value.state ? "recibido" : "",
    setupResults: sanitizeSetupResults(value.setupResults),
  };
}

function sanitizeSetupResults(value: any) {
  if (!value || typeof value !== "object") return null;
  return {
    subscriptions: value.subscriptions
      ? {
          ok: Boolean(value.subscriptions.ok),
          results: Array.isArray(value.subscriptions.results)
            ? value.subscriptions.results.map((item: any) => ({
                channel: item.channel || "",
                target: item.target || "",
                callbackUrl: item.callbackUrl || "",
                ok: item.result?.ok !== false,
                error: item.result?.error || "",
              }))
            : [],
        }
      : null,
    sync: sanitizeCoexistenceSync(value.sync),
  };
}

function sanitizeCoexistenceSync(value: any) {
  if (!value || typeof value !== "object") return null;
  return {
    ok: Boolean(value.ok),
    at: value.at || "",
    phoneNumberId: value.phoneNumberId || "",
    syncTypes: Array.isArray(value.syncTypes) ? value.syncTypes.map((item: unknown) => String(item)) : [],
    results: Array.isArray(value.results)
      ? value.results.map((item: any) => ({
          syncType: item.syncType || "",
          ok: item.result?.ok !== false,
          requestId: item.result?.payload?.request_id || item.result?.payload?.requestId || "",
          error: item.result?.error || "",
        }))
      : [],
    skipped: Boolean(value.skipped),
    reason: value.reason || "",
  };
}

async function subscribeMetaWebhooks(requestUrl: URL) {
  const results = [];
  const whatsappBusinessAccountId = Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID") || "";
  if (whatsappBusinessAccountId && whatsappAccessToken()) {
    const callbackUrl = absoluteWebhookUrl(requestUrl, "/webhooks/whatsapp");
    results.push({
      channel: "whatsapp",
      target: maskValue(whatsappBusinessAccountId),
      callbackUrl,
      result: await safeGraphPostJson(`/${whatsappBusinessAccountId}/subscribed_apps`, whatsappAccessToken(), {
        override_callback_uri: callbackUrl,
        verify_token: metaWebhookVerifyToken(),
        subscribed_fields: "messages,history,smb_app_state_sync,smb_message_echoes,account_update",
      }),
    });
  } else {
    results.push({ channel: "whatsapp", target: "", result: { ok: false, error: "Falta WHATSAPP_BUSINESS_ACCOUNT_ID o token de WhatsApp" } });
  }

  const pages = await discoverMetaPages();
  for (const page of pages) {
    if (!page.accessToken) {
      results.push({ channel: "messenger_instagram", target: maskValue(page.id), result: { ok: false, error: "No hay page access token para suscribir la pagina" } });
      continue;
    }
    results.push({
      channel: "messenger_instagram",
      target: maskValue(page.id),
      name: page.name,
      instagramBusinessAccount: page.instagramBusinessAccount
        ? { id: maskValue(page.instagramBusinessAccount.id), username: page.instagramBusinessAccount.username || "" }
        : null,
      result: await safeGraphPost(`/${page.id}/subscribed_apps`, page.accessToken, {
        subscribed_fields: "messages,message_echoes,messaging_postbacks,messaging_referrals,message_reads,message_deliveries,messaging_seen",
      }),
    });
  }
  if (!pages.length) {
    results.push({ channel: "messenger_instagram", target: "", result: { ok: false, error: "No encontre paginas con el token actual" } });
  }

  return {
    ok: results.some((item) => item.result?.ok !== false),
    results,
    nextCheck: "/api/meta/subscriptions",
  };
}

async function initiateWhatsAppCoexistenceSync(options: any = {}) {
  const token = whatsappAccessToken();
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") || "";
  if (!token || !phoneNumberId) {
    throw new Error("Falta WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN/META_ACCESS_TOKEN para iniciar sync COEX");
  }

  const settings = await readSettings();
  const previous = sanitizeCoexistenceSync(settings.lastCoexistenceSync);
  if (previous?.ok && !options.force) {
    return { ...previous, skipped: true, reason: "La sincronizacion COEX ya se inicio correctamente; usa force=true solo si Meta te pidio reintentar." };
  }

  const requestedTypes = Array.isArray(options.syncTypes) && options.syncTypes.length
    ? options.syncTypes
    : ["smb_app_state_sync", "history"];
  const syncTypes = [...new Set(requestedTypes.map((item: unknown) => String(item)).filter(Boolean))];
  const results = [];
  for (const syncType of syncTypes) {
    results.push({
      syncType,
      result: await safeGraphPostJson(`/${phoneNumberId}/smb_app_data`, token, {
        messaging_product: "whatsapp",
        sync_type: syncType,
      }),
    });
  }

  const summary = {
    ok: results.some((item) => item.result?.ok !== false),
    at: new Date().toISOString(),
    phoneNumberId: maskValue(phoneNumberId),
    syncTypes,
    results,
  };
  await setSetting("lastCoexistenceSync", summary);
  return summary;
}

async function discoverMetaPages() {
  const explicitPageId = messengerPageId();
  const explicitToken = messengerAccessToken();
  const pages = new Map<string, { id: string; name: string; accessToken: string; instagramBusinessAccount?: { id: string; username?: string } }>();

  if (explicitPageId) {
    const pageInfo = explicitToken ? await safeGraphGet(`/${explicitPageId}?fields=id,name,instagram_business_account{id,username}`, explicitToken) : null;
    pages.set(explicitPageId, {
      id: explicitPageId,
      name: typeof pageInfo?.name === "string" ? pageInfo.name : "Pagina configurada",
      accessToken: explicitToken,
      instagramBusinessAccount: pageInfo?.instagram_business_account,
    });
  }

  for (const token of uniqueTokens([messengerAccessToken(), instagramAccessToken(), metaAdsAccessToken()])) {
    const payload = await safeGraphGet("/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&limit=100", token);
    addDiscoveredPages(pages, payload, token);

    for (const businessId of await discoverMetaBusinessIds(token)) {
      for (const edge of ["owned_pages", "client_pages"]) {
        const businessPages = await safeGraphGet(`/${businessId}/${edge}?fields=id,name,access_token,instagram_business_account{id,username}&limit=100`, token);
        addDiscoveredPages(pages, businessPages, token);
      }
    }
  }

  return [...pages.values()];
}

function addDiscoveredPages(
  pages: Map<string, { id: string; name: string; accessToken: string; instagramBusinessAccount?: { id: string; username?: string } }>,
  payload: any,
  fallbackToken: string,
) {
  for (const page of payload?.data || []) {
    if (!page?.id) continue;
    pages.set(String(page.id), {
      id: String(page.id),
      name: String(page.name || "Pagina"),
      accessToken: String(page.access_token || fallbackToken),
      instagramBusinessAccount: page.instagram_business_account,
    });
  }
}

async function discoverMetaBusinessIds(token: string) {
  const ids = new Set([
    Deno.env.get("META_BUSINESS_ID") || "",
    Deno.env.get("META_BUSINESS_ACCOUNT_ID") || "",
    Deno.env.get("BUSINESS_ID") || "",
  ].filter(Boolean));

  const payload = await safeGraphGet("/me/businesses?fields=id,name&limit=100", token);
  for (const business of payload?.data || []) {
    if (business?.id) ids.add(String(business.id));
  }

  const whatsappBusinessAccountId = Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID") || "";
  if (whatsappBusinessAccountId) {
    const waba = await safeGraphGet(`/${whatsappBusinessAccountId}?fields=owner_business{id,name}`, token);
    if (waba?.owner_business?.id) ids.add(String(waba.owner_business.id));
  }

  return [...ids];
}

function uniqueTokens(tokens: string[]) {
  return [...new Set(tokens.filter(Boolean))];
}

function sanitizeWhatsAppPhoneNumbers(payload: any) {
  if (!payload?.data) return payload;
  return {
    ...payload,
    data: payload.data.map((phone: any) => ({
      ...phone,
      id: maskValue(String(phone.id || "")),
      display_phone_number: maskValue(String(phone.display_phone_number || "")),
    })),
  };
}

async function safeGraphGet(path: string, token: string) {
  try {
    return await graphRequest(path, token, "GET");
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Error Graph API" };
  }
}

async function safeGraphPost(path: string, token: string, params: Record<string, string>) {
  try {
    const payload = await graphRequest(path, token, "POST", params);
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Error Graph API" };
  }
}

async function safeGraphPostJson(path: string, token: string, body: Record<string, string>) {
  try {
    const payload = await graphJsonRequest(path, token, "POST", body);
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Error Graph API" };
  }
}

async function graphRequest(path: string, token: string, method: "GET" | "POST", params: Record<string, string> = {}) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`https://graph.facebook.com/${graphVersion()}${cleanPath}`);
  url.searchParams.set("access_token", token);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url.toString(), { method });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `Graph API respondio ${response.status}`);
  return payload;
}

async function graphJsonRequest(path: string, token: string, method: "POST", body: Record<string, string>) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`https://graph.facebook.com/${graphVersion()}${cleanPath}`);
  url.searchParams.set("access_token", token);
  const response = await fetch(url.toString(), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || `Graph API respondio ${response.status}`);
  return payload;
}

function absoluteWebhookUrl(requestUrl: URL, path: string) {
  const configuredBase = Deno.env.get("BORMEX_FUNCTION_BASE_URL") || Deno.env.get("CRM_FUNCTION_BASE_URL") || "";
  const origin = requestUrl.origin.replace(/^http:/, "https:");
  const base = configuredBase || `${origin}${requestUrl.pathname.startsWith("/bormex-crm/") ? "/bormex-crm" : ""}`;
  return `${base.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function normalizeReferralAttribution(referral: any, source: string) {
  if (!referral || typeof referral !== "object") return {};
  const adId = normalizeAdId(
    referral.source_id ||
      referral.ad_id ||
      referral.ads_context_data?.ad_id ||
      referral.ads_context_data?.source_id ||
      referral.ctwa_ad_id ||
      "",
  );
  const ctwaClid = String(referral.ctwa_clid || referral.ctwa_clid_v2 || "");
  const sourceUrl = String(referral.source_url || referral.url || "");
  const ref = String(referral.ref || referral.referral_code || "");
  const campaign = String(referral.headline || referral.source || referral.type || (source.includes("whatsapp") ? "Click-to-WhatsApp" : "Click-to-Meta"));
  const ad = String(referral.body || referral.ad_title || referral.ads_context_data?.ad_title || sourceUrl || ref || adId || "");
  const hasAttribution = Boolean(adId || ctwaClid || sourceUrl || ref || referral.headline || referral.body || referral.ad_title);
  if (!hasAttribution) return {};
  return {
    adId,
    adset: String(referral.adset || referral.adset_name || ""),
    ad,
    campaign,
    campaignId: String(referral.campaign_id || ""),
    ctwaClid,
    sourceUrl,
    attributionSource: source,
  };
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
      const contactSyncItems = field.toLowerCase().includes("smb_app_state_sync") || value.smb_app_state_sync
        ? getWhatsAppContactSyncItems(value)
        : [];
      for (const contact of contactSyncItems) {
        const phone = normalizePhone(
          contact.wa_id ||
            contact.phone_number ||
            contact.contact_phone_number ||
            contact.CONTACT_PHONE_NUMBER ||
            contact.phone ||
            contact.number ||
            contact.id ||
            "",
        );
        if (!phone) continue;
        const name = contact.profile?.name || contact.full_name || contact.contact_full_name || contact.CONTACT_FULL_NAME || contact.name || phone;
        const at = timestampToIso(
          contact.timestamp || contact.change_timestamp || contact.contact_change_timestamp || contact.CONTACT_CHANGE_TIMESTAMP || contact.updated_at,
        );
        conversations.push({
          id: `whatsapp_${phone}`,
          channel: "whatsapp",
          contactId: phone,
          phone,
          name,
          lastMessage: contact.action === "remove" ? "Contacto eliminado en WhatsApp Business App" : "Contacto sincronizado desde WhatsApp Business App",
          lastAt: at,
          unread: 0,
        });
      }
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
        const referral = message.referral || message.context?.referral || {};
        const attribution = normalizeReferralAttribution(referral, "whatsapp_referral");
        conversations.push({
          id: conversationId,
          channel: "whatsapp",
          contactId: phone,
          phone,
          name: contact.profile?.name || phone,
          lastMessage: textBody,
          lastAt: at,
          unread: isEcho ? 0 : 1,
          ...attribution,
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
          ...attribution,
        });
        if (isEcho || !Object.keys(attribution).length) continue;
        leads.push({
          id: `wa_${message.id || crypto.randomUUID()}`,
          source: "whatsapp_cloud",
          phone,
          campaign: attribution.campaign || referral.headline || "Click-to-WhatsApp",
          adset: attribution.adset || "",
          ad: attribution.ad || referral.body || referral.source_url || referral.source_id || "Anuncio WhatsApp",
          adId: attribution.adId || referral.source_id || "",
          ctwaClid: attribution.ctwaClid || referral.ctwa_clid || "",
          date: timestampToDate(message.timestamp),
          message: textBody,
        });
      }
    }
  }
  return { leads, conversations, messages };
}

function getWhatsAppContactSyncItems(value: any) {
  const candidates = [
    value.contacts,
    value.contact,
    value.smb_app_state_sync?.contacts,
    value.smb_app_state_sync?.data?.contacts,
    value.smb_app_state_sync?.payload?.contacts,
  ];
  return candidates.flatMap((candidate) => {
    if (Array.isArray(candidate)) return candidate;
    if (candidate && typeof candidate === "object") return [candidate];
    return [];
  }).filter((contact) => {
    if (!contact || typeof contact !== "object") return false;
    const hasPhone = Boolean(contact.wa_id || contact.phone_number || contact.contact_phone_number || contact.CONTACT_PHONE_NUMBER || contact.phone || contact.number);
    const hasSyncShape = Boolean(contact.action || contact.ACTION || contact.full_name || contact.contact_full_name || contact.CONTACT_FULL_NAME || contact.profile?.name);
    return hasPhone && hasSyncShape;
  });
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
  const conversations = [];
  const messages = [];
  for (const entry of payload.entry || []) {
    for (const event of entry.messaging || []) {
      const channel = getMetaMessagingChannel(payload, entry, event);
      const sender = String(event.sender?.id || "");
      const recipient = String(event.recipient?.id || "");
      if (!sender || (!event.message && !event.postback && !event.referral)) continue;
      const isEcho = isMetaMessageEcho(entry, event, channel);
      const contactId = isEcho ? recipient : sender;
      if (!contactId) continue;
      const conversationId = `${channel}_${contactId}`;
      const textBody = extractMetaMessageText(event);
      const at = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
      const referral = event.referral || event.message?.referral || event.postback?.referral || {};
      const attribution = normalizeReferralAttribution(referral, `${channel}_referral`);
      conversations.push({
        id: conversationId,
        channel,
        contactId,
        phone: "",
        name: contactId,
        lastMessage: textBody,
        lastAt: at,
        unread: isEcho ? 0 : 1,
        ...attribution,
      });
      messages.push({
        id: event.message?.mid || event.postback?.mid || crypto.randomUUID(),
        conversationId,
        channel,
        direction: isEcho ? "outbound" : "inbound",
        from: sender,
        to: recipient,
        text: textBody,
        at,
        status: isEcho ? "sent" : "received",
        attachments: extractMetaMessageAttachments(event.message || {}),
        referral: event.referral || event.message?.referral || null,
        ...attribution,
      });
    }
  }
  return { conversations, messages };
}

function getMetaMessagingChannel(payload: any, entry: any, event: any) {
  const object = String(payload.object || "").toLowerCase();
  if (object.includes("instagram")) return "instagram";
  if (event.message?.is_echo && instagramAccountId() && String(event.sender?.id || "") === instagramAccountId()) return "instagram";
  if (instagramAccountId() && String(entry.id || "") === instagramAccountId()) return "instagram";
  return "messenger";
}

function isMetaMessageEcho(entry: any, event: any, channel: string) {
  const sender = String(event.sender?.id || "");
  const recipient = String(event.recipient?.id || "");
  const businessId = channel === "instagram" ? instagramAccountId() : messengerPageId();
  return Boolean(
    event.message?.is_echo === true ||
      event.message?.app_id ||
      (businessId && sender === businessId) ||
      (entry.id && sender === String(entry.id) && recipient),
  );
}

function extractMetaMessageText(event: any) {
  if (event.message?.text) return event.message.text;
  if (event.postback?.title) return event.postback.title;
  if (event.postback?.payload) return event.postback.payload;
  if (event.message?.quick_reply?.payload) return event.message.quick_reply.payload;
  if (event.message?.attachments?.length) return `[${event.message.attachments.map((item: any) => item.type || "archivo").join(", ")}]`;
  return "[mensaje sin texto]";
}

function extractMetaMessageAttachments(message: any) {
  return (message.attachments || []).map((attachment: any) => ({
    type: attachment.type || "",
    url: attachment.payload?.url || "",
    title: attachment.title || "",
  }));
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
    sourceConversationId: String(body.sourceConversationId || ""),
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

function metaAppId() {
  return Deno.env.get("META_APP_ID") || Deno.env.get("FACEBOOK_APP_ID") || Deno.env.get("WHATSAPP_APP_ID") || Deno.env.get("META_CLIENT_ID") || "";
}

function metaEmbeddedSignupConfigId() {
  return (
    Deno.env.get("META_EMBEDDED_SIGNUP_CONFIG_ID") ||
    Deno.env.get("WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID") ||
    Deno.env.get("WHATSAPP_BUSINESS_APP_ONBOARDING_CONFIG_ID") ||
    Deno.env.get("META_LOGIN_CONFIG_ID") ||
    "937228176021764"
  );
}

function metaWebhookVerifyToken() {
  return Deno.env.get("META_WEBHOOK_VERIFY_TOKEN") || Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "";
}

async function metaWebhookVerifyTokens() {
  const tokens = new Set<string>();
  const envToken = metaWebhookVerifyToken().trim();
  if (envToken) tokens.add(envToken);

  try {
    const settings = await readSettings();
    for (const token of normalizeWebhookVerifyTokens(settings.additionalWebhookVerifyTokens)) {
      tokens.add(token);
    }
  } catch {
    // Keep the public webhook handshake resilient if the settings table is temporarily unavailable.
  }

  return [...tokens];
}

async function saveAdditionalWebhookVerifyToken(body: any) {
  const token = String(body.token || "").trim();
  if (token.length < 8) throw new HttpError(400, "El verify token debe tener al menos 8 caracteres");

  const settings = await readSettings();
  const tokens = new Set(normalizeWebhookVerifyTokens(settings.additionalWebhookVerifyTokens));
  tokens.add(token);
  await setSetting("additionalWebhookVerifyTokens", [...tokens]);

  return {
    ok: true,
    tokenConfigured: true,
    count: tokens.size,
  };
}

function normalizeWebhookVerifyTokens(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (typeof value === "string") return [value.trim()].filter(Boolean);
  return [];
}

function metaAppSecret() {
  return Deno.env.get("META_APP_SECRET") || Deno.env.get("FACEBOOK_APP_SECRET") || "";
}

function metaAdsAccessToken() {
  return Deno.env.get("META_ADS_ACCESS_TOKEN") || Deno.env.get("META_ACCESS_TOKEN") || "";
}

function whatsappAccessToken() {
  return Deno.env.get("WHATSAPP_ACCESS_TOKEN") || Deno.env.get("META_ACCESS_TOKEN") || "";
}

function messengerAccessToken() {
  return Deno.env.get("MESSENGER_PAGE_ACCESS_TOKEN") || Deno.env.get("META_PAGE_ACCESS_TOKEN") || Deno.env.get("META_ACCESS_TOKEN") || "";
}

function messengerPageId() {
  return Deno.env.get("MESSENGER_PAGE_ID") || Deno.env.get("FACEBOOK_PAGE_ID") || Deno.env.get("META_PAGE_ID") || "";
}

function instagramAccessToken() {
  return Deno.env.get("INSTAGRAM_ACCESS_TOKEN") || Deno.env.get("META_INSTAGRAM_ACCESS_TOKEN") || Deno.env.get("META_PAGE_ACCESS_TOKEN") || Deno.env.get("META_ACCESS_TOKEN") || "";
}

function instagramAccountId() {
  return Deno.env.get("INSTAGRAM_ACCOUNT_ID") || Deno.env.get("INSTAGRAM_BUSINESS_ACCOUNT_ID") || Deno.env.get("META_INSTAGRAM_ACCOUNT_ID") || Deno.env.get("IG_ID") || "";
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
    if (Array.isArray(entry.messaging)) fields.add("messaging");
  }
  return [...fields];
}

function summarizeWebhookPayload(body: any) {
  return {
    entryIds: (body.entry || []).map((entry: any) => entry.id).filter(Boolean).slice(0, 5),
    messagingSenders: (body.entry || [])
      .flatMap((entry: any) => entry.messaging || [])
      .map((event: any) => event.sender?.id)
      .filter(Boolean)
      .slice(0, 5),
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

async function readVerifiedMetaJson(req: Request) {
  const textBody = await req.text();
  await verifyMetaSignature(req, textBody);
  return textBody ? JSON.parse(textBody) : {};
}

async function verifyMetaSignature(req: Request, rawBody: string) {
  const secret = metaAppSecret();
  if (!secret) return;

  const signature = req.headers.get("x-hub-signature-256") || "";
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) {
    throw new HttpError(403, "Firma de Meta faltante");
  }

  const expected = hexToBytes(signature.slice(prefix.length));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const actual = new Uint8Array(signed);
  if (!constantTimeEqual(actual, expected)) {
    throw new HttpError(403, "Firma de Meta no coincide");
  }
}

function hexToBytes(hex: string) {
  if (!/^[a-f0-9]+$/i.test(hex) || hex.length % 2 !== 0) {
    throw new HttpError(403, "Firma de Meta invalida");
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
  }
  return bytes;
}

function constantTimeEqual(actual: Uint8Array, expected: Uint8Array) {
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let index = 0; index < actual.length; index += 1) {
    diff |= actual[index] ^ expected[index];
  }
  return diff === 0;
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
