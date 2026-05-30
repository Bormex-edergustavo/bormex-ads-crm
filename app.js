const STORAGE_KEY = "ventas_ads_state_v1";
const AUTH_STORAGE_KEY = "ventas_ads_panel_code_v1";
const ADS_ACCESS_CODE = "2607";
const SALES_ACCESS_CODE = "1234";
const API_BASE = getApiBase();
let panelCode = localStorage.getItem(AUTH_STORAGE_KEY) || "";
let accessRole = roleFromCode(panelCode);

const defaultState = {
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
};

let state = loadState();
let serverAvailable = false;
let activeConversationId = "";

const money = new Intl.NumberFormat("es-MX", {
  style: "currency",
  currency: "MXN",
  maximumFractionDigits: 0,
});

const numberFormat = new Intl.NumberFormat("es-MX", {
  maximumFractionDigits: 2,
});

const today = () => new Date().toISOString().slice(0, 10);

function roleFromCode(code) {
  if (String(code || "").trim() === SALES_ACCESS_CODE) return "sales";
  if (String(code || "").trim() === ADS_ACCESS_CODE) return "ads";
  return "";
}

function isSalesRole() {
  return accessRole === "sales";
}

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return structuredClone(defaultState);
    return { ...structuredClone(defaultState), ...JSON.parse(saved) };
  } catch {
    return structuredClone(defaultState);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  document.getElementById("storageStatus").textContent = `Guardado ${new Date().toLocaleTimeString("es-MX", {
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

async function api(path, options = {}) {
  const headers = {
    "content-type": "application/json",
    ...(options.headers || {}),
  };
  if (panelCode) {
    headers.Authorization = `Basic ${btoa(`panel:${panelCode}`)}`;
  }

  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers,
  });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { error: await response.text() };
  if (response.status === 401) {
    panelCode = "";
    localStorage.removeItem(AUTH_STORAGE_KEY);
    showAuthGate();
    throw new Error("Ingresa el código del panel");
  }
  if (!response.ok) throw new Error(payload.error || "No se pudo conectar");
  hideAuthGate();
  return payload;
}

function getApiBase() {
  const configured = document.querySelector('meta[name="bormex-api-base"]')?.content?.trim() || window.BORMEX_API_BASE || "";
  if (configured) return configured.replace(/\/$/, "");
  const firstPathPart = window.location.pathname.split("/").filter(Boolean)[0];
  return firstPathPart === "bormex-crm" ? "/bormex-crm" : "";
}

function showAuthGate() {
  if (document.getElementById("authGate")) return;
  const gate = document.createElement("div");
  gate.className = "auth-gate";
  gate.id = "authGate";
  gate.innerHTML = `
    <form class="auth-card" id="authForm">
      <span class="brand-mark">VA</span>
      <h2>Acceso al panel</h2>
      <label>
        Código
        <input name="code" inputmode="numeric" autocomplete="current-password" required autofocus />
      </label>
      <button class="primary-button" type="submit">Entrar</button>
    </form>
  `;
  document.body.appendChild(gate);
  document.getElementById("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    panelCode = event.currentTarget.elements.code.value.trim();
    accessRole = roleFromCode(panelCode);
    localStorage.setItem(AUTH_STORAGE_KEY, panelCode);
    hideAuthGate();
    await syncFromServer();
    render();
  });
}

function hideAuthGate() {
  document.getElementById("authGate")?.remove();
}

async function syncFromServer() {
  try {
    const [config, remoteState] = await Promise.all([api("/api/config"), api("/api/state")]);
    serverAvailable = true;
    accessRole = config.role || roleFromCode(panelCode) || accessRole;
    state.conversations = remoteState.conversations || state.conversations;
    state.messages = remoteState.messages || state.messages;
    state.sales = remoteState.sales || state.sales;
    state.leads = remoteState.leads || state.leads;
    state.spend = remoteState.spend || state.spend;
    state.ads = remoteState.ads || state.ads;
    state.campaignPeriods = remoteState.campaignPeriods || state.campaignPeriods;
    state.rules = remoteState.rules || state.rules;
    renderConnectionStatus(config, remoteState);
    saveState();
  } catch {
    serverAvailable = false;
    renderConnectionStatus(null, null);
  }
}

function renderConnectionStatus(config, remoteState) {
  const dots = document.querySelectorAll(".connection-dot");
  const whatsappText = document.getElementById("whatsappConnectionText");
  const adsText = document.getElementById("adsConnectionText");
  const syncButton = document.getElementById("syncAds");

  dots.forEach((dot) => dot.classList.remove("connected"));
  if (!serverAvailable) {
    whatsappText.textContent = "No pude conectar con el backend. Revisa internet o intenta recargar el panel.";
    adsText.textContent = "No pude conectar con el backend para sincronizar anuncios activos desde Meta Ads API.";
    syncButton.disabled = true;
    return;
  }

  syncButton.disabled = !config.metaAdsConfigured;
  if (config.whatsappWebhookConfigured) {
    dots[0].classList.add("connected");
    const phoneStatus = config.whatsappPhoneConfigured ? "Número real configurado." : "Falta WHATSAPP_PHONE_NUMBER_ID para responder desde el CRM.";
    whatsappText.textContent = `Webhook guardado. ${phoneStatus} Último evento recibido: ${remoteState.lastWebhookAt || "todavía ninguno"}. Los contactos aparecerán cuando Meta entregue mensajes reales de producción.`;
  } else {
    whatsappText.textContent = "Falta WHATSAPP_VERIFY_TOKEN en .env para verificar el webhook de Meta.";
  }

  if (config.metaAdsConfigured) {
    dots[1].classList.add("connected");
    adsText.textContent = `Meta Ads configurado. Última sincronización: ${remoteState.lastAdsSync || "todavía ninguna"}. Auto-sync cada ${config.adsSyncIntervalMinutes || 15} minutos.`;
  } else {
    adsText.textContent = "Faltan META_ACCESS_TOKEN y META_AD_ACCOUNT_ID en .env para leer anuncios activos.";
  }
}

async function syncAdsFromMeta() {
  const button = document.getElementById("syncAds");
  button.disabled = true;
  button.textContent = "Sincronizando...";
  try {
    const remoteState = await api("/api/sync/ads", { method: "POST", body: "{}" });
    state.spend = remoteState.spend || [];
    state.ads = remoteState.ads || [];
    saveState();
    render();
    await syncFromServer();
    toast("Anuncios activos sincronizados");
  } catch (error) {
    toast(error.message);
  } finally {
    button.textContent = "Sincronizar anuncios activos";
    button.disabled = false;
  }
}

function normalizePhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `52${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `52${digits.slice(1)}`;
  if (digits.length >= 13 && digits.startsWith("521")) return `52${digits.slice(3)}`;
  return digits;
}

function parseMoney(value) {
  const cleaned = String(value || "").replace(/[$,\s]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeAdId(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const numeric = text.match(/(?:ad[_\s-]?id|source[_\s-]?id)?\D*(\d{8,})/i);
  if (numeric) return numeric[1];
  return text.replace(/^ad[_\s-]?id[:\s-]*/i, "").trim();
}

function getSaleProducts(sale) {
  if (Array.isArray(sale.products) && sale.products.length) return sale.products;
  if (sale.product) return [sale.product];
  return [];
}

function adKey(record) {
  return record.adId?.trim() || `${record.campaign || "Sin campaña"}::${record.ad || "Sin anuncio"}`;
}

function findLeadForSale(sale) {
  return findLeadForPhone(sale.phone);
}

function findAdById(adIdValue) {
  const adId = normalizeAdId(adIdValue);
  if (!adId) return null;
  return (
    (state.ads || []).find((ad) => normalizeAdId(ad.id) === adId || normalizeAdId(ad.adId) === adId) ||
    (state.spend || []).find((spend) => normalizeAdId(spend.adId) === adId) ||
    null
  );
}

function adName(record) {
  return record?.name || record?.ad || "";
}

function campaignKey(record) {
  const campaignId = String(record?.campaignId || "").trim();
  if (campaignId) return `campaign:${campaignId}`;
  const campaign = String(record?.campaign || "Sin campaña").trim() || "Sin campaña";
  return `campaign-name:${campaign.toLowerCase()}`;
}

function normalizeCampaignPeriod(period) {
  const campaign = String(period.campaign || "Sin campaña").trim() || "Sin campaña";
  const campaignId = String(period.campaignId || "").trim();
  const id = String(period.id || period.key || campaignKey({ campaignId, campaign }));
  return {
    id,
    campaignId,
    campaign,
    startDate: String(period.startDate || period.start || ""),
    endDate: String(period.endDate || period.end || ""),
  };
}

function getCampaignPeriod(key) {
  return (state.campaignPeriods || []).find((period) => period.id === key) || null;
}

function getAttributionCampaignKey(attribution) {
  return campaignKey({
    campaignId: attribution?.campaignId || "",
    campaign: attribution?.campaign || "Sin campaña",
  });
}

function isDateInsidePeriod(dateValue, period) {
  if (!period) return true;
  const date = String(dateValue || "");
  if (period.startDate && date < period.startDate) return false;
  if (period.endDate && date > period.endDate) return false;
  return true;
}

function saleMatchesCampaignPeriod(sale, attribution) {
  const key = getAttributionCampaignKey(attribution);
  return isDateInsidePeriod(sale.date, getCampaignPeriod(key));
}

function getSaleAttribution(sale) {
  const saleAdId = normalizeAdId(sale.adId || sale.ad_id || sale.metaAdId);
  if (saleAdId) {
    const matchedAd = findAdById(saleAdId);
    return {
      source: "manual_ad_id",
      campaign: sale.campaign || matchedAd?.campaign || "ID manual",
      campaignId: sale.campaignId || matchedAd?.campaignId || "",
      adset: sale.adset || matchedAd?.adset || "",
      ad: sale.ad || adName(matchedAd) || `Anuncio ${saleAdId}`,
      adId: saleAdId,
    };
  }
  const lead = findLeadForSale(sale);
  return lead ? { ...lead, source: "lead" } : null;
}

function findLeadForPhone(phoneValue) {
  const phone = normalizePhone(phoneValue);
  return [...state.leads]
    .filter((lead) => normalizePhone(lead.phone) === phone)
    .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
}

function getPerformance() {
  const map = new Map();
  const liveAdKeys = new Set();

  for (const ad of state.ads || []) {
    const key = ad.id || `${ad.campaign || "Sin campaña"}::${ad.name || "Sin anuncio"}`;
    liveAdKeys.add(key);
    const metaMessages = Number(ad.messages || 0);
    map.set(key, {
      key,
      campaign: ad.campaign || "Sin campaña",
      ad: ad.name || "Sin anuncio",
      adId: ad.id || "",
      leads: 0,
      trackedLeads: 0,
      messages: metaMessages,
      sales: 0,
      revenue: 0,
      spend: Number(ad.spend || 0),
      dailyBudget: Number(ad.dailyBudget || 0),
    });
  }

  for (const lead of state.leads) {
    const key = adKey(lead);
    if (!map.has(key)) {
      map.set(key, {
        key,
        campaign: lead.campaign || "Sin campaña",
        ad: lead.ad || "Sin anuncio",
        adId: lead.adId || "",
        leads: 0,
        trackedLeads: 0,
        messages: 0,
        sales: 0,
        revenue: 0,
        spend: 0,
        dailyBudget: 0,
      });
    }
    const row = map.get(key);
    row.leads += 1;
    row.trackedLeads += 1;
    row.messages = Math.max(Number(row.messages || 0), row.trackedLeads);
  }

  for (const spend of state.spend) {
    const key = adKey(spend);
    if (!map.has(key)) {
      map.set(key, {
        key,
        campaign: spend.campaign || "Sin campaña",
        ad: spend.ad || "Sin anuncio",
        adId: spend.adId || "",
        leads: 0,
        trackedLeads: 0,
        messages: 0,
        sales: 0,
        revenue: 0,
        spend: 0,
        dailyBudget: 0,
      });
    }
    const row = map.get(key);
    row.spend = liveAdKeys.has(key)
      ? Math.max(Number(row.spend || 0), Number(spend.spend || 0))
      : Number(row.spend || 0) + Number(spend.spend || 0);
    row.dailyBudget = Math.max(row.dailyBudget, Number(spend.dailyBudget || 0));
  }

  for (const sale of state.sales) {
    const attribution = getSaleAttribution(sale);
    if (!attribution) continue;
    if (!saleMatchesCampaignPeriod(sale, attribution)) continue;
    const key = adKey(attribution);
    if (!map.has(key)) {
      map.set(key, {
        key,
        campaign: attribution.campaign || "Sin campaña",
        campaignId: attribution.campaignId || "",
        ad: attribution.ad || "Sin anuncio",
        adId: attribution.adId || "",
        leads: 0,
        trackedLeads: 0,
        messages: 0,
        sales: 0,
        revenue: 0,
        spend: 0,
        dailyBudget: 0,
      });
    }
    const row = map.get(key);
    row.sales += 1;
    row.revenue += Number(sale.amount || 0);
  }

  return [...map.values()].map((row) => {
    const cpa = row.sales > 0 ? row.spend / row.sales : 0;
    const roas = row.spend > 0 ? row.revenue / row.spend : 0;
    const costPerMessage = row.messages > 0 ? row.spend / row.messages : 0;
    return {
      ...row,
      cpa,
      roas,
      costPerMessage,
      recommendation: recommend(row, cpa, roas),
    };
  });
}

function recommend(row, cpa, roas) {
  const rules = state.rules;
  if (row.messages < Number(rules.minLeads)) return "hold";
  if (row.sales === 0 && row.spend > Number(rules.targetCpa)) return "pause";
  if (row.sales > 0 && (cpa > Number(rules.targetCpa) * 1.35 || roas < Number(rules.minRoas) * 0.65)) return "reduce";
  if (row.sales > 0 && cpa <= Number(rules.targetCpa) && roas >= Number(rules.minRoas)) return "scale";
  return "hold";
}

function recommendationLabel(value) {
  return {
    scale: "Subir",
    hold: "Mantener",
    reduce: "Bajar",
    pause: "Pausar",
  }[value];
}

function render() {
  applyRoleAccess();
  renderMetrics();
  renderCrm();
  renderAdIdOptions();
  renderPerformance();
  renderRecentSales();
  renderSalesTable();
  renderLeadsTable();
  renderSpendTable();
  renderCampaignPeriods();
  fillRules();
  applyRoleAccess();
}

function renderAdIdOptions() {
  const datalist = document.getElementById("adIdOptions");
  if (!datalist) return;
  const seen = new Set();
  const rows = [];
  for (const ad of state.ads || []) {
    const id = normalizeAdId(ad.id || ad.adId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    rows.push({ id, label: `${ad.name || ad.ad || "Sin anuncio"} / ${ad.campaign || "Sin campaña"}` });
  }
  datalist.innerHTML = rows.map((row) => `<option value="${escapeHtml(row.id)}">${escapeHtml(row.label)}</option>`).join("");
}

function renderMetrics() {
  const performance = getPerformance();
  const spend = performance.reduce((sum, item) => sum + item.spend, 0);
  const messages = performance.reduce((sum, item) => sum + Number(item.messages || 0), 0);
  const revenue = performance.reduce((sum, item) => sum + Number(item.revenue || 0), 0);
  const sales = performance.reduce((sum, item) => sum + Number(item.sales || 0), 0);
  const cpa = sales ? spend / sales : 0;
  const roas = spend ? revenue / spend : 0;
  const costPerMessage = messages ? spend / messages : 0;
  document.getElementById("metricSpend").textContent = money.format(spend);
  document.getElementById("metricRevenue").textContent = money.format(revenue);
  document.getElementById("metricMessages").textContent = numberFormat.format(messages);
  document.getElementById("metricCostPerMessage").textContent = money.format(costPerMessage);
  document.getElementById("metricRoas").textContent = `${numberFormat.format(roas)}x`;
  document.getElementById("metricCpa").textContent = money.format(cpa);
}

function renderPerformance() {
  const tbody = document.getElementById("adsPerformanceTable");
  const filter = document.getElementById("statusFilter").value;
  const rows = getPerformance()
    .filter((row) => filter === "all" || row.recommendation === filter)
    .sort((a, b) => b.revenue - a.revenue || b.spend - a.spend);

  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty">Todavía no hay datos suficientes.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map(
      (row) => `
        <tr>
          <td>${escapeHtml(row.ad)}</td>
          <td>${escapeHtml(row.campaign)}</td>
          <td>${money.format(row.spend)}</td>
          <td>${numberFormat.format(row.messages || 0)}</td>
          <td>${row.sales}</td>
          <td>${money.format(row.revenue)}</td>
          <td>${row.messages ? money.format(row.costPerMessage) : "Sin mensajes"}</td>
          <td>${row.sales ? money.format(row.cpa) : "Sin ventas"}</td>
          <td>${row.spend ? `${numberFormat.format(row.roas)}x` : "0.00x"}</td>
          <td><span class="badge ${row.recommendation}">${recommendationLabel(row.recommendation)}</span></td>
        </tr>
      `,
    )
    .join("");
}

function renderRecentSales() {
  const container = document.getElementById("recentSales");
  const rows = [...state.sales].sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 6);
  if (!rows.length) {
    container.innerHTML = `<div class="empty">Aquí aparecerán las ventas recientes.</div>`;
    return;
  }

  container.innerHTML = rows
    .map((sale) => {
      const attribution = getSaleAttribution(sale);
      return `
        <div class="activity-item">
          <strong>${escapeHtml(getSaleProducts(sale).join(", "))} · ${money.format(Number(sale.amount || 0))}</strong>
          <span>${escapeHtml(sale.phone)} · ${attribution ? escapeHtml(attribution.ad) : "Sin atribución"}</span>
        </div>
      `;
    })
    .join("");
}

function renderSalesTable() {
  const tbody = document.getElementById("salesTable");
  if (!state.sales.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">Registra la primera venta para empezar.</td></tr>`;
    return;
  }

  tbody.innerHTML = [...state.sales]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map((sale) => {
      const attribution = getSaleAttribution(sale);
      const saleAdId = normalizeAdId(sale.adId);
      return `
        <tr>
          <td>${escapeHtml(sale.date)}</td>
          <td>${escapeHtml(sale.phone)}</td>
          <td>${escapeHtml(getSaleProducts(sale).join(", "))}</td>
          <td>${money.format(Number(sale.amount || 0))}</td>
          <td>${saleAdId ? escapeHtml(saleAdId) : "Sin ID"}</td>
          <td>${attribution ? `${escapeHtml(attribution.ad)} / ${escapeHtml(attribution.campaign)}` : "Sin coincidencia"}</td>
          <td>
            <div class="table-actions">
              <button class="secondary-button compact" data-edit-sale-ad="${sale.id}" type="button">Editar ID</button>
              <button class="danger-button compact" data-delete="sales" data-id="${sale.id}" type="button">Eliminar</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");
}

function renderLeadsTable() {
  const tbody = document.getElementById("leadsTable");
  if (!state.leads.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Aquí aparecerán contactos con número cuando el webhook de WhatsApp entregue mensajes reales con referencia del anuncio.</td></tr>`;
    return;
  }

  tbody.innerHTML = [...state.leads]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(
      (lead) => `
        <tr>
          <td>${escapeHtml(lead.date)}</td>
          <td>${escapeHtml(lead.phone)}</td>
          <td>${escapeHtml(lead.campaign)}</td>
          <td>${escapeHtml(lead.ad)}</td>
          <td>${escapeHtml(lead.adId || "")}</td>
          <td><button class="danger-button" data-delete="leads" data-id="${lead.id}" type="button">Eliminar</button></td>
        </tr>
      `,
    )
    .join("");
}

function renderSpendTable() {
  const tbody = document.getElementById("spendTable");
  if (!state.spend.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">Los anuncios activos aparecerán aquí cuando conectemos Meta Ads API.</td></tr>`;
    return;
  }

  tbody.innerHTML = [...state.spend]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map(
      (spend) => `
        <tr>
          <td>${escapeHtml(spend.date)}</td>
          <td>${escapeHtml(spend.campaign)}</td>
          <td>${escapeHtml(spend.ad)}</td>
          <td>${escapeHtml(spend.adId || "")}</td>
          <td>${money.format(Number(spend.spend || 0))}</td>
          <td>${spend.dailyBudget ? money.format(Number(spend.dailyBudget || 0)) : ""}</td>
          <td><button class="danger-button" data-delete="spend" data-id="${spend.id}" type="button">Eliminar</button></td>
        </tr>
      `,
    )
    .join("");
}

function collectCampaignRows() {
  const rows = new Map();
  const nameToKey = new Map();
  const upsert = (record) => {
    if (!record) return;
    const campaign = String(record.campaign || "Sin campaña").trim() || "Sin campaña";
    const campaignId = String(record.campaignId || "").trim();
    const nameKey = campaign.toLowerCase();
    const key = campaignId ? campaignKey({ campaignId, campaign }) : nameToKey.get(nameKey) || campaignKey({ campaignId, campaign });
    if (campaignId) nameToKey.set(nameKey, key);
    const period = getCampaignPeriod(key);
    const current = rows.get(key) || {};
    rows.set(key, {
      ...current,
      key,
      campaignId: campaignId || current.campaignId || period?.campaignId || "",
      campaign: campaign !== "Sin campaña" ? campaign : current.campaign || period?.campaign || campaign,
      startDate: period?.startDate || "",
      endDate: period?.endDate || "",
    });
  };

  (state.ads || []).forEach(upsert);
  (state.spend || []).forEach(upsert);
  for (const sale of state.sales || []) upsert(getSaleAttribution(sale));
  for (const period of state.campaignPeriods || []) upsert(period);
  return [...rows.values()].sort((a, b) => a.campaign.localeCompare(b.campaign, "es"));
}

function getCampaignPeriodStats(row) {
  const stats = { sales: 0, revenue: 0 };
  for (const sale of state.sales || []) {
    const attribution = getSaleAttribution(sale);
    if (!attribution) continue;
    if (getAttributionCampaignKey(attribution) !== row.key) continue;
    if (!isDateInsidePeriod(sale.date, getCampaignPeriod(row.key))) continue;
    stats.sales += 1;
    stats.revenue += Number(sale.amount || 0);
  }
  return stats;
}

function renderCampaignPeriods() {
  const tbody = document.getElementById("campaignPeriodsTable");
  if (!tbody) return;
  const rows = collectCampaignRows();
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Cuando haya campañas sincronizadas aparecerán aquí.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows
    .map((row) => {
      const stats = getCampaignPeriodStats(row);
      return `
        <tr>
          <td>${escapeHtml(row.campaign)}</td>
          <td><input type="date" value="${escapeHtml(row.startDate || "")}" data-campaign-date="${escapeHtml(row.key)}" data-field="startDate" /></td>
          <td><input type="date" value="${escapeHtml(row.endDate || "")}" data-campaign-date="${escapeHtml(row.key)}" data-field="endDate" /></td>
          <td>${stats.sales}</td>
          <td>${money.format(stats.revenue)}</td>
          <td><button class="secondary-button compact" data-save-campaign-period="${escapeHtml(row.key)}" type="button">Guardar</button></td>
        </tr>
      `;
    })
    .join("");
}

function fillRules() {
  const form = document.getElementById("rulesForm");
  form.elements.targetCpa.value = state.rules.targetCpa;
  form.elements.minRoas.value = state.rules.minRoas;
  form.elements.minLeads.value = state.rules.minLeads;
}

function setView(view) {
  if (isSalesRole() && view !== "sales") view = "sales";
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((section) => {
    section.classList.toggle("active", section.id === `${view}View`);
  });
  document.getElementById("viewTitle").textContent = {
    dashboard: "Panel",
    crm: "CRM",
    sales: "Ventas",
    leads: "Leads",
    ads: "Anuncios",
    settings: "Datos",
  }[view];
}

function applyRoleAccess() {
  const salesOnly = isSalesRole();
  document.body.dataset.role = accessRole || "unknown";
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.hidden = salesOnly && button.dataset.view !== "sales";
  });
  document.getElementById("exportJson").hidden = salesOnly;
  document.getElementById("clearDemoData").hidden = salesOnly;
  document.getElementById("roleBadge").textContent = salesOnly ? "Ventas" : "Ads";
  if (salesOnly) {
    const activeView = document.querySelector(".nav-item.active")?.dataset.view || "sales";
    if (activeView !== "sales") setView("sales");
  }
}

function getChannelLabel(channel) {
  return {
    whatsapp: "WhatsApp",
    messenger: "Messenger",
    instagram: "Instagram",
  }[channel] || channel;
}

function getConversationRows() {
  const filter = document.getElementById("crmChannelFilter")?.value || "all";
  return [...(state.conversations || [])]
    .filter((conversation) => filter === "all" || conversation.channel === filter)
    .sort((a, b) => new Date(b.lastAt || 0) - new Date(a.lastAt || 0));
}

function getConversationLead(conversation) {
  if (conversation.channel !== "whatsapp" || !conversation.phone) return null;
  return findLeadForPhone(conversation.phone);
}

function renderCrm() {
  const list = document.getElementById("conversationList");
  const thread = document.getElementById("messageThread");
  const header = document.getElementById("threadHeader");
  if (!list || !thread || !header) return;

  const conversations = getConversationRows();
  if (!activeConversationId && conversations.length) activeConversationId = conversations[0].id;
  if (activeConversationId && !conversations.some((item) => item.id === activeConversationId)) {
    activeConversationId = conversations[0]?.id || "";
  }

  if (!conversations.length) {
    list.innerHTML = `<div class="empty">Aquí aparecerán las conversaciones 1 a 1 nuevas que entregue WhatsApp.</div>`;
  } else {
    list.innerHTML = conversations
      .map((conversation) => {
        const lead = getConversationLead(conversation);
        return `
          <button class="conversation-item ${conversation.id === activeConversationId ? "active" : ""}" data-conversation-id="${escapeHtml(conversation.id)}" type="button">
            <span class="channel-pill ${escapeHtml(conversation.channel)}">${getChannelLabel(conversation.channel)}</span>
            <strong>${escapeHtml(conversation.name || conversation.phone || conversation.contactId)}</strong>
            <small>${escapeHtml(conversation.lastMessage || "")}</small>
            ${lead ? `<small class="conversation-attribution">${escapeHtml(lead.ad || lead.campaign || "Anuncio atribuido")}</small>` : ""}
          </button>
        `;
      })
      .join("");
  }

  const active = conversations.find((conversation) => conversation.id === activeConversationId);
  if (!active) {
    header.innerHTML = `
      <div>
        <h2>Selecciona una conversación</h2>
        <p>Los mensajes nuevos aparecerán aquí cuando llegue el webhook.</p>
      </div>
    `;
    thread.innerHTML = `<div class="empty">Sin conversación seleccionada.</div>`;
    document.getElementById("replyForm").classList.add("disabled");
    return;
  }

  document.getElementById("replyForm").classList.remove("disabled");
  const activeLead = getConversationLead(active);
  header.innerHTML = `
    <div>
      <h2>${escapeHtml(active.name || active.phone || active.contactId)}</h2>
      <p>${getChannelLabel(active.channel)}${active.phone ? ` · ${escapeHtml(active.phone)}` : ""}${activeLead ? ` · ${escapeHtml(activeLead.ad || activeLead.campaign)}` : ""}</p>
    </div>
  `;

  const messages = [...(state.messages || [])]
    .filter((message) => message.conversationId === activeConversationId)
    .sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));

  thread.innerHTML = messages.length
    ? messages
        .map(
          (message) => `
            <div class="message-bubble ${message.direction === "outbound" ? "outbound" : "inbound"}">
              <p>${escapeHtml(message.text || "")}</p>
              ${message.attachments?.length ? `<small>${escapeHtml(message.attachments.map((item) => item.type).join(", "))}</small>` : ""}
              <span>${new Date(message.at || Date.now()).toLocaleString("es-MX", { dateStyle: "short", timeStyle: "short" })}</span>
            </div>
          `,
        )
        .join("")
    : `<div class="empty">Todavía no hay mensajes guardados.</div>`;
  thread.scrollTop = thread.scrollHeight;
}

