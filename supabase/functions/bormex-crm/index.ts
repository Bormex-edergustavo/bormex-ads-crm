type DbState = {
  conversations: any[];
  messages: any[];
  sales: any[];
  leads: any[];
  spend: any[];
  ads: any[];
  crmTags: any[];
  campaignPeriods: any[];
  rules: { targetCpa: number; minRoas: number; minLeads: number };
  webhookEvents: any[];
  lastCoexistenceSync: any;
  lastAdsSync: any;
  lastAdsRange: any;
  lastWebhookAt: any;
  [key: string]: any;
};

const defaultDb: DbState = {
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

const ADS_RANGE_CACHE_LIMIT = 16;
const META_BUYER_AUDIENCE_NAME = "BORMEX | Compradores CRM verificados | Historico activos";
const META_BUYER_AUDIENCE_SETTING = "metaBuyerCustomerList";
const META_BUYER_SYNC_SETTING = "metaBuyerCustomerListSync";
const META_PURCHASE_SETTING_PREFIX = "metaPurchase:";
const META_SALE_EVIDENCE_PREFIX = "metaSaleEvidence:";
const META_SALES_SIGNAL_POLICY_SETTING = "metaSalesSignalPolicy";
const META_PURCHASE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const COMPACT_CONVERSATION_LIMIT = 300;
const CONVERSATION_MESSAGE_LIMIT = 200;
const CONVERSATION_SEARCH_LIMIT = 100;

type Collection = keyof typeof tableMap;

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(req.url);
    const pathname = normalizePath(url.pathname);
    const accessRole = getAccessRole(req, pathname);

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
      const compact = url.searchParams.get("compact") === "1";
      const since = compact ? normalizeSyncCursor(url.searchParams.get("since")) : "";
      const db = compact ? await readCompactDb(accessRole, since) : await readDb();
      return json(filterStateForRole(db, accessRole));
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

    if (pathname === "/api/meta/sales/evidence" && req.method === "POST") {
      if (accessRole !== "ads") return text("Acceso no permitido para este usuario", 403);
      const body = await readJson(req);
      return json(await ingestCrmSaleEvidence(body));
    }

    if (pathname === "/api/meta/buyers/status" && req.method === "GET") {
      return json(await getMetaBuyerStatus());
    }

    if (pathname === "/api/meta/buyers/sync" && req.method === "POST") {
      const body = await readJson(req);
      const audience = await syncBuyerAudience({ force: body.force !== false });
      const purchases = body.backfillPurchases === false
        ? { ok: true, skipped: true, reason: "backfill_disabled" }
        : await syncEligiblePurchaseEvents();
      return json({ ok: audience.ok && purchases.ok, audience, purchases });
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
      return json(await syncMetaAdsRange(await readJson(req)));
    }

    if (pathname === "/api/conversations/search" && req.method === "GET") {
      const query = String(url.searchParams.get("query") || "").trim();
      const limit = clampInteger(url.searchParams.get("limit"), 1, CONVERSATION_SEARCH_LIMIT, CONVERSATION_SEARCH_LIMIT);
      return json({
        partial: true,
        compact: true,
        conversations: await searchConversations(query, limit, String(url.searchParams.get("channel") || "all")),
      });
    }

    const conversationMessagesMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (conversationMessagesMatch && req.method === "GET") {
      const conversationId = decodeURIComponent(conversationMessagesMatch[1]);
      const limit = clampInteger(url.searchParams.get("limit"), 1, CONVERSATION_MESSAGE_LIMIT, CONVERSATION_MESSAGE_LIMIT);
      const before = normalizeSyncCursor(url.searchParams.get("before"));
      return json(await readConversationMessages(conversationId, { limit, before }));
    }

    if (pathname === "/api/messages" && req.method === "POST") {
      const body = await readJson(req);
      const message = await sendCrmMessage(body);
      await upsertItems("conversations", [message.conversation]);
      await upsertItems("messages", [message.record]);
      return json(messageDeltaState(message, accessRole));
    }

    if (pathname === "/api/meta/inbox/sync" && req.method === "POST") {
      return json(await syncSocialInbox(await readJson(req)));
    }

    if (pathname === "/api/media/upload" && req.method === "POST") {
      return json(await uploadCrmMedia(await req.formData()));
    }

    const attachmentMatch = pathname.match(/^\/api\/media\/message\/([^/]+)\/(\d+)\/[^/]+$/);
    if (attachmentMatch && req.method === "GET") {
      return await downloadMessageAttachment(decodeURIComponent(attachmentMatch[1]), Number(attachmentMatch[2]), req);
    }

    if (pathname === "/api/media/whatsapp" && req.method === "POST") {
      return json(await uploadWhatsAppMedia(await req.formData()));
    }

    if (pathname.startsWith("/api/media/whatsapp/") && req.method === "GET") {
      const mediaRequest = parseWhatsAppMediaRequest(pathname);
      return await downloadWhatsAppMedia(
        mediaRequest.mediaId,
        req,
        mediaRequest.filename,
      );
    }

    if (pathname.startsWith("/api/conversations/") && req.method === "POST") {
      const conversation = await updateConversation(
        decodeURIComponent(pathname.replace("/api/conversations/", "")),
        await readJson(req),
      );
      return json({ partial: true, conversations: [conversation] });
    }

    if (pathname === "/api/crm-tags" && req.method === "POST") {
      const crmTags = await saveCrmTag(await readJson(req));
      return json({ partial: true, crmTags });
    }

    if (pathname === "/api/followups/run" && req.method === "POST") {
      return json(await runFollowUpNotifications());
    }

    if (pathname === "/api/sync/ads" && req.method === "POST") {
      const payload = await syncMetaAds(await readJson(req));
      await replaceCollection("ads", payload.ads);
      await rememberAdsRange(payload);
      if (isSingleDayRange(payload.range)) await upsertItems("spend", payload.spend);
      await setSetting("lastAdsSync", new Date().toISOString());
      await setSetting("lastAdsRange", payload.range);
      return json({
        partial: true,
        ads: payload.ads,
        spend: isSingleDayRange(payload.range) ? payload.spend : [],
        lastAdsSync: new Date().toISOString(),
        lastAdsRange: payload.range,
      });
    }

    if (pathname === "/api/cron/sync" && req.method === "POST") {
      const secret = url.searchParams.get("secret") || req.headers.get("x-cron-secret") || "";
      if (!Deno.env.get("CRON_SECRET") || secret !== Deno.env.get("CRON_SECRET")) {
        return text("Forbidden", 403);
      }
      const payload = await syncMetaAds({});
      await replaceCollection("ads", payload.ads);
      await rememberAdsRange(payload);
      if (isSingleDayRange(payload.range)) await upsertItems("spend", payload.spend);
      await setSetting("lastAdsSync", new Date().toISOString());
      await setSetting("lastAdsRange", payload.range);
      const buyers = await syncBuyerAudience({ force: false });
      const purchases = await syncEligiblePurchaseEvents();
      return json({ ok: true, ads: payload.ads.length, buyers, purchases });
    }

    if (pathname === "/api/cron/meta-buyers" && req.method === "POST") {
      const secret = url.searchParams.get("secret") || req.headers.get("x-cron-secret") || "";
      if (!Deno.env.get("CRON_SECRET") || secret !== Deno.env.get("CRON_SECRET")) {
        return text("Forbidden", 403);
      }
      const audience = await syncBuyerAudience({ force: false });
      const purchases = await syncEligiblePurchaseEvents();
      return json({ ok: audience.ok && purchases.ok, audience, purchases });
    }

    if (pathname === "/api/cron/followups" && req.method === "POST") {
      const secret = url.searchParams.get("secret") || req.headers.get("x-cron-secret") || "";
      if (!Deno.env.get("CRON_SECRET") || secret !== Deno.env.get("CRON_SECRET")) {
        return text("Forbidden", 403);
      }
      return json(await runFollowUpNotifications());
    }

    if (pathname === "/api/sales" && req.method === "POST") {
      const normalized = normalizeSale(await readJson(req));
      const existingSale = await readItemById("sales", String(normalized.id || ""));
      const sale = await enrichSaleAttribution({
        ...existingSale,
        ...normalized,
        confirmedAt: normalized.confirmedAt || existingSale?.confirmedAt || new Date().toISOString(),
      });
      await upsertItems("sales", [sale]);
      await syncConfirmedSaleToMeta(sale);
      return json({ partial: true, sales: [sale] });
    }

    if (pathname.startsWith("/api/sales/") && req.method === "DELETE") {
      const id = decodeURIComponent(pathname.replace("/api/sales/", ""));
      const deletedSale = await readItemById("sales", id);
      await deleteItem("sales", id);
      if (deletedSale?.phone) await removeBuyerFromAudienceIfUnused(String(deletedSale.phone));
      return json({ partial: true, deleted: { collection: "sales", id } });
    }

    if (pathname === "/api/rules" && req.method === "POST") {
      const rules = normalizeRules(await readJson(req));
      await setSetting("rules", rules);
      return json({ partial: true, rules });
    }

    if (pathname === "/api/campaign-periods" && req.method === "POST") {
      const body = await readJson(req);
      const periods = Array.isArray(body.periods) ? body.periods.map(normalizeCampaignPeriod) : [];
      await setSetting("campaignPeriods", periods);
      return json({ partial: true, campaignPeriods: periods });
    }

    if (pathname === "/api/import" && req.method === "POST") {
      const body = await readJson(req);
      const rows = Array.isArray(body.rows) ? body.rows : [];
      let imported: Array<Record<string, unknown>> = [];
      if (body.type === "sales") {
        imported = rows.map(normalizeSale);
        await upsertItems("sales", imported);
        await syncBuyerAudience({ force: false });
        await syncEligiblePurchaseEvents();
      }
      if (body.type === "leads") {
        imported = rows.map(normalizeLead);
        await upsertItems("leads", imported);
      }
      if (body.type === "spend") {
        imported = rows.map(normalizeSpend);
        await upsertItems("spend", imported);
      }
      return json({ partial: true, [String(body.type || "")]: imported });
    }

    if (pathname.startsWith("/api/records/") && req.method === "DELETE") {
      const [, , , collection, rawId] = pathname.split("/");
      if (!["sales", "leads", "spend"].includes(collection)) return text("Not found", 404);
      const id = decodeURIComponent(rawId || "");
      const deletedSale = collection === "sales"
        ? await readItemById("sales", id)
        : null;
      await deleteItem(collection as Collection, id);
      if (deletedSale?.phone) await removeBuyerFromAudienceIfUnused(String(deletedSale.phone));
      return json({ partial: true, deleted: { collection, id } });
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
      const metaCapi = await sendWhatsAppLeadsToMetaCapi(body);
      await rememberWebhookEvent("whatsapp", body, { ...payload, metaCapi });
      await setSetting("lastWebhookAt", new Date().toISOString());
      return json({ ok: true, leads: payload.leads.length, messages: payload.messages.length, metaCapi });
    }

    if (pathname === "/webhooks/meta" && req.method === "GET") {
      return await verifyWhatsAppWebhook(url);
    }

    if (pathname === "/webhooks/meta" && req.method === "POST") {
      const body = await readVerifiedMetaJson(req);
      const payload = extractMetaMessagingEvents(body);
      await enrichMetaConversationProfiles(payload.conversations);
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
  const whatsappSendTokenConfigured = Boolean(whatsappSendAccessToken());
  return {
    metaAdsConfigured: Boolean(metaAdsAccessToken() && Deno.env.get("META_AD_ACCOUNT_ID")),
    metaCapiConfigured: Boolean(metaPixelId() && metaCapiAccessToken()),
    whatsappWebhookConfigured: Boolean(metaWebhookVerifyToken()),
    whatsappPhoneConfigured: Boolean(Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    whatsappApiConfigured: Boolean(whatsappSendTokenConfigured && Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    whatsappSendApiConfigured: Boolean(whatsappSendTokenConfigured && Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    whatsappSendProofConfigured: Boolean(whatsappSendAppSecret()),
    whatsappReceiveApiConfigured: Boolean(whatsappAccessToken() && Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    whatsappCoexistenceReady: Boolean(metaWebhookVerifyToken() && whatsappAccessToken() && Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")),
    whatsappCoexistenceOnboardingConfigured: Boolean(metaAppId() && metaEmbeddedSignupConfigId()),
    webhookSignatureConfigured: Boolean(metaAppSecret()),
    mediaCredentialsConfigured: Boolean(
      (Deno.env.get("WHATSAPP_MEDIA_ACCESS_TOKEN") || "").trim() &&
      (Deno.env.get("WHATSAPP_MEDIA_APP_SECRET") || "").trim(),
    ),
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
  return [
    "/",
    "/index.html",
    "/health",
    "/webhooks/whatsapp",
    "/webhooks/meta",
    "/api/cron/sync",
    "/api/cron/followups",
    "/api/cron/meta-buyers",
    "/oauth/meta",
  ].includes(pathname);
}

function getAccessRole(req: Request, pathname = "") {
  const password = Deno.env.get("PANEL_PASSWORD") || "";
  if (!password) return "ads";
  const header = req.headers.get("authorization") || "";
  let encodedCredentials = header.startsWith("Basic ") ? header.slice(6) : "";
  if (!encodedCredentials && req.method === "GET" && pathname.startsWith("/api/media/")) {
    encodedCredentials = new URL(req.url).searchParams.get("media_token") || "";
  }
  if (!encodedCredentials) return "";
  let decoded = "";
  try {
    decoded = atob(encodedCredentials);
  } catch {
    return "";
  }
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
  if (method === "GET" && pathname === "/api/conversations/search") return true;
  if (method === "GET" && /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)) return true;
  if (method === "GET" && pathname.startsWith("/api/media/whatsapp/")) return true;
  if (method === "POST" && pathname === "/api/messages") return true;
  if (method === "POST" && pathname === "/api/media/whatsapp") return true;
  if (method === "POST" && pathname === "/api/media/upload") return true;
  if (method === "GET" && pathname.startsWith("/api/media/message/")) return true;
  if (method === "POST" && pathname === "/api/meta/inbox/sync") return true;
  if (method === "POST" && pathname.startsWith("/api/conversations/")) return true;
  if (method === "POST" && pathname === "/api/crm-tags") return true;
  if (method === "POST" && pathname === "/api/followups/run") return true;
  if (method === "POST" && pathname === "/api/sales") return true;
  if (method === "DELETE" && pathname.startsWith("/api/sales/")) return true;
  if (method === "DELETE" && pathname.startsWith("/api/records/sales/")) return true;
  return false;
}

function filterStateForRole(db: any, role: string) {
  if (role !== "sales") return db;
  return {
    ...structuredClone(defaultDb),
    compact: Boolean(db.compact),
    partial: Boolean(db.partial),
    serverTime: db.serverTime || null,
    conversations: db.conversations || [],
    messages: db.messages || [],
    sales: db.sales || [],
    crmTags: db.crmTags || defaultDb.crmTags,
    rules: db.rules || defaultDb.rules,
  };
}

function messageDeltaState(message: { conversation: Record<string, unknown>; record: Record<string, unknown> }, role: string) {
  return {
    partial: true,
    role,
    conversations: [message.conversation],
    messages: [message.record],
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

async function readCompactDb(role: string, since = "") {
  const serverTime = new Date().toISOString();
  const partial = Boolean(since);
  const readChanged = (collection: Collection) => partial
    ? readCollectionUpdatedSince(collection, since)
    : readCollection(collection);
  const conversationsPromise = partial
    ? readCollectionUpdatedSince("conversations", since)
    : readRecentCollection("conversations", COMPACT_CONVERSATION_LIMIT);
  const [conversations, sales, leads, spend, ads, settings] = await Promise.all([
    conversationsPromise,
    readChanged("sales"),
    role === "sales" ? Promise.resolve([]) : readChanged("leads"),
    role === "sales" ? Promise.resolve([]) : readChanged("spend"),
    role === "sales" ? Promise.resolve([]) : readChanged("ads"),
    readSettings(),
  ]);
  return {
    ...structuredClone(defaultDb),
    compact: true,
    partial,
    serverTime,
    conversations,
    messages: [],
    sales,
    leads,
    spend,
    ads,
    rules: settings.rules || defaultDb.rules,
    crmTags: normalizeCrmTags(settings.crmTags || defaultDb.crmTags),
    campaignPeriods: settings.campaignPeriods || [],
    webhookEvents: (settings.webhookEvents || []).slice(-20),
    lastCoexistenceSync: settings.lastCoexistenceSync || null,
    lastAdsSync: settings.lastAdsSync || null,
    lastAdsRange: settings.lastAdsRange || null,
    lastWebhookAt: settings.lastWebhookAt || null,
  };
}

async function readCollection(collection: Collection) {
  const pageSize = 1000;
  const items = [];
  for (let offset = 0; ; offset += pageSize) {
    const response = await supabaseFetch(`/rest/v1/${tableMap[collection]}?select=data&limit=${pageSize}&offset=${offset}`);
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.message || `No se pudo leer ${collection}`);
    items.push(...rows.map((row: { data: unknown }) => row.data));
    if (rows.length < pageSize) break;
  }
  return items;
}

async function readRecentCollection(collection: Collection, limit: number) {
  const params = new URLSearchParams({
    select: "data",
    order: "updated_at.desc",
    limit: String(limit),
  });
  const response = await supabaseFetch(`/rest/v1/${tableMap[collection]}?${params.toString()}`);
  const rows = await response.json();
  if (!response.ok) throw new Error(rows.message || `No se pudo leer ${collection}`);
  return rows.map((row: { data: unknown }) => row.data);
}

async function readCollectionUpdatedSince(collection: Collection, since: string) {
  if (!since) return readCollection(collection);
  const pageSize = 1000;
  const items = [];
  for (let offset = 0; ; offset += pageSize) {
    const params = new URLSearchParams({
      select: "data",
      updated_at: `gt.${since}`,
      order: "updated_at.asc",
      limit: String(pageSize),
      offset: String(offset),
    });
    const response = await supabaseFetch(`/rest/v1/${tableMap[collection]}?${params.toString()}`);
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.message || `No se pudo actualizar ${collection}`);
    items.push(...rows.map((row: { data: unknown }) => row.data));
    if (rows.length < pageSize) break;
  }
  return items;
}

async function readItemById(collection: Collection, id: string) {
  if (!id) return null;
  const params = new URLSearchParams({ select: "data", id: `eq.${id}`, limit: "1" });
  const response = await supabaseFetch(`/rest/v1/${tableMap[collection]}?${params.toString()}`);
  const rows = await response.json();
  if (!response.ok) throw new Error(rows.message || `No se pudo leer ${collection}`);
  return rows[0]?.data || null;
}

async function readItemsByIds(collection: Collection, ids: string[]) {
  const uniqueIds = [...new Set(ids.map((id) => String(id || "")).filter(Boolean))];
  if (!uniqueIds.length) return [];
  const items = [];
  const batchSize = 100;
  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    const batch = uniqueIds.slice(offset, offset + batchSize);
    const filter = `in.(${batch.map(quotePostgrestValue).join(",")})`;
    const params = new URLSearchParams({ select: "data", id: filter });
    const response = await supabaseFetch(`/rest/v1/${tableMap[collection]}?${params.toString()}`);
    const rows = await response.json();
    if (!response.ok) throw new Error(rows.message || `No se pudo leer ${collection}`);
    items.push(...rows.map((row: { data: unknown }) => row.data));
  }
  return items;
}

function quotePostgrestValue(value: string) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

async function readCollectionByJsonField(
  collection: Collection,
  field: string,
  value: string,
  options: { limit?: number; order?: string } = {},
) {
  if (!value) return [];
  const params = new URLSearchParams({
    select: "data",
    [`data->>${field}`]: `eq.${value}`,
    order: options.order || "updated_at.desc",
    limit: String(options.limit || 20),
  });
  const response = await supabaseFetch(`/rest/v1/${tableMap[collection]}?${params.toString()}`);
  const rows = await response.json();
  if (!response.ok) throw new Error(rows.message || `No se pudo buscar ${collection}`);
  return rows.map((row: { data: unknown }) => row.data);
}

async function readConversationMessages(
  conversationId: string,
  options: { limit: number; before?: string },
) {
  if (!conversationId) throw new HttpError(400, "Falta id de conversación");
  const requested = Math.min(CONVERSATION_MESSAGE_LIMIT, Math.max(1, Number(options.limit || CONVERSATION_MESSAGE_LIMIT)));
  const params = new URLSearchParams({
    select: "data",
    "data->>conversationId": `eq.${conversationId}`,
    order: "data->>at.desc",
    limit: String(requested + 1),
  });
  if (options.before) params.set("data->>at", `lt.${options.before}`);
  const response = await supabaseFetch(`/rest/v1/${tableMap.messages}?${params.toString()}`);
  const rows = await response.json();
  if (!response.ok) throw new Error(rows.message || "No se pudo leer el historial");
  const page = rows.slice(0, requested).map((row: { data: unknown }) => row.data as Record<string, any>);
  const oldest = page[page.length - 1];
  return {
    partial: true,
    conversationId,
    messages: page.reverse(),
    hasMore: rows.length > requested,
    nextBefore: oldest?.at || "",
  };
}

async function searchConversations(query: string, limit: number, channel = "all") {
  const normalizedQuery = normalizeSearchValue(query);
  const validChannel = ["whatsapp", "messenger", "instagram"].includes(channel) ? channel : "all";
  if (normalizedQuery.length < 2) return validChannel === "all" ? readRecentCollection("conversations", limit) : readCollectionByJsonField("conversations", "channel", validChannel, {limit});
  const conversations = await readCollection("conversations");
  return conversations
    .filter((conversation: any) => (validChannel === "all" || conversation.channel === validChannel) && conversationSearchValue(conversation).includes(normalizedQuery))
    .sort((a: any, b: any) => Date.parse(String(b.lastAt || b.updatedAt || "")) - Date.parse(String(a.lastAt || a.updatedAt || "")))
    .slice(0, limit);
}

function conversationSearchValue(conversation: any) {
  return normalizeSearchValue([
    conversation?.name,
    conversation?.customName,
    conversation?.phone,
    conversation?.contactId,
    conversation?.lastMessage,
    conversation?.ad,
    conversation?.adset,
    conversation?.campaign,
  ].filter(Boolean).join(" "));
}

function normalizeSearchValue(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function normalizeSyncCursor(value: unknown) {
  const cursor = String(value || "").trim();
  return Number.isFinite(Date.parse(cursor)) ? new Date(cursor).toISOString() : "";
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const parsed = Number.parseInt(String(value || ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

async function readSettings() {
  const params = new URLSearchParams({ select: "key,value", key: "not.like.crmUpload:*" });
  const response = await supabaseFetch(`/rest/v1/bormex_settings?${params}`);
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

async function upsertItems(
  collection: Collection,
  items: Array<Record<string, unknown>>,
  existingOverride?: Array<Record<string, unknown>>,
) {
  if (!items.length) return;
  const table = tableMap[collection];
  const compacted = compactItemsById(items);
  const existing = collection === "conversations"
    ? existingOverride ?? await readItemsByIds("conversations", compacted.map((item) => String(item.id || "")))
    : [];
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
      map.set(id, {
        ...previous,
        ...item,
        unreadDelta: item.unreadReset ? 0 : Number(previous.unreadDelta || 0) + Number(item.unreadDelta || 0),
      });
    } else {
      map.set(id, {
        ...item,
        ...previous,
        unreadDelta: previous.unreadReset ? Number(previous.unreadDelta || 0) : Number(previous.unreadDelta || 0) + Number(item.unreadDelta || 0),
      });
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
    "customName",
    "avatarUrl",
  ]) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field) && existing?.[field] !== undefined) {
      merged[field] = existing[field];
    }
  }
  if (Object.prototype.hasOwnProperty.call(incoming, "avatarUrl") && !incoming.avatarUrl && existing?.avatarUrl) {
    merged.avatarUrl = existing.avatarUrl;
  }
  for (const field of ["adId", "ad", "adset", "campaign", "campaignId", "ctwaClid", "sourceUrl", "attributionSource"]) {
    if (!Object.prototype.hasOwnProperty.call(incoming, field) && existing?.[field] !== undefined) {
      merged[field] = existing[field];
    }
    if (Object.prototype.hasOwnProperty.call(incoming, field) && !incoming[field] && existing?.[field] && !incoming.attributionSource) {
      merged[field] = existing[field];
    }
  }
  const existingUnread = Math.max(0, Number(existing?.unread || 0));
  const unreadDelta = Math.max(0, Number(incoming.unreadDelta || 0));
  if (incoming.unreadReset === true) {
    merged.unread = 0;
  } else if (unreadDelta > 0) {
    merged.unread = existingUnread + unreadDelta;
  } else if (existing?.unread !== undefined && Number(incoming.unread || 0) === 0) {
    merged.unread = existingUnread;
  } else if (!Object.prototype.hasOwnProperty.call(incoming, "unread") && existing?.unread !== undefined) {
    merged.unread = existingUnread;
  }
  delete merged.unreadDelta;
  delete merged.unreadReset;
  merged.tags = normalizeTagIds(merged.tags);
  if (merged.customName) merged.name = String(merged.customName);
  merged.updatedAt = String(incoming.updatedAt || new Date().toISOString());
  return merged;
}

async function updateConversation(id: string, body: any) {
  if (!id) throw new HttpError(400, "Falta id de conversación");
  const existing = await readItemById("conversations", id) || {};
  const conversation = normalizeConversationPatch({ ...existing, ...body, id });
  await upsertItems("conversations", [conversation], existing?.id ? [existing] : []);
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
    customName: String(body.customName || ""),
    avatarUrl: String(body.avatarUrl || body.avatar_url || body.profilePic || body.profile_pic || body.picture || ""),
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
  return next;
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

async function syncMetaAdsRange(options: any = {}) {
  const range = normalizeSyncRange(options);
  try {
    const payload = await syncMetaAds(range);
    await rememberAdsRange(payload);
    return { ...payload, cacheStatus: "fresh", syncedAt: new Date().toISOString() };
  } catch (error) {
    const cached = await readCachedAdsRange(range, error);
    if (cached) return cached;
    throw new Error(formatMetaAdsSyncError(error));
  }
}

async function rememberAdsRange(payload: any) {
  const settings = await readSettings();
  const cache = normalizeAdsRangeCache(settings.adsRangeCache);
  const key = adsRangeKey(payload.range);
  const entry = {
    key,
    at: new Date().toISOString(),
    range: payload.range,
    ads: payload.ads || [],
    spend: payload.spend || [],
  };
  await setSetting("adsRangeCache", [entry, ...cache.filter((item: any) => item.key !== key)].slice(0, ADS_RANGE_CACHE_LIMIT));
}

async function readCachedAdsRange(range: { since: string; until: string }, error: unknown) {
  const settings = await readSettings();
  const exact = normalizeAdsRangeCache(settings.adsRangeCache).find((item: any) => item.key === adsRangeKey(range));
  if (exact) {
    return {
      ads: exact.ads || [],
      spend: exact.spend || [],
      range: exact.range || range,
      cacheStatus: "exact-cache",
      cachedAt: exact.at || "",
      warning: cachedAdsWarning(error),
    };
  }

  const db = await readDb();
  const daily = buildDailyCachedAdsRange(range, db);
  if (!daily) return null;
  return {
    ...daily,
    cacheStatus: "daily-cache",
    warning: cachedAdsWarning(error),
  };
}

function buildDailyCachedAdsRange(range: { since: string; until: string }, db: typeof defaultDb) {
  const dailyRows = (db.spend || []).filter((spend: any) => isDailyMetaSpendInRange(spend, range));
  if (!dailyRows.length) return null;
  const coveredDays = new Set(dailyRows.map((spend: any) => String(spend.rangeStart || spend.date || "")));
  const expectedDays = daysInRange(range);
  if (!expectedDays.every((day) => coveredDays.has(day))) return null;

  const adsById = new Map((db.ads || []).map((ad: any) => [String(ad.id || ad.adId || ""), ad]));
  const grouped = new Map<string, any>();
  for (const spend of dailyRows) {
    const adId = normalizeAdId(spend.adId || spend.ad_id || "");
    const key = adId || `${spend.campaign || "Sin campaña"}::${spend.ad || "Sin anuncio"}`;
    const row = grouped.get(key) || {
      source: "meta",
      campaign: spend.campaign || "Sin campaña",
      campaignId: spend.campaignId || "",
      adset: spend.adset || "",
      adsetId: spend.adsetId || "",
      ad: spend.ad || "Sin anuncio",
      adId,
      spend: 0,
      dailyBudget: 0,
      messages: 0,
    };
    row.spend += Number(spend.spend || 0);
    row.dailyBudget = Math.max(Number(row.dailyBudget || 0), Number(spend.dailyBudget || 0));
    row.messages += Number(spend.messages || 0);
    grouped.set(key, row);
  }

  const spend = [...grouped.values()].map((row: any) => ({
    ...row,
    id: `meta_spend_${row.adId || row.ad}_${range.since}_${range.until}`,
    date: range.since === range.until ? range.since : `${range.since} - ${range.until}`,
    rangeStart: range.since,
    rangeEnd: range.until,
  }));
  const ads = spend.map((row: any) => {
    const ad = adsById.get(String(row.adId || "")) || {};
    return {
      ...ad,
      id: row.adId || ad.id || "",
      name: ad.name || row.ad || "Sin anuncio",
      campaign: ad.campaign || row.campaign || "Sin campaña",
      campaignId: ad.campaignId || row.campaignId || "",
      adset: ad.adset || row.adset || "",
      adsetId: ad.adsetId || row.adsetId || "",
      dailyBudget: row.dailyBudget,
      spend: row.spend,
      messages: row.messages,
      rangeStart: range.since,
      rangeEnd: range.until,
    };
  });
  return { ads, spend, range };
}

function normalizeAdsRangeCache(value: unknown) {
  return (Array.isArray(value) ? value : []).filter((item: any) => item?.range?.since && item?.range?.until);
}

function adsRangeKey(range: { since: string; until: string }) {
  return `${range.since}..${range.until}`;
}

function isSingleDayRange(range: { since?: string; until?: string } = {}) {
  return Boolean(range.since && range.since === range.until);
}

function isDailyMetaSpendInRange(spend: any, range: { since: string; until: string }) {
  if (spend.source !== "meta") return false;
  const start = String(spend.rangeStart || spend.date || "");
  const end = String(spend.rangeEnd || spend.date || start);
  if (!start || !end || start !== end) return false;
  return start >= range.since && start <= range.until;
}

function daysInRange(range: { since: string; until: string }) {
  const days = [];
  const cursor = new Date(`${range.since}T12:00:00Z`);
  const end = new Date(`${range.until}T12:00:00Z`);
  while (cursor <= end) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

function cachedAdsWarning(error: unknown) {
  const message = formatMetaAdsSyncError(error);
  return `${message} Mostrando el último dato real guardado para este rango.`;
}

function formatMetaAdsSyncError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || "Meta Ads no respondió");
  if (/quota|cuota|limit|rate/i.test(message)) {
    return "Meta Ads no permitió actualizar este rango porque la cuota del API se agotó.";
  }
  return message;
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
  if (media.storagePath) {
    const stored = await readCrmUpload(media.storagePath);
    if (stored.channel !== channel || stored.conversationId !== conversationId) throw new HttpError(400, "El archivo pertenece a otra conversación");
    Object.assign(media, stored, { url: channel === "whatsapp" && media.id ? "" : await signedCrmMediaUrl(media.storagePath) });
  }
  if (!channel || !conversationId || !to || (!textBody && !media.url && !media.id)) throw new Error("Faltan datos para enviar el mensaje");

  let providerMessageId: string = crypto.randomUUID();
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
      customName: String(body.customName || ""),
      lastMessage: textBody || `[${media.type}]`,
      lastAt: now,
      unread: 0,
      unreadReset: true,
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
      attachments: media.url || media.id ? [{ ...media, url: media.storagePath ? "" : media.url }] : [],
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
  const id = String(body.mediaId || body.media?.id || "").trim();
  const filename = String(body.mediaFilename || body.media?.filename || "").trim();
  const mimeType = String(body.mediaMimeType || body.media?.mimeType || "").trim();
  const rawType = String(body.mediaType || body.media?.type || "").trim().toLowerCase();
  const hasMedia = Boolean(url || id || filename || mimeType);
  const type = hasMedia
    ? inferMediaType(mimeType) || inferMediaType(filename) || inferMediaType(url) || normalizeMediaType(rawType) || "document"
    : "";
  return {
    type,
    url,
    id,
    filename,
    mimeType,
    storagePath: String(body.mediaStoragePath || body.media?.storagePath || ""),
  };
}

function normalizeMediaType(value: unknown) {
  const type = String(value || "").trim().toLowerCase();
  return ["image", "video", "audio", "document"].includes(type) ? type : "";
}

function inferMediaType(value: unknown) {
  const input = String(value || "").trim().toLowerCase();
  if (!input) return "";
  if (input.startsWith("image/") || /\.(jpe?g|png|gif|webp|heic|heif)([?#].*)?$/i.test(input)) return "image";
  if (input.startsWith("video/") || /\.(mp4|mov|webm|m4v|3gp|3gpp)([?#].*)?$/i.test(input)) return "video";
  if (input.startsWith("audio/") || /\.(mp3|ogg|oga|opus|wav|m4a|aac|amr)([?#].*)?$/i.test(input)) return "audio";
  if (
    input.startsWith("application/") ||
    input.startsWith("text/") ||
    /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt|zip|rar)([?#].*)?$/i.test(input)
  ) {
    return "document";
  }
  return "";
}

async function sendWhatsAppText(to: string, textBody: string) {
  return await sendWhatsAppMessage(to, textBody, { type: "", url: "", filename: "" });
}

async function sendWhatsAppMessage(to: string, textBody: string, media: { type: string; url: string; id?: string; filename?: string; mimeType?: string }) {
  const token = whatsappSendAccessToken();
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    throw new Error("Falta WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_SEND_ACCESS_TOKEN/WHATSAPP_COEX_ACCESS_TOKEN para enviar desde API Meta");
  }
  let body = buildWhatsAppMessageBody(to, textBody, media);
  let response = await postWhatsAppMessage(phoneNumberId, token, body);
  let payload = await response.json();
  if (!response.ok && shouldRetryMediaByLink(payload, media)) {
    body = buildWhatsAppMessageBody(to, textBody, {
      ...media,
      id: "",
      url: mediaProxyUrl(String(media.id || ""), media.filename, media.mimeType, media.type),
    });
    response = await postWhatsAppMessage(phoneNumberId, token, body);
    payload = await response.json();
  }
  if (!response.ok) throw new Error(formatWhatsAppSendError(payload, { to, media }));
  return payload.messages?.[0]?.id || crypto.randomUUID();
}

function buildWhatsAppMessageBody(to: string, textBody: string, media: { type: string; url: string; id?: string; filename?: string; mimeType?: string }) {
  return media.url || media.id
    ? {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to,
        type: media.type,
        [media.type]: {
          ...(media.url ? { link: media.url } : { id: media.id }),
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
}

async function postWhatsAppMessage(phoneNumberId: string, token: string, body: Record<string, unknown>) {
  const endpoint = await whatsappSendEndpoint(phoneNumberId, "messages", token);
  return fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function shouldRetryMediaByLink(payload: any, media: { type: string; id?: string; url?: string }) {
  const message = String(payload?.error?.message || "").toLowerCase();
  const code = String(payload?.error?.code || "");
  return Boolean(media.id && !media.url && code === "100" && message.includes("invalid parameter"));
}

function mediaProxyUrl(mediaId: string, filename = "", mimeType = "", type = "") {
  if (!mediaId) return "";
  const base = publicFunctionBaseUrl();
  const safeFilename = mediaProxyFilename(filename, mimeType, type);
  const url = new URL(`${base}/api/media/whatsapp/${encodeURIComponent(mediaId)}/${encodeURIComponent(safeFilename)}`);
  const token = mediaProxyToken();
  if (token) url.searchParams.set("media_token", token);
  return url.toString();
}

function mediaProxyFilename(filename = "", mimeType = "", type = "") {
  const basename = String(filename || "")
    .split(/[\\/]/)
    .pop()
    ?.replace(/[?#]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const fallbackBase = type === "video" ? "video" : type === "audio" ? "audio" : type === "image" ? "foto" : "documento";
  const base = basename || fallbackBase;
  if (/\.[a-z0-9]{2,8}$/i.test(base)) return base;
  const extension = extensionForMedia(mimeType, type);
  return `${base}.${extension}`;
}

function extensionForMedia(mimeType = "", type = "") {
  const mime = String(mimeType || "").toLowerCase();
  if (mime.includes("pdf")) return "pdf";
  if (mime.includes("msword")) return "doc";
  if (mime.includes("wordprocessingml")) return "docx";
  if (mime.includes("spreadsheetml")) return "xlsx";
  if (mime.includes("presentationml")) return "pptx";
  if (mime.includes("csv")) return "csv";
  if (mime.includes("plain")) return "txt";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("ogg") || mime.includes("opus")) return "ogg";
  if (mime.includes("mpeg")) return "mp3";
  if (mime.includes("wav")) return "wav";
  if (mime.includes("aac")) return "aac";
  if (type === "video") return "mp4";
  if (type === "audio") return "ogg";
  if (type === "image") return "jpg";
  return "pdf";
}

function publicFunctionBaseUrl() {
  const configuredBase = Deno.env.get("BORMEX_FUNCTION_BASE_URL") || Deno.env.get("CRM_FUNCTION_BASE_URL") || "";
  if (configuredBase) return configuredBase.replace(/\/$/, "");
  const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
  try {
    const projectRef = new URL(supabaseUrl).hostname.split(".")[0];
    if (projectRef) return `https://${projectRef}.functions.supabase.co/bormex-crm`;
  } catch {
    // fall through to the known production project
  }
  return "https://tnajelbyzkrifukfgnxv.functions.supabase.co/bormex-crm";
}

function mediaProxyToken() {
  const password = Deno.env.get("PANEL_PASSWORD") || "";
  if (!password) return "";
  return btoa(`${Deno.env.get("PANEL_USERNAME") || "panel"}:${password}`);
}

async function uploadWhatsAppMedia(formData: FormData) {
  const token = whatsappSendAccessToken();
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID");
  if (!token || !phoneNumberId) {
    throw new Error("Falta WHATSAPP_PHONE_NUMBER_ID o WHATSAPP_SEND_ACCESS_TOKEN/WHATSAPP_COEX_ACCESS_TOKEN");
  }
  const file = formData.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Selecciona un archivo valido");
  const requestedType = String(formData.get("mediaType") || "").toLowerCase();
  const mediaType = inferMediaType(file.type) || inferMediaType(file.name) || normalizeMediaType(requestedType) || "document";
  const sizeLimit = mediaUploadLimit(mediaType);
  if (file.size > sizeLimit) {
    throw new HttpError(
      400,
      `El archivo pesa ${formatMegabytes(file.size)}. Para WhatsApp el limite de ${mediaTypeLabel(mediaType)} es ${formatMegabytes(sizeLimit)}.`,
    );
  }

  const graphForm = new FormData();
  graphForm.append("messaging_product", "whatsapp");
  graphForm.append("type", file.type || "application/octet-stream");
  graphForm.append("file", file, file.name || "archivo");

  const endpoint = await whatsappSendEndpoint(phoneNumberId, "media", token);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: graphForm,
  });
  const payload = await response.json();
  if (!response.ok) {
    const raw = String(payload.error?.message || "Error al subir el archivo");
    if (/appsecret_proof/i.test(raw)) throw new HttpError(503, "WhatsApp necesita completar su conexión segura para enviar archivos. La recepción sigue disponible.");
    const message = raw.replaceAll(token, "[token]").slice(0, 500);
    throw new HttpError(502, `Meta rechazó la subida del archivo: ${message}`);
  }
  if (!payload.id) throw new HttpError(502, "Meta no confirmó la subida del archivo");
  return {
    ok: true,
    mediaId: String(payload.id || ""),
    type: mediaType,
    filename: file.name || "",
    mimeType: file.type || "",
    size: file.size || 0,
  };
}

function mediaUploadLimit(type: string) {
  if (type === "image") return 5 * 1024 * 1024;
  if (type === "video" || type === "audio") return 16 * 1024 * 1024;
  return 100 * 1024 * 1024;
}

function mediaTypeLabel(type: string) {
  if (type === "image") return "foto";
  if (type === "video") return "video";
  if (type === "audio") return "audio";
  if (type === "document") return "documento";
  return "archivo";
}

function formatMegabytes(bytes: number) {
  const mb = bytes / 1024 / 1024;
  return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
}

function parseWhatsAppMediaRequest(pathname: string) {
  const rest = pathname.replace("/api/media/whatsapp/", "");
  const [rawMediaId = "", ...rawFilenameParts] = rest.split("/");
  return {
    mediaId: decodeURIComponent(rawMediaId),
    filename: decodeURIComponent(rawFilenameParts.join("/") || ""),
  };
}

async function downloadWhatsAppMedia(mediaId: string, req: Request, filename = "") {
  let stage: "credentials" | "proof" | "metadata" | "binary" = "credentials";
  let upstreamStatus = 0;
  try {
    const credentials = whatsappMediaCredentials();
    const token = credentials.token;
    if (!token) {
      throw new HttpError(503, "Faltan credenciales de medios");
    }
    if (!mediaId) throw new HttpError(400, "Falta media id");

    stage = "proof";
    const appSecretProof = await metaAppSecretProof(token, credentials.appSecret);
    stage = "metadata";
    const metadata = await graphRequest(
      `/${mediaId}`,
      token,
      "GET",
      appSecretProof ? { appsecret_proof: appSecretProof } : {},
    );
    const mediaUrl = String(metadata.url || "");
    if (!mediaUrl) throw new HttpError(404, "Meta no devolvio URL para este archivo");

    stage = "binary";
    const headers = new Headers({ authorization: `Bearer ${token}` });
    const range = req.headers.get("range");
    if (range) headers.set("range", range);

    const response = await fetch(mediaUrl, { headers });
    upstreamStatus = response.status;
    if (!response.ok || !response.body) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch {
        errorText = "";
      }
      throw new Error(errorText || "Meta no permitio descargar el archivo");
    }

    const responseHeaders = new Headers({
      "cache-control": "private, max-age=300",
      "content-type": response.headers.get("content-type") || String(metadata.mime_type || "application/octet-stream"),
    });
    const downloadName = mediaProxyFilename(filename, String(metadata.mime_type || ""), "");
    responseHeaders.set("content-disposition", `inline; filename="${downloadName.replace(/"/g, "")}"`);
    for (const header of ["content-length", "content-range", "accept-ranges"]) {
      const value = response.headers.get(header);
      if (value) responseHeaders.set(header, value);
    }
    return cors(new Response(whatsappMediaStream(response.body), { status: response.status === 206 ? 206 : 200, headers: responseHeaders }));
  } catch (error) {
    throw whatsappMediaReadError(stage, error, upstreamStatus);
  }
}

function formatWhatsAppSendError(payload: any, context: { to?: string; media?: { type?: string; filename?: string; mimeType?: string } } = {}) {
  const message = String(payload?.error?.message || "");
  if (/appsecret_proof/i.test(message)) return "WhatsApp necesita completar su conexión segura para enviar mensajes y archivos. La recepción sigue disponible.";
  const code = payload?.error?.code ? `#${payload.error.code}` : "";
  const details = String(payload?.error?.error_data?.details || payload?.error?.error_user_msg || "");
  if (code === "#200" || message.toLowerCase().includes("necessary permissions")) {
    return "(#200) El token configurado no tiene permiso para enviar mensajes en nombre de este WABA. Recibir por COEX/Dualhook funciona, pero para enviar desde el CRM falta configurar WHATSAPP_SEND_ACCESS_TOKEN o WHATSAPP_COEX_ACCESS_TOKEN con permisos whatsapp_business_messaging.";
  }
  if (code === "#100" || message.toLowerCase().includes("invalid parameter")) {
    const mediaType = context.media?.type ? ` ${context.media.type}` : "";
    const filename = context.media?.filename ? ` (${context.media.filename})` : "";
    const suffix = context.to ? ` Destino: ${context.to}.` : "";
    return `(#100) Meta rechazo los parametros del mensaje${mediaType}${filename}.${suffix} Si estas probando, usa el numero personal real del cliente, no el mismo numero emisor del WhatsApp Business.`;
  }
  return [code ? `(${code})` : "", message, details].filter(Boolean).join(" ") || "Meta no acepto el mensaje de WhatsApp";
}

async function sendMessengerText(to: string, textBody: string) {
  return await sendMessengerMessage(to, textBody, { type: "", url: "", filename: "" });
}

async function sendMessengerMessage(to: string, textBody: string, media: { type: string; url: string; filename?: string }) {
  const target = await socialTarget("messenger");
  const token = target.token;
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
  const target = await socialTarget("messenger");
  const response = await fetch(`https://graph.facebook.com/${graphVersion()}/${target.accountId}/messages`, {
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
  if (!payload.message_id) throw new Error("Meta no confirmó el envío de Messenger");
  return payload.message_id;
}

async function sendInstagramText(to: string, textBody: string) {
  return await sendInstagramMessage(to, textBody, { type: "", url: "", filename: "" });
}

async function sendInstagramMessage(to: string, textBody: string, media: { type: string; url: string; filename?: string }) {
  const target = await socialTarget("instagram");
  if (media.url && !["image", "video", "audio"].includes(media.type)) throw new HttpError(400, "Instagram permite fotos, videos y audio en este formulario");
  const messages = [];
  if (textBody) messages.push({ text: textBody });
  if (media.url) messages.push({ attachment: { type: media.type, payload: { url: media.url } } });
  let id = "";
  for (const message of messages) {
    const payload = await socialGraph(target, `/${target.accountId}/messages`, "POST", { recipient: { id: to }, message });
    id = String(payload.message_id || payload.messages?.[0]?.id || "");
    if (!id) throw new Error("Meta no confirmó el envío de Instagram");
  }
  return id;
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

async function safeGraphPostJson(path: string, token: string, body: Record<string, unknown>) {
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
  if (!response.ok) throw new Error(graphApiErrorMessage(payload, response.status));
  return payload;
}

async function graphJsonRequest(path: string, token: string, method: "POST", body: Record<string, unknown>) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`https://graph.facebook.com/${graphVersion()}${cleanPath}`);
  url.searchParams.set("access_token", token);
  const response = await fetch(url.toString(), {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(graphApiErrorMessage(payload, response.status));
  return payload;
}

async function graphFormRequest(
  path: string,
  token: string,
  method: "POST" | "DELETE",
  params: Record<string, string>,
) {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`https://graph.facebook.com/${graphVersion()}${cleanPath}`);
  const body = new URLSearchParams(params);
  body.set("access_token", token);
  const response = await fetch(url.toString(), {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(graphApiErrorMessage(payload, response.status));
  return payload;
}

function graphApiErrorMessage(payload: any, status: number) {
  const error = payload?.error || {};
  const details = [
    error.code ? `code ${error.code}` : "",
    error.error_subcode ? `subcode ${error.error_subcode}` : "",
    error.type ? String(error.type) : "",
  ].filter(Boolean).join(", ");
  const message = String(error.message || `Graph API respondio ${status}`);
  return details ? `${message} (${details})` : message;
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
          avatarUrl: extractWhatsAppContactAvatarUrl(contact),
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
          avatarUrl: extractWhatsAppContactAvatarUrl(contact),
          lastMessage: textBody,
          lastAt: at,
          unread: isEcho ? 0 : 1,
          unreadDelta: isEcho ? 0 : 1,
          unreadReset: isEcho,
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

async function sendWhatsAppLeadsToMetaCapi(payload: any) {
  const events = await buildWhatsAppLeadCapiEvents(payload);
  if (!events.length) {
    return { ok: true, skipped: true, reason: "no_real_inbound_messages", events: 0 };
  }

  const pixelId = metaPixelId();
  const token = metaCapiAccessToken();
  if (!pixelId || !token) {
    return { ok: false, skipped: true, reason: "missing_meta_capi_config", events: events.length };
  }

  try {
    const body: Record<string, unknown> = { data: events };
    const testEventCode = Deno.env.get("META_CAPI_TEST_EVENT_CODE") || Deno.env.get("META_TEST_EVENT_CODE") || "";
    if (testEventCode) body.test_event_code = testEventCode;
    const result = await graphJsonRequest(`/${pixelId}/events`, token, "POST", body);
    return {
      ok: true,
      events: events.length,
      eventsReceived: Number(result.events_received || 0),
      fbtraceId: String(result.fbtrace_id || ""),
    };
  } catch (error) {
    console.error("Meta CAPI Lead error", error instanceof Error ? error.message : error);
    return {
      ok: false,
      events: events.length,
      error: error instanceof Error ? error.message : "Meta CAPI no respondio",
    };
  }
}

async function buildWhatsAppLeadCapiEvents(payload: any) {
  const events = [];
  const siteUrl = Deno.env.get("BORMEX_SITE_URL") || Deno.env.get("PUBLIC_SITE_URL") || "https://bormex-souvenirs-web.vercel.app/";
  const eventName = Deno.env.get("META_CAPI_EVENT_NAME") || "Lead";
  const actionSource = Deno.env.get("META_CAPI_ACTION_SOURCE") || "website";
  const oldestAllowed = Math.floor(Date.now() / 1000) - 7 * 24 * 60 * 60;

  for (const entry of payload.entry || []) {
    for (const change of entry.changes || []) {
      const field = String(change.field || "messages");
      if (!field.toLowerCase().includes("messages")) continue;
      const value = change.value || {};
      const businessPhone = normalizePhone(value.metadata?.display_phone_number || Deno.env.get("WHATSAPP_DISPLAY_PHONE_NUMBER") || "");
      const messages = Array.isArray(value.messages) ? value.messages.filter(looksLikeWhatsAppMessage) : [];
      for (const message of messages) {
        const fromPhone = normalizePhone(message.from || message.sender?.wa_id || message.sender?.id || "");
        const toPhone = normalizePhone(message.to || message.recipient_id || message.recipient?.wa_id || message.recipient?.id || "");
        if (isWhatsAppEcho(message, field, fromPhone, businessPhone)) continue;
        const phone = fromPhone || toPhone;
        if (!phone) continue;

        const timestamp = Number(message.timestamp || 0);
        const eventTime = Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Math.floor(Date.now() / 1000);
        if (eventTime < oldestAllowed) continue;

        const referral = message.referral || message.context?.referral || {};
        const attribution = normalizeReferralAttribution(referral, "whatsapp_referral");
        const phoneHash = await sha256Hex(phone);
        const externalId = await sha256Hex(`whatsapp:${phone}`);
        const messageId = String(message.id || `${phone}_${message.timestamp || Date.now()}`);
        events.push({
          event_name: eventName,
          event_time: eventTime,
          event_id: `whatsapp_lead_${messageId}`,
          action_source: actionSource,
          event_source_url: String(referral.source_url || siteUrl),
          user_data: {
            ph: [phoneHash],
            external_id: [externalId],
          },
          custom_data: compactMetaCapiData({
            content_name: "WhatsApp real enviado",
            content_category: "BORMEX cotizacion",
            messaging_channel: "whatsapp",
            message_type: message.type || "unknown",
            business_phone_number_id: value.metadata?.phone_number_id,
            business_display_phone_number: value.metadata?.display_phone_number,
            referral_source_id: referral.source_id,
            referral_source_url: referral.source_url,
            referral_headline: referral.headline,
            ad_id: attribution.adId || normalizeAdId(referral.source_id || ""),
            ad_name: attribution.ad,
            adset_name: attribution.adset,
            campaign_name: attribution.campaign,
            ctwa_clid: attribution.ctwaClid || referral.ctwa_clid,
          }),
        });
      }
    }
  }

  return events;
}

function compactMetaCapiData(data: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

async function sha256Hex(value: string) {
  const encoded = new TextEncoder().encode(String(value || "").trim().toLowerCase());
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function syncConfirmedSaleToMeta(sale: Record<string, any>) {
  const [purchaseResult, audienceResult] = await Promise.allSettled([
    sendPurchaseEventToMeta(sale),
    syncBuyerAudience({ force: false }),
  ]);
  const purchase = purchaseResult.status === "fulfilled"
    ? purchaseResult.value
    : { ok: false, error: purchaseResult.reason instanceof Error ? purchaseResult.reason.message : "Error CAPI" };
  const audience = audienceResult.status === "fulfilled"
    ? audienceResult.value
    : { ok: false, error: audienceResult.reason instanceof Error ? audienceResult.reason.message : "Error de público" };
  const summary = {
    ok: purchase.ok && audience.ok,
    saleId: String(sale.id || ""),
    purchase,
    audience,
    at: new Date().toISOString(),
  };
  try {
    await setSetting("lastMetaCommerceSync", summary);
  } catch (error) {
    console.error("No se pudo guardar el resumen Meta Commerce", error instanceof Error ? error.message : error);
  }
  return summary;
}

async function sendPurchaseEventToMeta(sale: Record<string, any>) {
  const saleId = String(sale.id || "").trim();
  const phone = normalizePhone(sale.phone || "");
  const amount = Number(sale.amount || 0);
  if (!saleId || !phone || !Number.isFinite(amount) || amount <= 0) {
    return { ok: true, skipped: true, reason: "invalid_confirmed_sale", saleId };
  }

  const testEventCode = Deno.env.get("META_CAPI_TEST_EVENT_CODE") || Deno.env.get("META_TEST_EVENT_CODE") || "";
  const isTest = Boolean(testEventCode);
  const settings = await readSettings();
  const settingKey = `${META_PURCHASE_SETTING_PREFIX}${saleId}`;
  const previous = isTest ? undefined : settings[settingKey] as Record<string, any> | undefined;
  if (previous?.status === "sent") {
    return {
      ok: true,
      skipped: true,
      reason: "already_sent",
      saleId,
      eventId: String(previous.eventId || purchaseEventId(saleId)),
    };
  }

  const verification = await evaluateCrmSaleEvidence(sale, settings);
  if (!verification.ok) {
    return { ok: true, skipped: true, reason: verification.reason, saleId, requiresCrmEvidence: true };
  }

  const canonical = (await verifiedCrmSales(await readCollection("sales"), settings))
    .find(({ sale: candidate }) => normalizePhone(candidate.phone || "") === phone);
  if (!canonical || String(canonical.sale.id || "") !== saleId) {
    return { ok: true, skipped: true, reason: "duplicate_certified_first_purchase", saleId };
  }
  const eventTime = verification.eventTime;
  const now = Math.floor(Date.now() / 1000);
  if (eventTime < now - META_PURCHASE_MAX_AGE_SECONDS) {
    return { ok: true, skipped: true, reason: "outside_meta_7_day_window", saleId, eventTime };
  }

  const ctwaClid = String(sale.ctwaClid || "");
  if (!ctwaClid.trim()) {
    return { ok: false, skipped: true, reason: "missing_ctwa_clid", saleId };
  }
  const wabaId = String(Deno.env.get("WHATSAPP_BUSINESS_ACCOUNT_ID") || "").trim();
  if (!/^[1-9]\d*$/.test(wabaId)) {
    return { ok: false, skipped: true, reason: "missing_whatsapp_business_account_id", saleId };
  }
  const dataset = settings.metaMessagingDataset as Record<string, any> | undefined;
  const datasetId = String(dataset?.id || "").trim();
  const datasetWabaId = String(dataset?.wabaId || "").trim();
  if (!/^[1-9]\d*$/.test(datasetId) || !/^[1-9]\d*$/.test(datasetWabaId)) {
    return { ok: false, skipped: true, reason: "missing_or_invalid_meta_messaging_dataset", saleId };
  }
  if (datasetWabaId !== wabaId) {
    return { ok: false, skipped: true, reason: "meta_messaging_dataset_waba_mismatch", saleId };
  }
  const token = metaCapiAccessToken();
  if (!token) {
    return { ok: false, skipped: true, reason: "missing_meta_capi_config", saleId };
  }

  const eventId = isTest ? `bormex_purchase_test_${saleId}` : purchaseEventId(saleId);
  const products = Array.isArray(sale.products)
    ? sale.products.map((product: unknown) => String(product).trim()).filter(Boolean)
    : String(sale.product || "").split(/[|,]/).map((product) => product.trim()).filter(Boolean);
  const phoneHash = await sha256Hex(phone);
  const externalId = await sha256Hex(`bormex_buyer:${phone}`);
  const event = {
    event_name: "Purchase",
    event_time: Math.min(eventTime, now),
    event_id: eventId,
    action_source: "business_messaging",
    messaging_channel: "whatsapp",
    user_data: {
      ph: [phoneHash],
      external_id: [externalId],
      whatsapp_business_account_id: wabaId,
      ctwa_clid: ctwaClid,
    },
    custom_data: compactMetaCapiData({
      currency: "MXN",
      value: Math.round(amount * 100) / 100,
      order_id: saleId,
      content_name: products.join(", ") || "Souvenirs personalizados",
      content_category: "BORMEX venta confirmada",
      content_type: "product",
      content_ids: products,
      contents: products.map((product: string) => ({ id: product, quantity: 1 })),
      num_items: products.length || 1,
      ad_id: normalizeAdId(sale.adId || ""),
      ad_name: String(sale.ad || ""),
      adset_name: String(sale.adset || ""),
      campaign_id: String(sale.campaignId || ""),
      campaign_name: String(sale.campaign || ""),
      attribution_source: String(sale.attributionSource || ""),
    }),
  };

  if (!isTest) {
    const claimKey = `metaPurchaseClaim:${saleId}`;
    const claimResponse = await supabaseFetch("/rest/v1/bormex_settings?on_conflict=key", {
      method: "POST",
      headers: { prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify([{
        key: claimKey,
        value: { status: "claimed", eventId, eventTime: event.event_time, datasetId, wabaId, claimedAt: new Date().toISOString() },
      }]),
    });
    const claimRows = await claimResponse.json();
    if (!claimResponse.ok) {
      return { ok: false, skipped: true, reason: "purchase_claim_failed", saleId, eventId, error: String(claimRows?.message || "No se pudo reservar envio de compra") };
    }
    if (!Array.isArray(claimRows) || claimRows.length !== 1 || claimRows[0]?.key !== claimKey) {
      return { ok: true, skipped: true, reason: "delivery_in_progress_or_requires_review", saleId, eventId };
    }
    await setSetting(settingKey, {
      status: "pending",
      eventId,
      eventTime: event.event_time,
      updatedAt: new Date().toISOString(),
    });
  }

  try {
    const body: Record<string, unknown> = { data: [event] };
    if (testEventCode) body.test_event_code = testEventCode;
    const result = await graphJsonRequest(`/${datasetId}/events`, token, "POST", body);
    const eventsReceived = Number(result.events_received);
    if (!Number.isFinite(eventsReceived) || eventsReceived <= 0) {
      throw new Error("Meta CAPI no confirmo eventos recibidos");
    }
    const delivery = {
      status: isTest ? "test_received" : "sent",
      eventId,
      eventTime: event.event_time,
      eventsReceived,
      fbtraceId: String(result.fbtrace_id || ""),
      sentAt: new Date().toISOString(),
    };
    if (!isTest) {
      try {
        await setSetting(settingKey, delivery);
      } catch (error) {
        const message = error instanceof Error ? error.message : "No se pudo guardar acuse de compra";
        console.error("Meta CAPI Purchase delivery record error", saleId, message);
        return { ok: false, saleId, ...delivery, status: "delivery_record_requires_review", error: message };
      }
    }
    return { ok: true, saleId, ...delivery, ...(isTest ? { test: true } : {}) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Meta CAPI no respondio";
    console.error("Meta CAPI Purchase error", saleId, message);
    if (!isTest) {
      await setSetting(settingKey, {
        status: "failed",
        eventId,
        eventTime: event.event_time,
        error: message,
        updatedAt: new Date().toISOString(),
      });
    }
    return { ok: false, saleId, eventId, error: message, ...(isTest ? { test: true, status: "test_failed" } : {}) };
  }
}

async function syncEligiblePurchaseEvents() {
  const [sales, settings] = await Promise.all([readCollection("sales"), readSettings()]);
  const now = Math.floor(Date.now() / 1000);
  const verified = await verifiedCrmSales(sales, settings);
  const eligible = verified
    .filter(({ sale, verification }) => {
      const saleId = String(sale.id || "");
      if ((settings[`${META_PURCHASE_SETTING_PREFIX}${saleId}`] as any)?.status === "sent") return false;
      return verification.eventTime >= now - META_PURCHASE_MAX_AGE_SECONDS;
    })
    .sort((a, b) => a.verification.eventTime - b.verification.eventTime);

  const results = [];
  for (const { sale } of eligible) results.push(await sendPurchaseEventToMeta(sale));
  const failed = results.filter((result: any) => !result.ok);
  return {
    ok: failed.length === 0,
    totalCrmRows: sales.length,
    verifiedCrmSales: verified.length,
    excludedWithoutCertifiedCrmEvidenceOrScope: sales.length - verified.length,
    eligible: eligible.length,
    sent: results.filter((result: any) => result.ok && !result.skipped).length,
    skipped: results.filter((result: any) => result.skipped).length,
    failed: failed.length,
    errors: failed.map((result: any) => ({ saleId: result.saleId, error: result.error || result.reason })),
    at: new Date().toISOString(),
  };
}

function purchaseEventId(saleId: string) {
  return `bormex_purchase_${saleId}`;
}

function salePurchaseEventTime(sale: Record<string, any>) {
  const confirmedAt = Date.parse(String(sale.confirmedAt || ""));
  if (Number.isFinite(confirmedAt)) return Math.floor(confirmedAt / 1000);

  const timestampMatch = String(sale.id || "").match(/(?:^|_)(\d{13})(?:_|$)/);
  const idTimestamp = Number(timestampMatch?.[1] || 0);
  if (idTimestamp > 946684800000 && idTimestamp < Date.now() + 24 * 60 * 60 * 1000) {
    return Math.floor(idTimestamp / 1000);
  }

  const localDate = Date.parse(`${String(sale.date || new Date().toISOString().slice(0, 10)).slice(0, 10)}T12:00:00-06:00`);
  return Number.isFinite(localDate) ? Math.floor(localDate / 1000) : Math.floor(Date.now() / 1000);
}

function crmMoneyCents(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : null;
}

const CRM_SALE_EVIDENCE_SNAPSHOT_FIELDS = [
  "sourceFolio", "sourceNoteMessageId", "latestNoteMessageId", "sourceReceiptMessageId",
  "sourceNoteMediaId", "sourceReceiptMediaId", "latestNoteAt", "noteAt", "notePublishedAt", "noteDocumentAt",
  "receiptAt", "receiptReceivedAt", "receiptPublishedAt", "paymentProofReceivedAt", "paymentDocumentAt",
  "paymentDate", "paymentDocumentDate", "sourceMessageTime", "sourceFinancials", "noteEvidence", "receiptEvidence",
  "latestNoteEvidence", "earliestNoteEvidence", "sourceEvidence", "evidence", "audit", "paymentVerified",
  "paymentStatus", "verifiedBy", "verifiedAt", "firstPurchase", "paid", "balance", "products", "product", "productDetails",
];

function canonicalCrmEvidenceValue(value: any): any {
  if (Array.isArray(value)) return value.map(canonicalCrmEvidenceValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalCrmEvidenceValue(value[key])]));
  }
  return value;
}

async function crmSaleFingerprint(sale: Record<string, any>) {
  const evidenceSnapshot = canonicalCrmEvidenceValue(Object.fromEntries(
    CRM_SALE_EVIDENCE_SNAPSHOT_FIELDS.map((key) => [key, sale[key] ?? null]),
  ));
  const payload = JSON.stringify([
    String(sale.id || ""), normalizePhone(sale.phone || ""), normalizeAdId(sale.adId || ""),
    Math.round(Number(sale.amount) * 100), String(sale.date || ""),
    String(sale.confirmedAt || ""), String(sale.ctwaClid || ""), evidenceSnapshot,
  ]);
  // Use exact canonical JSON; sha256Hex lowercases strings and must not be used for snapshot fingerprints.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalCrmNoteUpdatedAt(value: unknown) {
  const text = String(value || "");
  const epoch = Date.parse(text);
  if (!Number.isFinite(epoch)) return "";
  const fraction = (text.match(/\.(\d+)/)?.[1] || "").padEnd(6, "0").slice(0, 6);
  return `${new Date(epoch).toISOString().slice(0, 19)}.${fraction}Z`;
}

async function crmNoteFingerprint(row: Record<string, any>) {
  const payload = JSON.stringify(canonicalCrmEvidenceValue({
    id: String(row.id || ""), data: row.data, updated_at: canonicalCrmNoteUpdatedAt(row.updated_at),
  }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readCrmFinancialNoteSnapshot(id: string) {
  const response = await supabaseFetch(`/rest/v1/bormex_notes?select=id,data,updated_at&id=eq.${encodeURIComponent(id)}&limit=1`);
  const rows = await response.json();
  if (!response.ok || !Array.isArray(rows) || rows.length !== 1 || String(rows[0]?.id || "") !== id) return null;
  return rows[0];
}

async function evaluateCrmSaleEvidence(sale: Record<string, any>, settings: Record<string, any>) {
  const fail = (reason: string) => ({ ok: false, reason, eventTime: 0 });
  const id = String(sale.id || "");
  const phone = normalizePhone(sale.phone || "");
  const adId = normalizeAdId(sale.adId || "");
  const amountCents = crmMoneyCents(sale.amount);
  if (!id || !phone || !adId || amountCents === null || amountCents <= 0) return fail("invalid_confirmed_sale");
  const record = settings[`${META_SALE_EVIDENCE_PREFIX}${id}`];
  if (!record || record.version !== 1 || record.status !== "verified" || record.source !== "crm") {
    return fail("crm_note_and_payment_proof_not_certified");
  }
  if (String(record.saleId || "") !== id || normalizePhone(record.phone || "") !== phone || normalizeAdId(record.adId || "") !== adId) {
    return fail("crm_evidence_identity_mismatch");
  }
  if (record.firstPurchase !== true) return fail("not_certified_first_purchase");
  if (record.scope !== "active_ads_since_first_delivery") return fail("crm_evidence_scope_not_certified");
  const policy = settings[META_SALES_SIGNAL_POLICY_SETTING];
  const expectedAccountId = String(metaAdAccountId() || "").replace(/^act_/, "");
  if (!policy || policy.version !== 1 || policy.source !== "crm" ||
      String(policy.accountId || "").replace(/^act_/, "") !== expectedAccountId ||
      !Array.isArray(policy.activeAdIds) || !policy.activeAdIds.includes(adId)) {
    return fail("ad_signal_scope_requires_refresh");
  }
  const firstDeliveryDate = String(policy.firstDeliveryDates?.[adId] || "");
  const saleDate = String(sale.date || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(firstDeliveryDate)) return fail("ad_first_delivery_not_verified");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(saleDate) || saleDate < firstDeliveryDate) return fail("sale_before_ad_first_delivery");
  if (!/^[a-f0-9]{64}$/.test(String(record.saleFingerprint || "")) || record.saleFingerprint !== await crmSaleFingerprint(sale)) {
    return fail("crm_sale_changed_since_verification");
  }
  const note = record.note || {};
  const payment = record.payment || {};
  if (!String(note.evidenceRef || "").trim() || note.latestForOrder !== true || !Number.isFinite(Date.parse(String(note.sentAt || "")))) {
    return fail("latest_sent_crm_note_not_certified");
  }
  if (!String(payment.evidenceRef || "").trim() || payment.verified !== true || payment.isDepositOrPaymentProof !== true ||
      !Number.isFinite(Date.parse(String(payment.receivedAt || "")))) {
    return fail("crm_deposit_payment_proof_not_certified");
  }
  if (payment.amount !== undefined && payment.amount !== null) {
    const paymentCents = crmMoneyCents(payment.amount);
    if (paymentCents === null || paymentCents <= 0) return fail("crm_payment_proof_amount_invalid");
  }
  const totalCents = crmMoneyCents(note.total);
  const ivaCents = crmMoneyCents(note.iva);
  if (!["crm_note_explicit", "certified_crm_financial"].includes(String(note.ivaBasis || "")) ||
      totalCents === null || ivaCents === null || ivaCents > totalCents) return fail("crm_note_net_value_not_certified");
  if (amountCents !== totalCents - ivaCents) return fail("crm_sale_amount_differs_from_note_net_total");
  if (note.crmNoteId || String(note.evidenceRef || "").includes("bormex_notes")) {
    const noteId = String(note.crmNoteId || "");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(noteId) ||
        !/^[a-f0-9]{64}$/.test(String(note.crmNoteFingerprint || ""))) return fail("crm_external_note_snapshot_not_certified");
    let row;
    try { row = await readCrmFinancialNoteSnapshot(noteId); }
    catch { return fail("crm_external_note_snapshot_unavailable"); }
    if (!row || !row.data || !canonicalCrmNoteUpdatedAt(row.updated_at)) return fail("crm_external_note_snapshot_unavailable");
    if (note.crmNoteFingerprint !== await crmNoteFingerprint(row)) return fail("crm_external_note_changed_since_verification");
    if (normalizePhone(row.data.clienteTelefono || "") !== phone ||
        (sale.sourceFolio && String(row.data.folio || "") !== String(sale.sourceFolio))) return fail("crm_external_note_identity_mismatch");
    if (crmMoneyCents(row.data.total) !== totalCents || crmMoneyCents(row.data.iva) !== ivaCents) {
      return fail("crm_external_note_financials_mismatch");
    }
  }
  const confirmedAt = Date.parse(String(record.confirmedAt || ""));
  const verifiedAt = Date.parse(String(record.verifiedAt || ""));
  const noteSentAt = Date.parse(String(note.sentAt || ""));
  const paymentReceivedAt = Date.parse(String(payment.receivedAt || ""));
  if (![confirmedAt, verifiedAt, noteSentAt, paymentReceivedAt].every((at) => Number.isFinite(at) && at > 0 && at <= Date.now())) {
    return fail("crm_purchase_timestamp_not_certified");
  }
  // Later note revisions may change the final value but cannot rejuvenate the first purchase.
  const saleConfirmedAtText = String(sale.confirmedAt || "");
  if (saleConfirmedAtText && (!Number.isFinite(Date.parse(saleConfirmedAtText)) || Date.parse(saleConfirmedAtText) !== confirmedAt)) {
    return fail("crm_purchase_timestamp_differs_from_sale");
  }
  const confirmedDateCDMX = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(confirmedAt));
  if (confirmedDateCDMX !== saleDate) return fail("crm_purchase_date_differs_from_sale");
  return { ok: true, reason: "verified_crm_first_purchase", eventTime: Math.floor(confirmedAt / 1000) };
}

async function verifiedCrmSales(sales: any[], settings: Record<string, any>) {
  const results = await Promise.all(sales.map(async (sale: any) => ({ sale, verification: await evaluateCrmSaleEvidence(sale, settings) })));
  const verified = results.filter(({ verification }) => verification.ok)
    .sort((a, b) => a.verification.eventTime - b.verification.eventTime || String(a.sale.id).localeCompare(String(b.sale.id)));
  // A certificate must assert first purchase. Keep one canonical first purchase per buyer even if two certificates were mistakenly supplied.
  const phones = new Set<string>();
  return verified.filter(({ sale }) => {
    const phone = normalizePhone(sale.phone || "");
    if (phones.has(phone)) return false;
    phones.add(phone);
    return true;
  });
}

async function ingestCrmSaleEvidence(body: any) {
  if (!Array.isArray(body.records) || body.records.length < 1 || body.records.length > 500) {
    return { ok: false, reason: "evidence_records_required_max_500" };
  }
  const ids = body.records.map((record: any) => String(record?.saleId || ""));
  if (new Set(ids).size !== ids.length) return { ok: false, reason: "duplicate_evidence_sale_ids" };
  const [sales, settings] = await Promise.all([readCollection("sales"), readSettings()]);
  const byId = new Map(sales.map((sale: any) => [String(sale.id || ""), sale]));
  const staged = { ...settings };
  const errors = [];
  for (const record of body.records) {
    const id = String(record.saleId || "");
    const sale = byId.get(id);
    if (!sale) { errors.push({ saleId: id, reason: "crm_sale_not_found" }); continue; }
    staged[`${META_SALE_EVIDENCE_PREFIX}${id}`] = record;
    const verification = await evaluateCrmSaleEvidence(sale, staged);
    if (!verification.ok) errors.push({ saleId: id, reason: verification.reason });
  }
  if (errors.length) return { ok: false, reason: "crm_evidence_rejected", errors, inserted: 0 };
  // This endpoint stores certification only. It cannot contact customers or trigger Meta uploads/events.
  for (const record of body.records) await setSetting(`${META_SALE_EVIDENCE_PREFIX}${String(record.saleId)}`, record);
  return { ok: true, verified: body.records.length, metaEventsSent: 0, at: new Date().toISOString() };
}

async function syncBuyerAudience(options: { force?: boolean } = {}) {
  const tokenCandidates = metaAudienceAccessTokens();
  const accountId = metaAdAccountId();
  if (!tokenCandidates.length || !accountId) {
    return { ok: false, skipped: true, reason: "missing_meta_ads_config" };
  }

  try {
    const [sales, settings] = await Promise.all([readCollection("sales"), readSettings()]);
    const verified = await verifiedCrmSales(sales, settings);
    const phones = uniqueBuyerPhones(verified.map(({ sale }) => sale));
    const hashes = await Promise.all(phones.map((phone) => sha256Hex(phone)));
    const fingerprint = await sha256Hex([...hashes].sort().join("|"));
    const previous = (settings[META_BUYER_SYNC_SETTING] || {}) as Record<string, any>;
    const storedAudience = (settings[META_BUYER_AUDIENCE_SETTING] || {}) as Record<string, any>;


    const tokenErrors = [];
    for (const candidate of tokenCandidates) {
      try {
        const audience = await ensureMetaBuyerAudience(candidate.token, accountId, storedAudience);
        if (!options.force && previous.audienceId === String(audience.id) && previous.sourceMode === "customer_list" && previous.fingerprint === fingerprint) {
          return {
            ok: true,
            skipped: true,
            reason: "audience_unchanged",
            audienceId: String(storedAudience.id),
            audienceName: META_BUYER_AUDIENCE_NAME,
            buyerCount: phones.length,
            fingerprint,
          };
        }

        const sourceMode = "customer_list";
        const previousHashes = previous.audienceId === String(audience.id) && Array.isArray(previous.uploadedHashes)
          ? [...new Set([...previous.uploadedHashes.map(String), ...(Array.isArray(previous.pendingRemovalHashes) ? previous.pendingRemovalHashes.map(String) : [])])] : [];
        const removals = previousHashes.filter((hash: string) => !hashes.includes(hash));
        for (const batch of chunk(removals, 500)) {
          if (!batch.length) continue;
          const removal = await graphFormRequest(`/${audience.id}/users`, candidate.token, "DELETE", {
            payload: JSON.stringify({ schema: "PHONE_SHA256", is_raw: false, data: batch }),
          });
          const removedCount = Number(removal.num_received);
          if (!Number.isFinite(removedCount) || removedCount !== batch.length) {
            throw new Error("Meta no confirmo recepcion de todas las bajas de audiencia");
          }
        }
        await setSetting(META_BUYER_SYNC_SETTING, {
          ...previous, status: "uploading", audienceId: String(audience.id), sourceMode,
          fingerprint: "", uploadedHashes: [...new Set([...previousHashes, ...hashes])],
          updatedAt: new Date().toISOString(),
        });
        const batches = chunk(hashes, 500);
        let received = 0;
        for (const batch of batches) {
          if (!batch.length) continue;
          const result = await graphFormRequest(`/${audience.id}/users`, candidate.token, "POST", {
            payload: JSON.stringify({ schema: "PHONE_SHA256", is_raw: false, data: batch }),
          });
          const count = Number(result.num_received);
          if (!Number.isFinite(count) || count !== batch.length) throw new Error("Meta no confirmo recepcion de todos los registros de audiencia");
          received += count;
        }

        const at = new Date().toISOString();
        const audienceSetting = {
          id: String(audience.id),
          name: META_BUYER_AUDIENCE_NAME,
          accountId,
          tokenSource: candidate.source,
          sourceMode,
          createdAt: String(storedAudience.createdAt || audience.time_created || at),
          verifiedAt: at,
        };
        const syncSetting = {
          status: "synced",
          audienceId: String(audience.id),
          tokenSource: candidate.source,
          sourceMode,
          fingerprint,
          buyerCount: phones.length,
          verifiedCrmSales: verified.length,
          totalCrmRows: sales.length,
          recordsReceived: received,
          matchCountConfirmed: false,
          batches: batches.length,
          uploadedHashes: hashes,
          pendingRemovalHashes: [],
          removedHashes: removals.length,
          syncedAt: at,
        };
        await Promise.all([
          setSetting(META_BUYER_AUDIENCE_SETTING, audienceSetting),
          setSetting(META_BUYER_SYNC_SETTING, syncSetting),
        ]);
        return {
          ok: true,
          audienceId: String(audience.id),
          audienceName: META_BUYER_AUDIENCE_NAME,
          tokenSource: candidate.source,
          sourceMode,
          buyerCount: phones.length,
          recordsReceived: received,
          batches: batches.length,
          fingerprint,
          syncedAt: at,
        };
      } catch (error) {
        tokenErrors.push(`${candidate.source}: ${error instanceof Error ? error.message : "error desconocido"}`);
      }
    }
    throw new Error(tokenErrors.join(" | "));
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo sincronizar el publico";
    console.error("Meta buyer audience error", message);
    try {
      const persisted = (await readSettings())[META_BUYER_SYNC_SETTING] || {};
      await setSetting(META_BUYER_SYNC_SETTING, {
        ...persisted,
        status: "failed",
        fingerprint: "",
        error: message,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      // The sale must remain saved even if both Meta and the settings write fail.
    }
    return { ok: false, skipped: true,
      reason: message.includes("customer_list_not_configured") ? "customer_list_not_configured" : "customer_list_sync_failed",
      error: message };
  }
}

async function ensureMetaBuyerAudience(token: string, accountId: string, stored: Record<string, any>) {
  if (!/^[1-9]\d*$/.test(String(stored.id || "")) || stored.sourceMode !== "customer_list") {
    throw new Error("customer_list_not_configured: legacy Purchase-rule audience is not historical CRM coverage");
  }
  const audience = await graphRequest(`/${stored.id}`, token, "GET", { fields: "id,name,subtype,account_id,time_created" });
  if (String(audience?.subtype || "").toUpperCase() !== "CUSTOM") {
    throw new Error("CRM customer-list audience must have CUSTOM subtype; no WEBSITE fallback");
  }
  if (String(audience?.account_id || "").replace(/^act_/, "") !== String(accountId).replace(/^act_/, "")) {
    throw new Error("CRM customer-list audience belongs to another ad account");
  }
  return { ...audience, sourceMode: "customer_list" };
}

async function listMetaBuyerAudiences(token: string, accountId: string) {
  const payload = await graphRequest(`/${accountId}/customaudiences`, token, "GET", {
    fields: "id,name,subtype,delivery_status,operation_status,approximate_count_lower_bound,approximate_count_upper_bound,time_created,time_updated",
    limit: "500",
  });
  return Array.isArray(payload.data) ? payload.data : [];
}

async function getMetaBuyerStatus() {
  const [sales, settings] = await Promise.all([readCollection("sales"), readSettings()]);
  const audienceSetting = (settings[META_BUYER_AUDIENCE_SETTING] || {}) as Record<string, any>;
  const syncSetting = (settings[META_BUYER_SYNC_SETTING] || {}) as Record<string, any>;
  const verified = await verifiedCrmSales(sales, settings);
  const counts: Record<string, number> = {};
  for (const sale of sales) {
    const verification = await evaluateCrmSaleEvidence(sale, settings);
    if (!verification.ok) counts[verification.reason] = (counts[verification.reason] || 0) + 1;
  }
  const individuallyVerifiedCount = sales.length - Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (individuallyVerifiedCount > verified.length) counts.duplicate_certified_first_purchase = individuallyVerifiedCount - verified.length;
  const purchaseRows = Object.entries(settings)
    .filter(([key]) => key.startsWith(META_PURCHASE_SETTING_PREFIX))
    .map(([, value]) => value as Record<string, any>);
  const token = metaAdsAccessToken();
  const accountId = metaAdAccountId();
  let meta: any = null;
  let audienceError = "";
  if (audienceSetting.id && token && accountId) {
    try { meta = await ensureMetaBuyerAudience(token, accountId, audienceSetting); }
    catch (error) { audienceError = error instanceof Error ? error.message : "No se pudo consultar Meta"; }
  }
  const now = Math.floor(Date.now() / 1000);
  const eligible = verified.filter(({ sale, verification }) => {
    const id = String(sale.id || "");
    return verification.eventTime >= now - META_PURCHASE_MAX_AGE_SECONDS &&
      (settings[`${META_PURCHASE_SETTING_PREFIX}${id}`] as any)?.status !== "sent" &&
      !settings[`metaPurchaseClaim:${id}`] && Boolean(String(sale.ctwaClid || "").trim());
  });
  const policy = settings[META_SALES_SIGNAL_POLICY_SETTING] || {};
  return {
    ok: !audienceError,
    signalPolicy: {
      source: "crm", scope: "active_ads_since_first_delivery", activeAdIds: policy.activeAdIds || [],
      firstDeliveryDates: policy.firstDeliveryDates || {}, updatedAt: policy.updatedAt || "",
    },
    audience: {
      configuredId: String(audienceSetting.id || ""), name: META_BUYER_AUDIENCE_NAME,
      configured: Boolean(audienceSetting.id && audienceSetting.sourceMode === "customer_list"),
      configurationReason: audienceSetting.id ? "" : "customer_list_not_configured",
      sourceMode: "customer_list", buyerCount: uniqueBuyerPhones(verified.map(({ sale }) => sale)).length,
      totalCrmRows: sales.length, verifiedCrmSales: verified.length, exclusions: counts,
      sync: syncSetting, meta, error: audienceError, matchCountConfirmed: false,
      legacyAudience: {
        id: String(settings.metaBuyerAudience?.id || ""),
        sourceMode: String(settings.metaBuyerAudience?.sourceMode || ""),
        historicalCrmUploadConfirmed: false,
      },
    },
    purchases: {
      totalSales: sales.length, verifiedCrmSales: verified.length,
      sent: purchaseRows.filter((row) => row.status === "sent").length,
      pending: purchaseRows.filter((row) => row.status === "pending").length,
      failed: purchaseRows.filter((row) => row.status === "failed").length,
      eligibleUnsent: eligible.length,
      verifiedHistoricalOutsideMetaWindow: verified.filter(({ verification }) => verification.eventTime < now - META_PURCHASE_MAX_AGE_SECONDS).length,
      exclusions: counts,
    },
    at: new Date().toISOString(),
  };
}

async function removeBuyerFromAudienceIfUnused(phoneValue: string) {
  const phone = normalizePhone(phoneValue);
  if (!phone) return { ok: true, skipped: true, reason: "missing_phone" };
  const [sales, settings] = await Promise.all([readCollection("sales"), readSettings()]);
  const verified = await verifiedCrmSales(sales, settings);
  if (verified.some(({ sale }) => normalizePhone(sale.phone || "") === phone)) {
    return { ok: true, skipped: true, reason: "buyer_has_other_sales" };
  }
  const audience = (settings[META_BUYER_AUDIENCE_SETTING] || {}) as Record<string, any>;
  const token = metaAdsAccessToken();
  if (!audience.id || !token) return { ok: true, skipped: true, reason: "audience_not_configured" };
  if (audience.sourceMode !== "customer_list") {
    return { ok: true, skipped: true, reason: "verified_customer_list_not_configured" };
  }
  try {
    await ensureMetaBuyerAudience(token, metaAdAccountId(), audience);
    const hash = await sha256Hex(phone);
    const result = await graphFormRequest(`/${audience.id}/users`, token, "DELETE", {
      payload: JSON.stringify({ schema: "PHONE_SHA256", is_raw: false, data: [hash] }),
    });
    const removedCount = Number(result.num_received);
    if (!Number.isFinite(removedCount) || removedCount !== 1) {
      throw new Error("Meta no confirmo recepcion de la baja del comprador");
    }
    await setSetting(META_BUYER_SYNC_SETTING, {
      ...(settings[META_BUYER_SYNC_SETTING] as Record<string, any> || {}),
      fingerprint: "",
      buyerCount: uniqueBuyerPhones(verified.map(({ sale }) => sale)).length,
      lastRemovalAt: new Date().toISOString(),
    });
    return { ok: true, removed: removedCount, audienceId: String(audience.id) };
  } catch (error) {
    const message = error instanceof Error ? error.message : "No se pudo retirar el comprador";
    console.error("Meta buyer removal error", message);
    try {
      const previous = (settings[META_BUYER_SYNC_SETTING] || {}) as Record<string, any>;
      const hash = await sha256Hex(phone);
      await setSetting(META_BUYER_SYNC_SETTING, {
        ...previous, status: "removal_pending", fingerprint: "",
        pendingRemovalHashes: [...new Set([...(Array.isArray(previous.pendingRemovalHashes) ? previous.pendingRemovalHashes : []), hash])],
        error: message, updatedAt: new Date().toISOString(),
      });
    } catch { /* Retain previous acknowledged membership if status persistence also fails. */ }
    return { ok: false, reason: "customer_list_removal_pending", error: message };
  }
}

function uniqueBuyerPhones(sales: any[]) {
  return [...new Set(
    sales
      .filter((sale: any) => Number(sale.amount || 0) > 0)
      .map((sale: any) => normalizePhone(sale.phone || ""))
      .filter(Boolean),
  )].sort();
}

function chunk<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
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
      const avatarUrl = extractMetaAvatarUrl(event, entry);
      conversations.push({
        id: conversationId,
        channel,
        contactId,
        phone: "",
        name: contactId,
        avatarUrl,
        lastMessage: textBody,
        lastAt: at,
        unread: isEcho ? 0 : 1,
        unreadDelta: isEcho ? 0 : 1,
        unreadReset: isEcho,
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
  const attachments = Array.isArray(message.attachments) ? message.attachments : message.attachments?.data || [];
  return attachments.map((attachment: any) => ({
    type: attachment.type || (attachment.image_data ? "image" : attachment.video_data ? "video" : inferMediaType(attachment.mime_type || attachment.name) || "document"),
    url: attachment.payload?.url || attachment.image_data?.url || attachment.video_data?.url || attachment.file_url || attachment.url || "",
    id: String(attachment.id || attachment.payload?.attachment_id || ""),
    mimeType: attachment.mime_type || "",
    filename: attachment.name || "",
    title: attachment.title || "",
  }));
}

async function enrichMetaConversationProfiles(conversations: Array<Record<string, any>>) {
  const targets = new Map<string, Record<string, any>>();
  for (const conversation of conversations) {
    if (!conversation.contactId || conversation.avatarUrl) continue;
    targets.set(`${conversation.channel}:${conversation.contactId}`, conversation);
  }
  for (const conversation of [...targets.values()].slice(0, 12)) {
    try {
      const profile = await fetchMetaMessagingProfile(String(conversation.channel || ""), String(conversation.contactId || ""));
      if (!profile) continue;
      for (const item of conversations) {
        if (item.channel !== conversation.channel || item.contactId !== conversation.contactId) continue;
        if (profile.avatarUrl) item.avatarUrl = profile.avatarUrl;
        if (profile.name && item.name === item.contactId) item.name = profile.name;
      }
    } catch {
      // Webhook delivery should keep working even when Meta withholds profile details.
    }
  }
}

async function fetchMetaMessagingProfile(channel: string, contactId: string) {
  const token = channel === "instagram" ? instagramAccessToken() || messengerAccessToken() : messengerAccessToken();
  if (!token || !contactId) return null;
  const fields = channel === "instagram"
    ? "name,username,profile_pic"
    : "first_name,last_name,name,profile_pic,picture";
  const payload = await graphRequest(`/${contactId}`, token, "GET", { fields });
  const name = [payload.first_name, payload.last_name].filter(Boolean).join(" ") || payload.name || payload.username || "";
  const avatarUrl = extractFirstHttpUrl(payload.profile_pic, payload.picture?.data?.url, payload.picture);
  return { name: String(name || ""), avatarUrl };
}

function extractMetaAvatarUrl(event: any, entry: any) {
  return extractFirstHttpUrl(
    event.sender?.profile_pic,
    event.sender?.profile_pic_url,
    event.sender?.picture?.data?.url,
    event.sender?.picture,
    event.profile_pic,
    event.profile_pic_url,
    entry.profile_pic,
    entry.profile_pic_url,
  );
}

function extractWhatsAppContactAvatarUrl(contact: any) {
  return extractFirstHttpUrl(
    contact.profile?.profile_pic,
    contact.profile?.profile_pic_url,
    contact.profile?.picture?.data?.url,
    contact.profile?.picture,
    contact.profile?.avatar,
    contact.profile_pic,
    contact.profile_pic_url,
    contact.picture,
    contact.avatar,
    contact.photo,
    contact.image,
  );
}

function extractFirstHttpUrl(...values: unknown[]) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (/^https?:\/\//i.test(text)) return text;
  }
  return "";
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
    ctwaClid: String(body.ctwaClid || body.ctwa_clid || ""),
    sourceUrl: String(body.sourceUrl || body.source_url || ""),
    attributionSource: String(body.attributionSource || ""),
    sourceConversationId: String(body.sourceConversationId || ""),
    confirmedAt: String(body.confirmedAt || body.confirmed_at || ""),
  };
}

async function enrichSaleAttribution(sale: Record<string, any>) {
  const attribution = await findSaleAttributionFromDb(sale);
  if (!attribution) {
    return {
      ...sale,
      attributionSource: sale.attributionSource || (hasAttribution(sale) ? "manual_sale_attribution" : "missing_meta_referral"),
    };
  }
  return {
    ...sale,
    adId: sale.adId || attribution.adId || "",
    ad: sale.ad || attribution.ad || "",
    adset: sale.adset || attribution.adset || "",
    campaign: sale.campaign || attribution.campaign || "",
    campaignId: sale.campaignId || attribution.campaignId || "",
    ctwaClid: sale.ctwaClid || attribution.ctwaClid || "",
    sourceUrl: sale.sourceUrl || attribution.sourceUrl || "",
    attributionSource: sale.attributionSource || attribution.attributionSource || "auto_sale_attribution",
  };
}

async function findSaleAttributionFromDb(sale: Record<string, any>) {
  const sourceConversationId = String(sale.sourceConversationId || "").trim();
  const phone = normalizePhone(sale.phone || "");
  const [directConversation, phoneConversations, contactConversations, leads] = await Promise.all([
    sourceConversationId ? readItemById("conversations", sourceConversationId) : Promise.resolve(null),
    phone ? readCollectionByJsonField("conversations", "phone", phone, { limit: 10 }) : Promise.resolve([]),
    phone ? readCollectionByJsonField("conversations", "contactId", phone, { limit: 10 }) : Promise.resolve([]),
    phone ? readCollectionByJsonField("leads", "phone", phone, { limit: 20 }) : Promise.resolve([]),
  ]);
  const conversations = compactItemsById([
    ...(directConversation ? [directConversation] : []),
    ...phoneConversations,
    ...contactConversations,
  ]);
  const context = {
    ...structuredClone(defaultDb),
    conversations,
    leads,
  };
  const directAttribution = findSaleAttribution(sale, context);
  if (directAttribution) return directAttribution;

  const messagePages = await Promise.all(
    conversations.slice(0, 3).map((conversation: any) =>
      readConversationMessages(String(conversation.id || ""), { limit: 100 }).catch(() => ({ messages: [] }))
    ),
  );
  context.messages = messagePages.flatMap((page: any) => page.messages || []);
  return findSaleAttribution(sale, context);
}

function findSaleAttribution(sale: Record<string, any>, db: typeof defaultDb) {
  const conversation = findConversationForSale(sale, db);
  return (
    extractAttribution(conversation, "conversation") ||
    extractAttribution(findLeadForSaleRecord(sale, db), "lead") ||
    extractAttribution(findMessageAttributionForSale(sale, conversation, db), "message_referral")
  );
}

function findConversationForSale(sale: Record<string, any>, db: typeof defaultDb) {
  const sourceConversationId = String(sale.sourceConversationId || "");
  if (sourceConversationId) {
    const direct = (db.conversations || []).find((conversation: any) => String(conversation.id || "") === sourceConversationId);
    if (direct) return direct;
  }
  const phone = normalizePhone(sale.phone || "");
  if (!phone) return null;
  return [...(db.conversations || [])]
    .filter((conversation: any) => normalizePhone(conversation.phone || conversation.contactId || "") === phone)
    .sort((a: any, b: any) => Date.parse(String(b.lastAt || "")) - Date.parse(String(a.lastAt || "")))[0] || null;
}

function findLeadForSaleRecord(sale: Record<string, any>, db: typeof defaultDb) {
  const phone = normalizePhone(sale.phone || "");
  if (!phone) return null;
  return [...(db.leads || [])]
    .filter((lead: any) => normalizePhone(lead.phone || "") === phone)
    .sort((a: any, b: any) => Date.parse(String(b.date || "")) - Date.parse(String(a.date || "")))[0] || null;
}

function findMessageAttributionForSale(sale: Record<string, any>, conversation: any, db: typeof defaultDb) {
  const phone = normalizePhone(sale.phone || conversation?.phone || conversation?.contactId || "");
  const conversationId = String(sale.sourceConversationId || conversation?.id || "");
  return [...(db.messages || [])]
    .filter((message: any) => {
      if (conversationId && String(message.conversationId || "") === conversationId) return true;
      return phone && [message.from, message.to].some((value) => normalizePhone(value || "") === phone);
    })
    .filter(hasAttribution)
    .sort((a: any, b: any) => Number(Boolean(normalizeAdId(b.adId || ""))) - Number(Boolean(normalizeAdId(a.adId || ""))))[0] || null;
}

function extractAttribution(record: any, source: string) {
  if (!hasAttribution(record)) return null;
  return {
    adId: normalizeAdId(record.adId || record.ad_id || record.metaAdId || ""),
    ad: String(record.ad || ""),
    adset: String(record.adset || ""),
    campaign: String(record.campaign || ""),
    campaignId: String(record.campaignId || ""),
    ctwaClid: String(record.ctwaClid || ""),
    sourceUrl: String(record.sourceUrl || ""),
    attributionSource: String(record.attributionSource || source),
  };
}

function hasAttribution(record: any) {
  if (!record) return false;
  return Boolean(
    normalizeAdId(record.adId || record.ad_id || record.metaAdId || "") ||
      record.ad ||
      record.adset ||
      record.campaign ||
      record.campaignId ||
      record.ctwaClid ||
      record.sourceUrl,
  );
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

async function metaAppSecretProof(token: string, secret = metaAppSecret()) {
  if (!secret || !token) return "";

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function metaAdsAccessToken() {
  return Deno.env.get("META_ADS_ACCESS_TOKEN") || Deno.env.get("META_ACCESS_TOKEN") || "";
}

function metaAudienceAccessTokens() {
  const candidates = [
    { source: "META_ADS_ACCESS_TOKEN", token: Deno.env.get("META_ADS_ACCESS_TOKEN") || "" },
    { source: "META_ACCESS_TOKEN", token: Deno.env.get("META_ACCESS_TOKEN") || "" },
    { source: "META_CAPI_ACCESS_TOKEN", token: Deno.env.get("META_CAPI_ACCESS_TOKEN") || "" },
  ];
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (!candidate.token || seen.has(candidate.token)) return false;
    seen.add(candidate.token);
    return true;
  });
}

function metaAdAccountId() {
  const raw = String(Deno.env.get("META_AD_ACCOUNT_ID") || "").trim();
  if (!raw) return "";
  return raw.startsWith("act_") ? raw : `act_${raw}`;
}

function metaCapiAccessToken() {
  return Deno.env.get("META_CAPI_ACCESS_TOKEN") || metaAdsAccessToken();
}

function metaPixelId() {
  return Deno.env.get("META_PIXEL_ID") || Deno.env.get("META_DATASET_ID") || "1150202023932183";
}

function whatsappAccessToken() {
  return Deno.env.get("WHATSAPP_ACCESS_TOKEN") || Deno.env.get("META_ACCESS_TOKEN") || "";
}

function whatsappSendAccessToken() {
  const sendToken = Deno.env.get("WHATSAPP_SEND_ACCESS_TOKEN") || Deno.env.get("WHATSAPP_COEX_ACCESS_TOKEN") || "";
  if (sendToken) return sendToken;
  return Deno.env.get("WHATSAPP_USE_ACCESS_TOKEN_FOR_SEND") === "true" ? whatsappAccessToken() : "";
}

function whatsappMediaAccessToken() {
  return whatsappSendAccessToken() || whatsappAccessToken();
}

function whatsappMediaCredentials() {
  const token = Deno.env.get("WHATSAPP_MEDIA_ACCESS_TOKEN") || "";
  const appSecret = Deno.env.get("WHATSAPP_MEDIA_APP_SECRET") || "";
  if (token || appSecret) {
    if (!token.trim() || !appSecret.trim()) {
      throw new HttpError(503, "Configura juntas WHATSAPP_MEDIA_ACCESS_TOKEN y WHATSAPP_MEDIA_APP_SECRET para appsecret_proof de medios");
    }
    return { token, appSecret };
  }
  return { token: whatsappMediaAccessToken(), appSecret: metaAppSecret() };
}

function whatsappMediaReadError(stage: "credentials" | "proof" | "metadata" | "binary", error: unknown, upstreamStatus = 0) {
  const location = stage === "metadata" ? "metadatos" : stage === "binary" ? "archivo" : stage === "proof" ? "prueba" : "credenciales";
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : String(error || "");
  const status = error instanceof HttpError ? error.status : upstreamStatus;
  if (stage === "credentials") {
    if (status === 400) return new HttpError(400, "Falta identificador de medio");
    return new HttpError(503, "Configura credenciales de medios emparejadas para appsecret_proof");
  }
  if (stage === "proof") return new HttpError(503, "No se pudo generar appsecret_proof de medios");
  if (/(?:^|\s)(?:invalid|missing)\s+appsecret_proof\b|\bappsecret_proof\s+(?:(?:is|es)\s+)?(?:required|requerid[oa]|missing|invalid|not provided|no es v[aá]lid[oa])\b|\brequires?(?:\s+an?)?\s+appsecret_proof\b/i.test(message)) {
    return new HttpError(503, `appsecret_proof de medios no valido o ausente (${location})`);
  }
  if (status === 401 || /invalid oauth access token|invalid access token|error validating access token|(?:code[\s"':]*)(?:190|102)\b/i.test(message)) {
    return new HttpError(401, `Invalid access token de medios (${location})`);
  }
  if (status === 403 || /permissions?|permission denied|(?:code[\s"':]*)(?:10|200)\b/i.test(message)) {
    return new HttpError(403, `Permisos de medios insuficientes (${location})`);
  }
  if (status === 429 || /rate limit|request limit|(?:code[\s"':]*)(?:4|17|32|613)\b/i.test(message)) {
    return new HttpError(429, `Limite temporal de medios (rate limit; ${location})`);
  }
  if (status === 404) return new HttpError(404, `Medio no disponible (${location})`);
  return new HttpError(502, `No se pudo leer el medio (${location})`);
}

function whatsappMediaStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch {
        controller.error(new HttpError(502, "No se pudo leer el medio (archivo)"));
      }
    },
    async cancel() {
      try {
        await reader.cancel();
      } catch {
        throw new HttpError(502, "No se pudo cancelar la lectura del medio");
      }
    },
  });
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

async function rememberWebhookEvent(
  source: string,
  body: any,
  parsed: { leads?: unknown[]; messages?: unknown[]; conversations?: unknown[]; metaCapi?: unknown },
) {
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
    metaCapi: parsed.metaCapi || null,
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
  response.headers.set("access-control-allow-headers", "authorization, content-type, range, x-cron-secret");
  response.headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  return response;
}

// Social inbox and private media. Credentials never leave this server.
type SocialTarget = { channel: string; accountId: string; pageId: string; token: string; host: string };

async function socialTarget(channel: string): Promise<SocialTarget> {
  if (!["messenger", "instagram"].includes(channel)) throw new HttpError(400, "Canal no soportado");
  const nativeInstagram = channel === "instagram" && Deno.env.get("INSTAGRAM_LOGIN_MODE") === "instagram";
  let accountId = channel === "messenger" ? messengerPageId() : instagramAccountId();
  let pageId = messengerPageId();
  let token = channel === "messenger" ? messengerAccessToken() : instagramAccessToken() || messengerAccessToken();
  if (!token) throw new HttpError(503, `Falta conectar ${channel === "messenger" ? "la página de Messenger" : "la cuenta de Instagram"} con el CRM`);
  if (!accountId || (!nativeInstagram && channel === "instagram" && !pageId)) throw new HttpError(503, channel === "messenger"
    ? "Messenger pendiente de conexión: falta una página accesible y su token con permiso de mensajes."
    : "Instagram pendiente de conexión: falta la cuenta profesional y su token con permiso de mensajes.");
  return { channel, accountId, pageId, token, host: nativeInstagram ? "graph.instagram.com" : "graph.facebook.com" };
}

async function socialGraph(target: SocialTarget, path: string, method = "GET", body?: unknown) {
  const url = new URL(`https://${target.host}/${graphVersion()}${path}`);
  const headers = new Headers({ authorization: `Bearer ${target.token}` });
  if (body) headers.set("content-type", "application/json");
  const response = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25000) });
  const payload = await response.json();
  if (!response.ok) throw new HttpError(response.status === 401 || response.status === 403 ? 503 : 502, graphApiErrorMessage(payload, response.status));
  return payload;
}

async function syncSocialInbox(options: any) {
  const channel = String(options.channel || "");
  const target = await socialTarget(channel);
  const params = new URLSearchParams({ fields: "id,participants,updated_time", limit: "15" });
  if (target.host === "graph.facebook.com") params.set("platform", channel);
  if (options.after) params.set("after", String(options.after).slice(0, 2000));
  const listId = target.host === "graph.facebook.com" ? target.pageId || target.accountId : target.accountId;
  const listing = await socialGraph(target, `/${listId}/conversations?${params}`);
  const conversations: any[] = [];
  const messages: any[] = [];
  let messagesHaveMore = false;
  for (const thread of listing.data || []) {
    const page = await socialGraph(target, `/${encodeURIComponent(thread.id)}/messages?fields=id,message,from,to,created_time,attachments&limit=100`);
    messagesHaveMore ||= Boolean(page.paging?.next);
    const participants = thread.participants?.data || [];
    const businessIds = new Set([target.accountId, target.pageId]);
    const contact = participants.find((p: any) => !businessIds.has(String(p.id)));
    if (!contact?.id) continue;
    const contactId = String(contact.id);
    const conversationId = `${channel}_${contactId}`;
    const records = (page.data || []).map((item: any) => ({
      id: String(item.id), conversationId, channel,
      direction: businessIds.has(String(item.from?.id)) ? "outbound" : "inbound",
      from: String(item.from?.id || ""), to: String(item.to?.data?.[0]?.id || ""),
      text: String(item.message || ""), at: item.created_time, status: "received",
      attachments: extractMetaMessageAttachments(item),
    })).filter((item: any) => item.id && Number.isFinite(Date.parse(item.at)));
    records.sort((a: any,b: any) => Date.parse(a.at)-Date.parse(b.at));
    const latest = records.at(-1);
    if (!latest) continue;
    const previous = await readItemById("conversations", conversationId);
    if (!previous || Date.parse(latest.at) >= Date.parse(previous.lastAt || "")) {
      conversations.push({ id: conversationId, channel, contactId, phone: "", name: contact.name || contact.username || previous?.name || contactId,
        providerConversationId: String(thread.id), businessAccountId: target.accountId,
        lastMessage: latest.text || `[${latest.attachments[0]?.type || "archivo"}]`, lastAt: latest.at });
    }
    messages.push(...records);
  }
  // Historical reads preserve existing records (including private uploaded files).
  const existing = new Map((await readItemsByIds("messages", messages.map(m => m.id))).map((m: any) => [m.id, m]));
  const known = new Set(existing.keys());
  await upsertItems("messages", messages.filter(m => !known.has(m.id)));
  await upsertItems("conversations", conversations);
  return { partial: true, conversations, messages: messages.map(m => existing.get(m.id) || m), channel, imported: messages.filter(m => !known.has(m.id)).length,
    nextAfter: listing.paging?.next ? listing.paging?.cursors?.after || "" : "", messagesHaveMore };
}

const CRM_MEDIA_BUCKET = "bormex-crm-media";

function whatsappSendAppSecret() {
  const explicit = String(Deno.env.get("WHATSAPP_SEND_APP_SECRET") || "").trim();
  if (explicit) return explicit;
  // Reuse a proof only when the existing dedicated media token is exactly the
  // effective send token. Never guess an app secret or enable global signatures.
  const mediaToken = String(Deno.env.get("WHATSAPP_MEDIA_ACCESS_TOKEN") || "").trim();
  if (mediaToken && mediaToken === whatsappSendAccessToken()) return String(Deno.env.get("WHATSAPP_MEDIA_APP_SECRET") || "").trim();
  return "";
}

async function whatsappSendEndpoint(phoneNumberId: string, edge: string, token: string) {
  const url = new URL(`https://graph.facebook.com/${graphVersion()}/${phoneNumberId}/${edge}`);
  const secret = whatsappSendAppSecret();
  if (secret) url.searchParams.set("appsecret_proof", await metaAppSecretProof(token, secret));
  return url;
}

async function crmStorageFetch(path: string, options: RequestInit = {}) {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || readFirstSecretKey();
  const base = Deno.env.get("SUPABASE_URL");
  if (!base || !key) throw new HttpError(503, "Almacenamiento no configurado");
  const headers = new Headers(options.headers);
  headers.set("authorization", `Bearer ${key}`);
  headers.set("apikey", key);
  return fetch(`${base}/storage/v1${path}`, { ...options, headers });
}

function validCrmStoragePath(path: string) {
  return /^uploads\/[0-9a-f-]{36}\/[a-zA-Z0-9_.-]{1,140}$/.test(path);
}

async function readCrmUpload(path: string) {
  if (!validCrmStoragePath(path)) throw new HttpError(400, "Archivo no válido");
  const params = new URLSearchParams({ select: "value", key: `eq.crmUpload:${path}`, limit: "1" });
  const response = await supabaseFetch(`/rest/v1/bormex_settings?${params}`);
  const rows = await response.json();
  if (!response.ok || !rows[0]?.value) throw new HttpError(404, "Archivo no encontrado");
  return rows[0].value;
}

async function signedCrmMediaUrl(path: string) {
  if (!validCrmStoragePath(path)) throw new HttpError(400, "Archivo no válido");
  const response = await crmStorageFetch(`/object/sign/${CRM_MEDIA_BUCKET}/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }),
  });
  const payload = await response.json();
  if (!response.ok || !payload.signedURL) throw new HttpError(502, "No se pudo preparar el archivo");
  return `${Deno.env.get("SUPABASE_URL")}/storage/v1${payload.signedURL}`;
}

async function uploadCrmMedia(form: FormData) {
  const channel = String(form.get("channel") || "");
  const conversationId = String(form.get("conversationId") || "");
  const conversation = await readItemById("conversations", conversationId);
  if (!conversation || conversation.channel !== channel) throw new HttpError(400, "Selecciona una conversación válida");
  if (!["whatsapp", "messenger", "instagram"].includes(channel)) throw new HttpError(400, "Canal no soportado");
  const file = form.get("file");
  if (!(file instanceof File) || !file.size) throw new HttpError(400, "Selecciona un archivo válido");
  const type = inferMediaType(file.type) || inferMediaType(file.name) || "document";
  if (channel === "instagram" && type === "document") throw new HttpError(400, "Instagram permite fotos, videos y audio en este formulario");
  const limit = channel === "whatsapp" ? mediaUploadLimit(type) : (type === "image" ? 8 : 25) * 1024 * 1024;
  if (file.size > limit) throw new HttpError(400, `El límite para este archivo es ${formatMegabytes(limit)}`);
  // Keep the existing WhatsApp route for documents beyond the Storage plan limit.
  if (channel === "whatsapp" && file.size > 50 * 1024 * 1024) return uploadWhatsAppMedia(form);
  if (channel !== "whatsapp") await socialTarget(channel);
  const bucket = await crmStorageFetch(`/bucket/${CRM_MEDIA_BUCKET}`);
  if (bucket.status === 404 || bucket.status === 400) {
    const created = await crmStorageFetch("/bucket", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: CRM_MEDIA_BUCKET, name: CRM_MEDIA_BUCKET, public: false, file_size_limit: 52428800 }) });
    if (!created.ok && created.status !== 409) {
      const detail = await created.json().catch(() => ({}));
      console.error("crm_media_bucket", created.status, detail.message || detail.error || "");
      throw new HttpError(502, "No se pudo preparar el almacenamiento privado");
    }
  } else if (!bucket.ok) throw new HttpError(502, "No se pudo comprobar el almacenamiento privado");
  const filename = (file.name || `archivo.${extensionForMedia(file.type, type)}`).replace(/[^a-zA-Z0-9_.-]/g, "_").slice(-120) || "archivo";
  const storagePath = `uploads/${crypto.randomUUID()}/${filename}`;
  const response = await crmStorageFetch(`/object/${CRM_MEDIA_BUCKET}/${storagePath}`, {
    method: "POST", headers: { "content-type": file.type || "application/octet-stream", "x-upsert": "false" }, body: file,
  });
  if (!response.ok) throw new HttpError(502, "No se pudo guardar el archivo. Intenta de nuevo.");
  const metadata = { channel, conversationId, type, filename: file.name || filename, mimeType: file.type, storagePath, size: file.size, at: new Date().toISOString() };
  await setSetting(`crmUpload:${storagePath}`, metadata);
  if (channel === "whatsapp") {
    const upload = await uploadWhatsAppMedia(form);
    return { ...upload, storagePath };
  }
  return { ok: true, ...metadata };
}

function safeMetaMediaUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
      ["fbcdn.net", "cdninstagram.com", "fbsbx.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch { return false; }
}

async function downloadMessageAttachment(messageId: string, index: number, req: Request) {
  const message = await readItemById("messages", messageId);
  let attachment = message?.attachments?.[index];
  if (!attachment) throw new HttpError(404, "Archivo no encontrado");
  if (message.channel === "whatsapp" && attachment.id && !attachment.storagePath) {
    return downloadWhatsAppMedia(String(attachment.id), req, attachment.filename || "");
  }
  let url = attachment.storagePath ? await signedCrmMediaUrl(attachment.storagePath) : String(attachment.url || "");
  if (!attachment.storagePath && !safeMetaMediaUrl(url)) throw new HttpError(404, "Meta no entregó una dirección válida para el archivo");
  const headers = new Headers();
  if (req.headers.get("range")) headers.set("range", req.headers.get("range")!);
  let response = await fetch(url, { headers, redirect: "error" });
  if (!response.ok && !attachment.storagePath && ["messenger", "instagram"].includes(message.channel)) {
    const target = await socialTarget(message.channel);
    const fresh = await socialGraph(target, `/${encodeURIComponent(messageId)}?fields=attachments`);
    const attachments = extractMetaMessageAttachments(fresh);
    attachment = attachments[index];
    url = String(attachment?.url || "");
    if (!safeMetaMediaUrl(url)) throw new HttpError(410, "Meta ya no ofrece este archivo");
    response = await fetch(url, { headers, redirect: "error" });
    if (response.ok) await upsertItems("messages", [{ ...message, attachments }]);
  }
  if (!response.ok || !response.body) throw new HttpError(response.status === 416 ? 416 : 410, "No se pudo abrir el archivo; Meta puede haberlo retirado o su acceso puede haber vencido");
  const output = new Headers({ "content-type": response.headers.get("content-type") || attachment.mimeType || "application/octet-stream",
    "cache-control": "private, max-age=300", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  for (const header of ["content-length", "content-range", "accept-ranges"]) {
    const value = response.headers.get(header); if (value) output.set(header, value);
  }
  const filename = String(attachment.filename || "archivo").replace(/[^a-zA-Z0-9_.-]/g, "_");
  output.set("content-disposition", `inline; filename="${filename}"`);
  return cors(new Response(response.body, { status: response.status, headers: output }));
}
