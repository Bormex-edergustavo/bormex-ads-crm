const STORAGE_KEY = "ventas_ads_state_v1";
const AUTH_STORAGE_KEY = "ventas_ads_panel_code_v1";
const API_BASE = getApiBase();
let panelCode = localStorage.getItem(AUTH_STORAGE_KEY) || "";

const defaultState = {
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
    state.conversations = remoteState.conversations || state.conversations;
    state.messages = remoteState.messages || state.messages;
    state.sales = remoteState.sales || state.sales;
    state.leads = remoteState.leads || state.leads;
    state.spend = remoteState.spend || state.spend;
    state.ads = remoteState.ads || state.ads;
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
    const lead = findLeadForSale(sale);
    if (!lead) continue;
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
  renderMetrics();
  renderCrm();
  renderPerformance();
  renderRecentSales();
  renderSalesTable();
  renderLeadsTable();
  renderSpendTable();
  fillRules();
}

function renderMetrics() {
  const performance = getPerformance();
  const spend = performance.reduce((sum, item) => sum + item.spend, 0);
  const messages = performance.reduce((sum, item) => sum + Number(item.messages || 0), 0);
  const revenue = state.sales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0);
  const cpa = state.sales.length ? spend / state.sales.length : 0;
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
      const lead = findLeadForSale(sale);
      return `
        <div class="activity-item">
          <strong>${escapeHtml(getSaleProducts(sale).join(", "))} · ${money.format(Number(sale.amount || 0))}</strong>
          <span>${escapeHtml(sale.phone)} · ${lead ? escapeHtml(lead.ad) : "Sin atribución"}</span>
        </div>
      `;
    })
    .join("");
}

function renderSalesTable() {
  const tbody = document.getElementById("salesTable");
  if (!state.sales.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Registra la primera venta para empezar.</td></tr>`;
    return;
  }

  tbody.innerHTML = [...state.sales]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map((sale) => {
      const lead = findLeadForSale(sale);
      return `
        <tr>
          <td>${escapeHtml(sale.date)}</td>
          <td>${escapeHtml(sale.phone)}</td>
          <td>${escapeHtml(getSaleProducts(sale).join(", "))}</td>
          <td>${money.format(Number(sale.amount || 0))}</td>
          <td>${lead ? `${escapeHtml(lead.ad)} / ${escapeHtml(lead.campaign)}` : "Sin coincidencia"}</td>
          <td><button class="danger-button" data-delete="sales" data-id="${sale.id}" type="button">Eliminar</button></td>
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
    tbody.innerHTML = `<tr><td colspan="6" class="empty">Los anuncios activos aparecerán aquí cuando conectemos Meta Ads API.</td></tr>`;
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
          <td>${money.format(Number(spend.spend || 0))}</td>
          <td>${spend.dailyBudget ? money.format(Number(spend.dailyBudget || 0)) : ""}</td>
          <td><button class="danger-button" data-delete="spend" data-id="${spend.id}" type="button">Eliminar</button></td>
        </tr>
      `,
    )
    .join("");
}

function fillRules() {
  const form = document.getElementById("rulesForm");
  form.elements.targetCpa.value = state.rules.targetCpa;
  form.elements.minRoas.value = state.rules.minRoas;
  form.elements.minLeads.value = state.rules.minLeads;
}

function setView(view) {
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

  try {
    if (serverAvailable) {
      const remoteState = await api("/api/sales", { method: "POST", body: JSON.stringify(sale) });
      applyRemoteState(remoteState);
    } else {
      state.sales.push(sale);
      saveState();
    }
    form.reset();
    form.elements.date.value = today();
    render();
    toast("Venta registrada");
  } catch (error) {
    toast(error.message);
  }
}

function applyRemoteState(remoteState) {
  state.conversations = remoteState.conversations || state.conversations;
  state.messages = remoteState.messages || state.messages;
  state.sales = remoteState.sales || state.sales;
  state.leads = remoteState.leads || state.leads;
  state.spend = remoteState.spend || state.spend;
  state.ads = remoteState.ads || state.ads;
  state.rules = remoteState.rules || state.rules;
  saveState();
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
    return {
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
  download(`ventas-${today()}.csv`, toCsv(rows, ["phone", "product", "amount", "date"]), "text/csv");
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
});

document.getElementById("clearDemoData").addEventListener("click", () => {
  if (!confirm("Esto borrara ventas, leads, gastos y reglas guardadas en este navegador. ¿Quieres continuar?")) {
    return;
  }
  state = structuredClone(defaultState);
  persistAndRender("Datos limpiados");
});

document.querySelectorAll('input[type="date"]').forEach((input) => {
  input.value = today();
});

render();
saveState();

syncFromServer().then(render);
setInterval(() => {
  syncFromServer().then(render);
}, 30000);