async function handleSaleSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const products = new FormData(form).getAll("products");
  if (!products.length) {
    toast("Selecciona al menos un producto");
    return;
  }
  const sale = {
    id: uid("sale"),
    phone: normalizePhone(data.phone),
    products,
    product: products.join(", "),
    amount: parseMoney(data.amount),
    date: data.date || today(),
  };

  applyManualAdAttribution(sale, data.adId);
  await saveSale(sale, "Venta registrada");
  form.reset();
  form.elements.date.value = today();
}

function applyManualAdAttribution(sale, adIdInput) {
  const adId = normalizeAdId(adIdInput);
  const matchedAd = findAdById(adId);
  sale.adId = adId;
  sale.campaign = adId ? matchedAd?.campaign || sale.campaign || "" : "";
  sale.campaignId = adId ? matchedAd?.campaignId || sale.campaignId || "" : "";
  sale.adset = adId ? matchedAd?.adset || sale.adset || "" : "";
  sale.ad = adId ? adName(matchedAd) || sale.ad || "" : "";
  sale.attributionSource = adId ? "manual_ad_id" : "";
  return sale;
}

async function saveSale(sale, message) {
  try {
    if (serverAvailable) {
      const remoteState = await api("/api/sales", { method: "POST", body: JSON.stringify(sale) });
      applyRemoteState(remoteState);
    } else {
      const index = state.sales.findIndex((item) => item.id === sale.id);
      if (index >= 0) state.sales[index] = { ...state.sales[index], ...sale };
      else state.sales.push(sale);
      saveState();
    }
    render();
    toast(message);
  } catch (error) {
    toast(error.message);
  }
}

