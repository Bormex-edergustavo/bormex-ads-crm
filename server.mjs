import http from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, createReadStream, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const dataDir = join(root, "data");
const dbPath = join(dataDir, "db.json");
const envPath = join(root, ".env");

loadEnvFile();

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || "127.0.0.1";
const DEFAULT_GRAPH_VERSION = process.env.META_GRAPH_VERSION || "v24.0";
const ADS_SYNC_INTERVAL_MS = Number(process.env.ADS_SYNC_INTERVAL_MINUTES || 15) * 60 * 1000;

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

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
  lastAdsSync: null,
  lastAdsRange: null,
  lastWebhookAt: null,
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const accessRole = getAccessRole(req);

    if (!isPublicPath(url.pathname) && !accessRole) {
      return unauthorized(res);
    }
    if (!isPublicPath(url.pathname) && !isPathAllowed(url.pathname, req.method, accessRole)) {
      return text(res, "Acceso no permitido para este usuario", 403);
    }

    if (url.pathname === "/api/config" && req.method === "POST") {
      const body = await readJson(req);
      await saveRuntimeConfig(body);
      return json(res, {
        metaAdsConfigured: Boolean(metaAdsAccessToken() && process.env.META_AD_ACCOUNT_ID),
        whatsappWebhookConfigured: Boolean(metaWebhookVerifyToken()),
        whatsappPhoneConfigured: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID),
        whatsappApiConfigured: Boolean(whatsappAccessToken() && process.env.WHATSAPP_PHONE_NUMBER_ID),
        whatsappCoexistenceReady: Boolean(metaWebhookVerifyToken() && whatsappAccessToken() && process.env.WHATSAPP_PHONE_NUMBER_ID),
        webhookSignatureConfigured: Boolean(metaAppSecret()),
        messengerWebhookConfigured: Boolean(metaWebhookVerifyToken()),
        messengerApiConfigured: Boolean(messengerAccessToken()),
        messengerPageConfigured: Boolean(messengerPageId()),
        instagramWebhookConfigured: Boolean(metaWebhookVerifyToken()),
        instagramApiConfigured: Boolean(instagramAccessToken()),
        instagramAccountConfigured: Boolean(instagramAccountId()),
        adAccountId: maskValue(process.env.META_AD_ACCOUNT_ID),
        webhookPath: "/webhooks/whatsapp",
        metaWebhookPath: "/webhooks/meta",
        graphVersion: graphVersion(),
        panelAuthConfigured: Boolean(process.env.PANEL_PASSWORD),
        adsSyncIntervalMinutes: Math.round(ADS_SYNC_INTERVAL_MS / 60000),
        role: accessRole,
      });
    }

    if (url.pathname === "/api/config") {
      return json(res, {
        metaAdsConfigured: Boolean(metaAdsAccessToken() && process.env.META_AD_ACCOUNT_ID),
        whatsappWebhookConfigured: Boolean(metaWebhookVerifyToken()),
        whatsappPhoneConfigured: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID),
        whatsappApiConfigured: Boolean(whatsappAccessToken() && process.env.WHATSAPP_PHONE_NUMBER_ID),
        whatsappCoexistenceReady: Boolean(metaWebhookVerifyToken() && whatsappAccessToken() && process.env.WHATSAPP_PHONE_NUMBER_ID),
        webhookSignatureConfigured: Boolean(metaAppSecret()),
        messengerWebhookConfigured: Boolean(metaWebhookVerifyToken()),
        messengerApiConfigured: Boolean(messengerAccessToken()),
        messengerPageConfigured: Boolean(messengerPageId()),
        instagramWebhookConfigured: Boolean(metaWebhookVerifyToken()),
        instagramApiConfigured: Boolean(instagramAccessToken()),
        instagramAccountConfigured: Boolean(instagramAccountId()),
        adAccountId: maskValue(process.env.META_AD_ACCOUNT_ID),
        webhookPath: "/webhooks/whatsapp",
        metaWebhookPath: "/webhooks/meta",
        graphVersion: graphVersion(),
        panelAuthConfigured: Boolean(process.env.PANEL_PASSWORD),
        adsSyncIntervalMinutes: Math.round(ADS_SYNC_INTERVAL_MS / 60000),
        role: accessRole,
      });
    }

    if (url.pathname === "/api/state") {
      return json(res, filterStateForRole(await readDb(), accessRole));
    }

    if (url.pathname === "/api/ads-range" && req.method === "POST") {
      return json(res, await syncMetaAds(await readJson(req)));
    }

    if (url.pathname === "/api/messages" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const message = await sendCrmMessage(body);
      db.conversations = upsertById(db.conversations, [message.conversation]);
      db.messages = upsertById(db.messages, [message.record]);
      await writeDb(db);
      return json(res, db);
    }

    if (url.pathname === "/api/sync/ads" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const payload = await syncMetaAds(body);
      db.ads = payload.ads;
      db.spend = payload.spend;
      db.lastAdsSync = new Date().toISOString();
      db.lastAdsRange = payload.range;
      await writeDb(db);
      return json(res, db);
    }

    if (url.pathname === "/api/sales" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const sale = normalizeSale(body);
      db.sales = upsertById(db.sales, [sale]);
      await writeDb(db);
      return json(res, filterStateForRole(db, accessRole));
    }

    if (url.pathname.startsWith("/api/sales/") && req.method === "DELETE") {
      const id = decodeURIComponent(url.pathname.replace("/api/sales/", ""));
      const db = await readDb();
      db.sales = db.sales.filter((sale) => sale.id !== id);
      await writeDb(db);
      return json(res, filterStateForRole(db, accessRole));
    }

    if (url.pathname === "/api/rules" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      db.rules = normalizeRules(body);
      await writeDb(db);
      return json(res, db);
    }

    if (url.pathname === "/api/campaign-periods" && req.method === "POST") {
      const body = await readJson(req);
      const rows = Array.isArray(body.periods) ? body.periods : [];
      const db = await readDb();
      db.campaignPeriods = rows.map(normalizeCampaignPeriod);
      await writeDb(db);
      return json(res, db);
    }

    if (url.pathname === "/api/import" && req.method === "POST") {
      const body = await readJson(req);
      const db = await readDb();
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (body.type === "sales") db.sales = upsertById(db.sales, rows.map(normalizeSale));
      if (body.type === "leads") db.leads = upsertLeads(db.leads, rows.map(normalizeLead));
      if (body.type === "spend") db.spend = upsertById(db.spend, rows.map(normalizeSpend));
      await writeDb(db);
      return json(res, db);
    }

    if (url.pathname.startsWith("/api/records/") && req.method === "DELETE") {
      const [, , , collection, rawId] = url.pathname.split("/");
      if (!["sales", "leads", "spend"].includes(collection)) return text(res, "Not found", 404);
      const db = await readDb();
      const id = decodeURIComponent(rawId || "");
      db[collection] = db[collection].filter((item) => item.id !== id);
      await writeDb(db);
      return json(res, filterStateForRole(db, accessRole));
    }

    if (url.pathname === "/webhooks/whatsapp" && req.method === "GET") {
      return verifyWhatsAppWebhook(url, res);
    }

    if (url.pathname === "/webhooks/whatsapp" && req.method === "POST") {
      const body = await readVerifiedMetaJson(req);
      const db = await readDb();
      const payload = extractWhatsAppEvents(body);
      db.leads = upsertLeads(db.leads, payload.leads);
      db.conversations = upsertById(db.conversations, payload.conversations);
      db.messages = upsertById(db.messages, payload.messages);
      db.lastWebhookAt = new Date().toISOString();
      await writeDb(db);
      return json(res, { ok: true, leads: payload.leads.length, messages: payload.messages.length });
    }

    if (url.pathname === "/webhooks/meta" && req.method === "GET") {
      return verifyWhatsAppWebhook(url, res);
    }

    if (url.pathname === "/webhooks/meta" && req.method === "POST") {
      const body = await readVerifiedMetaJson(req);
      const db = await readDb();
      const payload = extractMetaMessagingEvents(body);
      db.conversations = upsertById(db.conversations, payload.conversations);
      db.messages = upsertById(db.messages, payload.messages);
      db.lastWebhookAt = new Date().toISOString();
      await writeDb(db);
      return json(res, { ok: true, messages: payload.messages.length });
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    return json(res, { error: error.message || "Error interno" }, error.status || 500);
  }
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

