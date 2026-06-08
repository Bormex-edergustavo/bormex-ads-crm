const SAFE_BUDGET_STEP = 0.15;

Deno.serve(async (req) => {
  try {
    if (req.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    const url = new URL(req.url);
    const pathname = normalizePath(url.pathname);
    if (!isAdsAccess(req)) return text("Autenticación Ads requerida", 401);

    const match = pathname.match(/^\/api\/adsets\/([^/]+)$/);
    if (!match || req.method !== "POST") return text("Not found", 404);

    const adsetId = decodeURIComponent(match[1]);
    const body = await readJson(req);
    return json(await updateAdset(adsetId, body));
  } catch (error) {
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

async function updateAdset(adsetId: string, body: Record<string, unknown>) {
  if (!/^\d{8,}$/.test(adsetId)) throw new HttpError(400, "ID de conjunto inválido");
  const action = String(body.action || "").trim();
  if (!["preview", "pause", "activate", "increase_budget", "decrease_budget"].includes(action)) {
    throw new HttpError(400, "Acción no permitida");
  }

  const before = await fetchAdset(adsetId);
  if (action === "preview") {
    const snapshot = normalizeAdsetSnapshot(before);
    return { ok: true, action, adsetId, before: snapshot, after: snapshot };
  }
  const patch = new URLSearchParams();

  if (action === "pause") patch.set("status", "PAUSED");
  if (action === "activate") patch.set("status", "ACTIVE");

  if (action === "increase_budget" || action === "decrease_budget") {
    const currentBudget = centsToMoney(before.daily_budget);
    const targetBudget = Number(body.targetBudget || 0);
    if (!currentBudget) {
      throw new HttpError(400, "Este conjunto no tiene presupuesto diario editable; revisa presupuesto de campaña en Meta.");
    }
    if (!Number.isFinite(targetBudget) || targetBudget <= 0) throw new HttpError(400, "Presupuesto destino inválido");
    const maxStep = Math.max(1, Math.round(currentBudget * SAFE_BUDGET_STEP));
    const difference = Math.round((targetBudget - currentBudget) * 100) / 100;
    if (action === "increase_budget" && (difference <= 0 || difference > maxStep)) {
      throw new HttpError(400, `Solo puedo subir hasta ${money(maxStep)} por ajuste.`);
    }
    if (action === "decrease_budget" && (difference >= 0 || Math.abs(difference) > maxStep)) {
      throw new HttpError(400, `Solo puedo bajar hasta ${money(maxStep)} por ajuste.`);
    }
    patch.set("daily_budget", String(Math.round(targetBudget * 100)));
  }

  const result = await graphRequest(`/${adsetId}`, "POST", patch);
  if (result.success === false) throw new Error("Meta no confirmó el cambio");
  const after = await fetchAdset(adsetId);

  return {
    ok: true,
    action,
    adsetId,
    before: normalizeAdsetSnapshot(before),
    after: normalizeAdsetSnapshot(after),
  };
}

async function fetchAdset(adsetId: string) {
  return graphRequest(
    `/${adsetId}`,
    "GET",
    new URLSearchParams({
      fields: "id,name,status,effective_status,daily_budget,lifetime_budget,campaign{id,name,status,effective_status,daily_budget,lifetime_budget}",
    }),
  );
}

async function graphRequest(path: string, method: string, params: URLSearchParams) {
  const token = metaAdsAccessToken();
  if (!token) throw new HttpError(500, "Falta META_ADS_ACCESS_TOKEN/META_ACCESS_TOKEN");
  params.set("access_token", token);
  const url = new URL(`https://graph.facebook.com/${graphVersion()}${path}`);
  const init: RequestInit = { method };
  if (method === "GET") {
    for (const [key, value] of params.entries()) url.searchParams.set(key, value);
  } else {
    init.headers = { "content-type": "application/x-www-form-urlencoded" };
    init.body = params;
  }
  const response = await fetch(url, init);
  const payload = await response.json();
  if (!response.ok) {
    throw new HttpError(response.status, payload.error?.message || `Meta API respondió ${response.status}`);
  }
  return payload;
}

function normalizeAdsetSnapshot(adset: Record<string, any>) {
  return {
    id: String(adset.id || ""),
    name: String(adset.name || ""),
    status: String(adset.status || ""),
    effectiveStatus: String(adset.effective_status || ""),
    dailyBudget: centsToMoney(adset.daily_budget),
    lifetimeBudget: centsToMoney(adset.lifetime_budget),
    campaignId: String(adset.campaign?.id || ""),
    campaign: String(adset.campaign?.name || ""),
    campaignStatus: String(adset.campaign?.status || ""),
    campaignEffectiveStatus: String(adset.campaign?.effective_status || ""),
    campaignDailyBudget: centsToMoney(adset.campaign?.daily_budget),
    campaignLifetimeBudget: centsToMoney(adset.campaign?.lifetime_budget),
  };
}

function isAdsAccess(req: Request) {
  const password = Deno.env.get("PANEL_PASSWORD") || "";
  if (!password) return true;
  const header = req.headers.get("authorization") || "";
  const encoded = header.startsWith("Basic ") ? header.slice(6) : "";
  if (!encoded) return false;
  try {
    const decoded = atob(encoded);
    const separator = decoded.indexOf(":");
    const username = decoded.slice(0, separator);
    const incomingPassword = decoded.slice(separator + 1);
    const expectedUser = Deno.env.get("PANEL_USERNAME") || "";
    if (expectedUser && username !== expectedUser) return false;
    return incomingPassword === password;
  } catch {
    return false;
  }
}

async function readJson(req: Request) {
  const textBody = await req.text();
  return textBody ? JSON.parse(textBody) : {};
}

function normalizePath(pathname: string) {
  if (pathname === "/bormex-ads-control") return "/";
  if (pathname.startsWith("/bormex-ads-control/")) return pathname.slice("/bormex-ads-control".length);
  return pathname;
}

function graphVersion() {
  return Deno.env.get("META_GRAPH_VERSION") || "v25.0";
}

function metaAdsAccessToken() {
  return Deno.env.get("META_ADS_ACCESS_TOKEN") || Deno.env.get("META_ACCESS_TOKEN") || "";
}

function centsToMoney(value: unknown) {
  const amount = Number(value || 0);
  return amount ? amount / 100 : 0;
}

function money(value: number) {
  return new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 }).format(value);
}

function json(payload: unknown, status = 200) {
  return cors(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } }));
}

function text(payload: string, status = 200) {
  return cors(new Response(payload, { status, headers: { "content-type": "text/plain; charset=utf-8" } }));
}

function cors(response: Response) {
  response.headers.set("access-control-allow-origin", "*");
  response.headers.set("access-control-allow-headers", "authorization, content-type");
  response.headers.set("access-control-allow-methods", "POST, OPTIONS");
  return response;
}