async function editSaleAdId(saleId) {
  const sale = state.sales.find((item) => item.id === saleId);
  if (!sale) return;
  const current = normalizeAdId(sale.adId);
  const next = prompt("Pega el ID del anuncio que aparece en Business Suite. Déjalo vacío para quitarlo.", current);
  if (next === null) return;
  const updated = applyManualAdAttribution({ ...sale }, next);
  await saveSale(updated, updated.adId ? "ID de anuncio guardado" : "ID de anuncio quitado");
}

function applyRemoteState(remoteState) {
  state.conversations = remoteState.conversations || state.conversations;
  state.messages = remoteState.messages || state.messages;
  state.sales = remoteState.sales || state.sales;
  state.leads = remoteState.leads || state.leads;
  state.spend = remoteState.spend || state.spend;
  state.ads = remoteState.ads || state.ads;
  state.campaignPeriods = remoteState.campaignPeriods || state.campaignPeriods;
  state.rules = remoteState.rules || state.rules;
  saveState();
}

async function saveCampaignPeriod(key) {
  const row = collectCampaignRows().find((item) => item.key === key);
  if (!row) return;
  const inputs = [...document.querySelectorAll("[data-campaign-date]")].filter((input) => input.dataset.campaignDate === key);
  const startDate = inputs.find((input) => input.dataset.field === "startDate")?.value || "";
  const endDate = inputs.find((input) => input.dataset.field === "endDate")?.value || "";
  if (startDate && endDate && startDate > endDate) {
    toast("La fecha de inicio no puede ser mayor que la fecha fin");
    return;
  }
  const period = normalizeCampaignPeriod({
    id: key,
    campaignId: row.campaignId,
    campaign: row.campaign,
    startDate,
    endDate,
  });
  const next = [...(state.campaignPeriods || []).filter((item) => item.id !== key), period].filter(
    (item) => item.startDate || item.endDate,
  );
  try {
    if (serverAvailable) {
      const remoteState = await api("/api/campaign-periods", {
        method: "POST",
        body: JSON.stringify({ periods: next }),
      });
      applyRemoteState(remoteState);
    } else {
      state.campaignPeriods = next;
      saveState();
    }
    render();
    toast("Fechas de campaña guardadas");
  } catch (error) {
    toast(error.message);
  }
}