server.listen(PORT, HOST, () => {
  console.log(`Ventas Ads listo en http://${HOST}:${PORT}`);
});

setInterval(() => {
  syncMetaAdsIntoDb().catch((error) => {
    console.error(`No se pudo sincronizar Meta Ads: ${error.message}`);
  });
}, ADS_SYNC_INTERVAL_MS).unref();

setTimeout(() => {
  syncMetaAdsIntoDb().catch((error) => {
    console.error(`Sincronización inicial omitida: ${error.message}`);
  });
}, 2500).unref();

function loadEnvFile() {
  if (!existsSync(envPath)) return;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#") || !clean.includes("=")) continue;
    const [key, ...rest] = clean.split("=");
    if (!process.env[key]) process.env[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
}

async function saveRuntimeConfig(body) {
  const current = readCurrentEnv();
  const next = {
    ...current,
    PORT: String(PORT),
    HOST,
    META_GRAPH_VERSION: String(body.graphVersion || current.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION),
    META_AD_ACCOUNT_ID: String(body.adAccountId || current.META_AD_ACCOUNT_ID || "").trim(),
    META_ADS_ACCESS_TOKEN: String(body.metaAdsAccessToken || current.META_ADS_ACCESS_TOKEN || "").trim(),
    META_ACCESS_TOKEN: String(body.metaAccessToken || current.META_ACCESS_TOKEN || "").trim(),
    WHATSAPP_ACCESS_TOKEN: String(body.whatsappAccessToken || current.WHATSAPP_ACCESS_TOKEN || "").trim(),
    WHATSAPP_VERIFY_TOKEN: String(body.whatsappVerifyToken || current.WHATSAPP_VERIFY_TOKEN || "").trim(),
    WHATSAPP_BUSINESS_ACCOUNT_ID: String(body.whatsappBusinessAccountId || current.WHATSAPP_BUSINESS_ACCOUNT_ID || "").trim(),
    WHATSAPP_PHONE_NUMBER_ID: String(body.whatsappPhoneNumberId || current.WHATSAPP_PHONE_NUMBER_ID || "").trim(),
    PANEL_USERNAME: String(body.panelUsername || current.PANEL_USERNAME || "eder").trim(),
    PANEL_PASSWORD: String(body.panelPassword || current.PANEL_PASSWORD || "").trim(),
  };

  for (const [key, value] of Object.entries(next)) {
    if (value) process.env[key] = value;
  }

  const lines = Object.entries(next)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${quoteEnv(value)}`);
  await writeFile(envPath, `${lines.join("\n")}\n`);
}

function readCurrentEnv() {
  if (!existsSync(envPath)) return {};
  const values = {};
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const clean = line.trim();
    if (!clean || clean.startsWith("#") || !clean.includes("=")) continue;
    const [key, ...rest] = clean.split("=");
    values[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

function quoteEnv(value) {
  return String(value).replaceAll("\n", "").replaceAll('"', '\\"');
}

function maskValue(value) {
  if (!value) return "";
  const text = String(value);
  if (text.length <= 8) return "configurado";
  return `${text.slice(0, 4)}...${text.slice(-4)}`;
}

function graphVersion() {
  return process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
}

function metaAdsAccessToken() {
  return process.env.META_ADS_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || "";
}

function metaWebhookVerifyToken() {
  return process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.WHATSAPP_VERIFY_TOKEN || "";
}

function metaAppSecret() {
  return process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET || "";
}

function whatsappAccessToken() {
  return process.env.WHATSAPP_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || "";
}

function messengerAccessToken() {
  return process.env.MESSENGER_PAGE_ACCESS_TOKEN || process.env.META_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || "";
}

function messengerPageId() {
  return process.env.MESSENGER_PAGE_ID || process.env.FACEBOOK_PAGE_ID || process.env.META_PAGE_ID || "";
}

function instagramAccessToken() {
  return process.env.INSTAGRAM_ACCESS_TOKEN || process.env.META_INSTAGRAM_ACCESS_TOKEN || process.env.META_PAGE_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || "";
}

function instagramAccountId() {
  return process.env.INSTAGRAM_ACCOUNT_ID || process.env.INSTAGRAM_BUSINESS_ACCOUNT_ID || process.env.META_INSTAGRAM_ACCOUNT_ID || process.env.IG_ID || "";
}

function isPublicPath(pathname) {
  return pathname === "/webhooks/whatsapp" || pathname === "/webhooks/meta";
}

function getAccessRole(req) {
  if (!process.env.PANEL_PASSWORD) return "ads";
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return "";
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  const expectedUser = process.env.PANEL_USERNAME || "";
  const userMatches = expectedUser ? username === expectedUser : true;
  if (!userMatches) return "";
  if (password === process.env.PANEL_PASSWORD) return "ads";
  if (password === (process.env.SALES_PANEL_PASSWORD || "1234")) return "sales";
  return "";
}

function isPathAllowed(pathname, method, role) {
  if (role === "ads") return true;
  if (role !== "sales") return false;
  if (method === "GET" && ["/", "/index.html", "/styles.css", "/app.js", "/privacy.html"].includes(pathname)) return true;
  if (method === "GET" && ["/api/config", "/api/state"].includes(pathname)) return true;
  if (method === "POST" && pathname === "/api/sales") return true;
  if (method === "DELETE" && pathname.startsWith("/api/sales/")) return true;
  if (method === "DELETE" && pathname.startsWith("/api/records/sales/")) return true;
  return false;
}

function filterStateForRole(db, role) {
  if (role !== "sales") return db;
  return {
    ...structuredClone(defaultDb),
    sales: db.sales || [],
    rules: db.rules || defaultDb.rules,
  };
}

function unauthorized(res) {
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Ventas Ads"',
  });
  res.end("Autenticación requerida");
}

async function readDb() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(dbPath)) {
    await writeDb(defaultDb);
    return structuredClone(defaultDb);
  }
  return { ...structuredClone(defaultDb), ...JSON.parse(await readFile(dbPath, "utf8")) };
}

async function writeDb(db) {
  await mkdir(dataDir, { recursive: true });
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

async function syncMetaAds(options = {}) {
  const token = metaAdsAccessToken();
  const rawAccountId = process.env.META_AD_ACCOUNT_ID;
  if (!token || !rawAccountId) {
    throw new Error("Faltan META_ADS_ACCESS_TOKEN/META_ACCESS_TOKEN y META_AD_ACCOUNT_ID en .env");
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
    .map((ad) => normalizeMetaAd(ad, range))
    .filter((ad) => ad.effectiveStatus === "ACTIVE" || Number(ad.spend || 0) > 0 || Number(ad.messages || 0) > 0);
  const spend = normalizedAds.map((ad) => ({
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

function normalizeSyncRange(options) {
  const today = todayInBusinessTimeZone();
  const since = validDate(options?.since || options?.startDate) || today;
  const until = validDate(options?.until || options?.endDate) || since;
  if (since > until) throw new Error("La fecha de inicio no puede ser mayor que la fecha fin");
  return { since, until };
}

function validDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

async function syncMetaAdsIntoDb() {
  if (!metaAdsAccessToken() || !process.env.META_AD_ACCOUNT_ID) return null;
  const db = await readDb();
  const payload = await syncMetaAds();
  db.ads = payload.ads;
  db.spend = payload.spend;
  db.lastAdsSync = new Date().toISOString();
  db.lastAdsRange = payload.range;
  await writeDb(db);
  return db;
}

async function fetchAllPages(firstUrl) {
  const rows = [];
  let next = firstUrl.toString();
  while (next) {
    const response = await fetch(next);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error?.message || `Meta API respondió ${response.status}`);
    }
    rows.push(...(payload.data || []));
    next = payload.paging?.next || "";
  }
  return rows;
}

function normalizeMetaAd(ad, range) {
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

function businessTimeZone() {
  return process.env.BUSINESS_TIME_ZONE || process.env.ADS_TIME_ZONE || "America/Mexico_City";
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

function pickActionValue(actions, actionTypes) {
  for (const actionType of actionTypes) {
    const found = actions.find((item) => item.action_type === actionType);
    if (found) return Number(found.value || 0);
  }
  return 0;
}

function centsToMoney(value) {
  const amount = Number(value || 0);
  return amount ? amount / 100 : 0;
}

function verifyWhatsAppWebhook(url, res) {
  const verifyToken = metaWebhookVerifyToken();
  if (!verifyToken) return text(res, "Webhook sin configurar", 500);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === verifyToken) return text(res, challenge || "");
  return text(res, "Forbidden", 403);
}

async function sendCrmMessage(body) {
  const channel = String(body.channel || "").trim();
  const conversationId = String(body.conversationId || "").trim();
  const to = normalizeChannelRecipient(channel, body.to || body.phone || body.contactId || "");
  const textBody = String(body.text || "").trim();
  if (!channel || !conversationId || !to || !textBody) {
    throw new Error("Faltan datos para enviar el mensaje");
  }

  let providerMessageId = `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  if (channel === "whatsapp") {
    providerMessageId = await sendWhatsAppText(to, textBody);
  } else if (channel === "messenger") {
    providerMessageId = await sendMessengerText(to, textBody);
  } else if (channel === "instagram") {
    providerMessageId = await sendInstagramText(to, textBody);
  } else {
    throw new Error(`Canal no soportado: ${channel}`);
  }

  const now = new Date().toISOString();
  return {
    conversation: {
      id: conversationId,
      channel,
      contactId: to,
      phone: channel === "whatsapp" ? to : "",
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
      from: channelSenderId(channel),
      to,
      text: textBody,
      at: now,
      status: "sent",
    },
  };
}

function normalizeChannelRecipient(channel, value) {
  if (channel === "whatsapp") return normalizePhone(value);
  return String(value || "").trim();
}

function channelSenderId(channel) {
  if (channel === "whatsapp") return process.env.WHATSAPP_PHONE_NUMBER_ID || process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || "crm";
  if (channel === "messenger") return messengerPageId() || "page";
  if (channel === "instagram") return instagramAccountId() || "instagram";
  return "crm";
}

async function sendWhatsAppText(to, textBody) {
  const token = whatsappAccessToken();
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneNumberId) {
    throw new Error("Falta WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_ACCESS_TOKEN/META_ACCESS_TOKEN para enviar WhatsApp");
  }
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
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
  return payload.messages?.[0]?.id || `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function sendMessengerText(to, textBody) {
  const token = messengerAccessToken();
  if (!token) throw new Error("Falta MESSENGER_PAGE_ACCESS_TOKEN o META_PAGE_ACCESS_TOKEN para Messenger");
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/me/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_type: "RESPONSE",
      recipient: { id: to },
      message: { text: textBody },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Meta no acepto el mensaje de Messenger");
  return payload.message_id || `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function sendInstagramText(to, textBody) {
  const token = instagramAccessToken();
  if (!token) throw new Error("Falta INSTAGRAM_ACCESS_TOKEN o META_INSTAGRAM_ACCESS_TOKEN para Instagram");
  const accountId = instagramAccountId() || "me";
  const response = await fetch(`https://graph.instagram.com/${graphVersion()}/${accountId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      recipient: { id: to },
      message: { text: textBody },
    }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const fallbackToken = messengerAccessToken();
    if (fallbackToken && fallbackToken !== token) return sendInstagramTextViaMessengerApi(to, textBody, fallbackToken);
    throw new Error(payload.error?.message || "Meta no acepto el mensaje de Instagram");
  }
  return payload.message_id || payload.messages?.[0]?.id || `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

async function sendInstagramTextViaMessengerApi(to, textBody, token) {
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/me/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messaging_type: "RESPONSE",
      recipient: { id: to },
      message: { text: textBody },
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error?.message || "Meta no acepto el mensaje de Instagram");
  return payload.message_id || `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function extractWhatsAppEvents(payload) {
  const leads = [];
  const conversations = [];
  const messages = [];
  const entries = payload.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const field = String(change.field || "messages");
      const value = change.value || {};
      const businessPhone = normalizePhone(value.metadata?.display_phone_number || process.env.WHATSAPP_DISPLAY_PHONE_NUMBER || "");
      const contacts = new Map((value.contacts || []).map((contact) => [contact.wa_id, contact]));
      for (const message of getWhatsAppMessageItems(value)) {
        const fromPhone = normalizePhone(message.from || message.sender?.wa_id || message.sender?.id || "");
        const toPhone = normalizePhone(message.to || message.recipient_id || message.recipient?.wa_id || message.recipient?.id || "");
        const isEcho = isWhatsAppEcho(message, field, fromPhone, businessPhone);
        const phone = isEcho ? toPhone || fromPhone : fromPhone || toPhone;
        if (!phone) continue;
        const contact = contacts.get(phone) || contacts.get(message.from) || {};
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
          id: message.id || `wa_${Date.now()}_${Math.random().toString(16).slice(2)}`,
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
          id: `wa_${message.id || Date.now()}`,
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

function getWhatsAppMessageItems(value) {
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

function collectNestedWhatsAppMessages(root) {
  const found = new Map();
  const visit = (node, depth = 0) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1);
      return;
    }
    if (typeof node !== "object") return;
    if (looksLikeWhatsAppMessage(node)) {
      found.set(String(node.id || `${node.from || ""}_${node.to || ""}_${node.timestamp || Math.random()}`), node);
    }
    for (const value of Object.values(node)) visit(value, depth + 1);
  };
  visit(root);
  return [...found.values()];
}

function looksLikeWhatsAppMessage(value) {
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

function isWhatsAppEcho(message, field, fromPhone, businessPhone) {
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

function extractMetaMessagingEvents(payload) {
  const conversations = [];
  const messages = [];
  for (const entry of payload.entry || []) {
    for (const event of entry.messaging || []) {
      const channel = getMetaMessagingChannel(payload, entry, event);
      const sender = String(event.sender?.id || "");
      const recipient = String(event.recipient?.id || "");
      if (!sender || (!event.message && !event.postback)) continue;
      const isEcho = isMetaMessageEcho(entry, event, channel);
      const contactId = isEcho ? recipient : sender;
      if (!contactId) continue;
      const conversationId = `${channel}_${contactId}`;
      const textBody = extractMetaMessageText(event);
      const at = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString();
      conversations.push({
        id: conversationId,
        channel,
        contactId,
        phone: "",
        name: contactId,
        lastMessage: textBody,
        lastAt: at,
        unread: isEcho ? 0 : 1,
      });
      messages.push({
        id: event.message?.mid || event.postback?.mid || `msg_${Date.now()}_${Math.random().toString(16).slice(2)}`,
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
      });
    }
  }
  return { conversations, messages };
}

function getMetaMessagingChannel(payload, entry, event) {
  const object = String(payload.object || "").toLowerCase();
  if (object.includes("instagram")) return "instagram";
  if (event.message?.is_echo && instagramAccountId() && String(event.sender?.id || "") === instagramAccountId()) return "instagram";
  if (instagramAccountId() && String(entry.id || "") === instagramAccountId()) return "instagram";
  return "messenger";
}

function isMetaMessageEcho(entry, event, channel) {
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

function extractMetaMessageText(event) {
  if (event.message?.text) return event.message.text;
  if (event.postback?.title) return event.postback.title;
  if (event.postback?.payload) return event.postback.payload;
  if (event.message?.quick_reply?.payload) return event.message.quick_reply.payload;
  if (event.message?.attachments?.length) return `[${event.message.attachments.map((item) => item.type || "archivo").join(", ")}]`;
  return "[mensaje sin texto]";
}

function extractMetaMessageAttachments(message) {
  return (message.attachments || []).map((attachment) => ({
    type: attachment.type || "",
    url: attachment.payload?.url || "",
    title: attachment.title || "",
  }));
}

function extractMessageText(message) {
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

function extractMessageAttachments(message) {
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

function upsertLeads(existing, incoming) {
  const map = new Map(existing.map((lead) => [lead.id, lead]));
  for (const lead of incoming) map.set(lead.id, { ...map.get(lead.id), ...lead });
  return [...map.values()];
}

function upsertById(existing, incoming) {
  const map = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) {
    const previous = map.get(item.id);
    if (!previous) {
      map.set(item.id, item);
      continue;
    }
    const previousAt = Date.parse(String(previous.lastAt || previous.at || ""));
    const nextAt = Date.parse(String(item.lastAt || item.at || ""));
    if (Number.isFinite(nextAt) && (!Number.isFinite(previousAt) || nextAt >= previousAt)) {
      map.set(item.id, { ...previous, ...item });
    }
  }
  return [...map.values()];
}

function normalizeSale(body) {
  const products = Array.isArray(body.products)
    ? body.products.map((product) => String(product).trim()).filter(Boolean)
    : String(body.product || "")
        .split(/[|,]/)
        .map((product) => product.trim())
        .filter(Boolean);
  return {
    id: String(body.id || `sale_${Date.now()}_${Math.random().toString(16).slice(2)}`),
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

function normalizeCampaignPeriod(body) {
  return {
    id: String(body.id || body.key || `campaign_${Date.now()}_${Math.random().toString(16).slice(2)}`),
    campaignId: String(body.campaignId || ""),
    campaign: String(body.campaign || "Sin campaña"),
    startDate: String(body.startDate || ""),
    endDate: String(body.endDate || ""),
  };
}

function normalizeLead(body) {
  return {
    id: String(body.id || `lead_${Date.now()}_${Math.random().toString(16).slice(2)}`),
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

function normalizeSpend(body) {
  return {
    id: String(body.id || `spend_${Date.now()}_${Math.random().toString(16).slice(2)}`),
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

function normalizeRules(body) {
  return {
    targetCpa: Number(body.targetCpa || 0),
    minRoas: Number(body.minRoas || 0),
    minLeads: Number(body.minLeads || 0),
  };
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `52${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `52${digits.slice(1)}`;
  if (digits.length >= 13 && digits.startsWith("521")) return `52${digits.slice(3)}`;
  return digits;
}

function normalizeAdId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const numeric = text.match(/(?:ad[_\s-]?id|source[_\s-]?id)?\D*(\d{8,})/i);
  if (numeric) return numeric[1];
  return text.replace(/^ad[_\s-]?id[:\s-]*/i, "").trim();
}

function timestampToDate(value) {
  const numeric = Number(value || 0);
  if (!numeric) return new Date().toISOString().slice(0, 10);
  return new Date(numeric * 1000).toISOString().slice(0, 10);
}

function timestampToIso(value) {
  const numeric = Number(value || 0);
  if (!numeric) return new Date().toISOString();
  return new Date(numeric * 1000).toISOString();
}

async function readJson(req) {
  const text = await readTextBody(req);
  return text ? JSON.parse(text) : {};
}

async function readVerifiedMetaJson(req) {
  const text = await readTextBody(req);
  verifyMetaSignature(req, text);
  return text ? JSON.parse(text) : {};
}

async function readTextBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function verifyMetaSignature(req, rawBody) {
  const secret = metaAppSecret();
  if (!secret) return;

  const signature = req.headers["x-hub-signature-256"] || "";
  const prefix = "sha256=";
  if (!signature.startsWith(prefix)) {
    throw new HttpError(403, "Firma de Meta faltante");
  }

  const expectedHex = signature.slice(prefix.length);
  if (!/^[a-f0-9]+$/i.test(expectedHex) || expectedHex.length % 2 !== 0) {
    throw new HttpError(403, "Firma de Meta invalida");
  }

  const expected = Buffer.from(expectedHex, "hex");
  const actual = createHmac("sha256", secret).update(rawBody).digest();
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new HttpError(403, "Firma de Meta no coincide");
  }
}

function serveStatic(pathname, res) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = join(root, safePath.replace(/^\/+/, ""));
  if (!existsSync(filePath)) return text(res, "Not found", 404);
  res.writeHead(200, { "content-type": mime[extname(filePath)] || "application/octet-stream" });
  createReadStream(filePath).pipe(res);
}

function json(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function text(res, payload, status = 200) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(payload);
}