function persistAndRender(message) {
  saveState();
  render();
  toast(message);
}

function toast(message) {
  const element = document.getElementById("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 2200);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toCsv(rows, columns) {
  const header = columns.join(",");
  const body = rows
    .map((row) =>
      columns
        .map((column) => {
          const value = row[column] ?? "";
          return `"${String(value).replaceAll('"', '""')}"`;
        })
        .join(","),
    )
    .join("\n");
  return `${header}\n${body}`;
}

function download(filename, text, type = "text/plain") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function parseCsv(text) {
  const rows = [];
  let current = "";
  let row = [];
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(current);
      current = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(current);
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      current = "";
      row = [];
    } else {
      current += char;
    }
  }
  row.push(current);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);

  const [headers = [], ...records] = rows;
  return records.map((record) =>
    headers.reduce((item, header, index) => {
      item[header.trim()] = record[index] ?? "";
      return item;
    }, {}),
  );
}

function importCsv() {
  const input = document.getElementById("csvInput");
  const type = document.getElementById("importType").value;
  const file = input.files[0];
  if (!file) {
    toast("Selecciona un CSV primero");
    return;
  }
  const reader = new FileReader();
  reader.onload = async () => {
    const rows = parseCsv(String(reader.result || ""));
    const normalized = rows.map((row) => normalizeImportedRow(type, row));
    try {
      if (serverAvailable) {
        const remoteState = await api("/api/import", {
          method: "POST",
          body: JSON.stringify({ type, rows: normalized }),
        });
        applyRemoteState(remoteState);
      } else {
        state[type].push(...normalized);
        saveState();
      }
      input.value = "";
      render();
      toast(`Importados ${normalized.length} registros`);
    } catch (error) {
      toast(error.message);
    }
  };
  reader.readAsText(file);
}

function normalizeImportedRow(type, row) {
  if (type === "sales") {
    const sale = {
      id: uid("sale"),
      phone: normalizePhone(row.phone),
      products: String(row.product || "")
        .split(/[|,]/)
        .map((product) => product.trim())
        .filter(Boolean),
      product: row.product || "",
      amount: parseMoney(row.amount),
      date: row.date || today(),
    };
    return applyManualAdAttribution(sale, row.adId || row.ad_id || row.metaAdId);
  }
  if (type === "leads") {
    return {
      id: uid("lead"),
      phone: normalizePhone(row.phone),
      campaign: row.campaign || "",
      adset: row.adset || "",
      ad: row.ad || "",
      adId: row.adId || "",
      date: row.date || today(),
      message: row.message || "",
    };
  }
  return {
    id: uid("spend"),
    campaign: row.campaign || "",
    ad: row.ad || "",
    adId: row.adId || "",
    spend: parseMoney(row.spend),
    dailyBudget: parseMoney(row.dailyBudget),
    date: row.date || today(),
  };
}

function seedDemoData() {
  const demoPhone = "529991234567";
  state.leads.push({
    id: uid("lead"),
    phone: demoPhone,
    campaign: "Mensajes Mayo",
    adset: "Lookalike compradores",
    ad: "Video testimonio 01",
    adId: "demo_ad_01",
    date: today(),
    message: "Hola, quiero informes",
  });
  state.sales.push({
    id: uid("sale"),
    phone: demoPhone,
    products: ["Imán", "Llavero"],
    product: "Imán, Llavero",
    amount: 2500,
    date: today(),
    adId: "demo_ad_01",
    ad: "Video testimonio 01",
    campaign: "Mensajes Mayo",
    attributionSource: "manual_ad_id",
  });
  state.spend.push({
    id: uid("spend"),
    campaign: "Mensajes Mayo",
    ad: "Video testimonio 01",
    adId: "demo_ad_01",
    spend: 430,
    dailyBudget: 300,
    date: today(),
  });
  persistAndRender("Datos demo agregados");
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});

document.querySelectorAll("[data-open-sale]").forEach((button) => {
  button.addEventListener("click", () => setView("sales"));
});

document.getElementById("saleForm").addEventListener("submit", handleSaleSubmit);
document.getElementById("statusFilter").addEventListener("change", renderPerformance);
document.getElementById("syncAds").addEventListener("click", syncAdsFromMeta);

document.addEventListener("click", (event) => {
  const conversationButton = event.target.closest("[data-conversation-id]");
  if (conversationButton) {
    activeConversationId = conversationButton.dataset.conversationId;
    renderCrm();
    return;
  }

  const editSaleButton = event.target.closest("[data-edit-sale-ad]");
  if (editSaleButton) {
    editSaleAdId(editSaleButton.dataset.editSaleAd);
    return;
  }

  const saveCampaignButton = event.target.closest("[data-save-campaign-period]");
  if (saveCampaignButton) {
    saveCampaignPeriod(saveCampaignButton.dataset.saveCampaignPeriod);
    return;
  }

  const button = event.target.closest("[data-delete]");
  if (!button) return;
  const collection = button.dataset.delete;
  deleteRecord(collection, button.dataset.id);
});

async function deleteRecord(collection, id) {
  try {
    if (serverAvailable) {
      const remoteState = await api(`/api/records/${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
      applyRemoteState(remoteState);
    } else {
      state[collection] = state[collection].filter((item) => item.id !== id);
      saveState();
    }
    render();
    toast("Registro eliminado");
  } catch (error) {
    toast(error.message);
  }
}

document.getElementById("exportJson").addEventListener("click", () => {
  download(`ventas-ads-${today()}.json`, JSON.stringify(state, null, 2), "application/json");
});

document.getElementById("exportSalesCsv").addEventListener("click", () => {
  const rows = state.sales.map((sale) => ({ ...sale, product: getSaleProducts(sale).join("|") }));
  download(`ventas-${today()}.csv`, toCsv(rows, ["phone", "product", "amount", "date", "adId", "ad", "campaign", "campaignId"]), "text/csv");
});

document.getElementById("exportLeadsCsv").addEventListener("click", () => {
  download(`leads-${today()}.csv`, toCsv(state.leads, ["phone", "campaign", "adset", "ad", "adId", "date", "message"]), "text/csv");
});

document.getElementById("exportSpendCsv").addEventListener("click", () => {
  download(`gasto-${today()}.csv`, toCsv(state.spend, ["campaign", "ad", "adId", "spend", "dailyBudget", "date"]), "text/csv");
});

document.getElementById("importCsv").addEventListener("click", importCsv);
document.getElementById("crmChannelFilter").addEventListener("change", () => {
  activeConversationId = "";
  renderCrm();
});

document.getElementById("replyForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const conversation = (state.conversations || []).find((item) => item.id === activeConversationId);
  const text = event.currentTarget.elements.text.value.trim();
  if (!conversation || !text) return;
  try {
    const remoteState = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        channel: conversation.channel,
        conversationId: conversation.id,
        to: conversation.phone || conversation.contactId,
        phone: conversation.phone,
        name: conversation.name,
        text,
      }),
    });
    event.currentTarget.reset();
    applyRemoteState(remoteState);
    render();
    toast("Mensaje enviado");
  } catch (error) {
    toast(error.message);
  }
});

document.getElementById("rulesForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  const rules = {
    targetCpa: parseMoney(data.targetCpa),
    minRoas: Number(data.minRoas || 0),
    minLeads: Number(data.minLeads || 0),
  };
  try {
    if (serverAvailable) {
      const remoteState = await api("/api/rules", { method: "POST", body: JSON.stringify(rules) });
      applyRemoteState(remoteState);
    } else {
      state.rules = rules;
      saveState();
    }
    render();
    toast("Reglas guardadas");
  } catch (error) {
    toast(error.message);
  }
});

document.getElementById("fillSaleExample").addEventListener("click", () => {
  const form = document.getElementById("saleForm");
  form.elements.phone.value = "+52 999 123 4567";
  form.querySelectorAll('input[name="products"]').forEach((input) => {
    input.checked = ["Imán", "Llavero"].includes(input.value);
  });
  form.elements.amount.value = "2500";
  form.elements.date.value = today();
  form.elements.adId.value = state.ads?.[0]?.id || "";
});

document.getElementById("clearDemoData").addEventListener("click", () => {
  if (!confirm("Esto borrara ventas, leads, gastos y reglas guardadas en este navegador. ¿Quieres continuar?")) {
    return;
  }
  state = structuredClone(defaultState);
  persistAndRender("Datos limpiados");
});

document.getElementById("logoutPanel").addEventListener("click", () => {
  panelCode = "";
  accessRole = "";
  localStorage.removeItem(AUTH_STORAGE_KEY);
  showAuthGate();
});

document.getElementById("saleForm").elements.date.value = today();

render();
saveState();

if (!panelCode) showAuthGate();
syncFromServer().then(render);
setInterval(() => {
  syncFromServer().then(render);
}, 30000);
