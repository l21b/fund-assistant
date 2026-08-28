const QDII_SOURCE_URL = "https://anxinletech.com/instrument-qdii.html";
const QDII_TOPICS = ["标普500", "纳斯达克100"];

function decodeHtmlText(value) {
  const entities = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", hellip: "…",
  };
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_match, entity) => {
      if (entity[0] === "#") {
        const hexadecimal = entity[1]?.toLowerCase() === "x";
        const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : " ";
      }
      return entities[entity.toLowerCase()] ?? " ";
    })
    .replace(/\s+/g, " ")
    .trim();
}

function tableCells(rowHtml) {
  return [...String(rowHtml || "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
    .map((match) => ({ html: match[1], text: decodeHtmlText(match[1]) }));
}

function quotaValueAfter(label, text) {
  const match = String(text || "").match(new RegExp(`${label}[^0-9]*(正常申购|[0-9]+(?:\\.[0-9]+)?(?:万|亿)?元)`));
  return match?.[1] || "";
}

function quotaChannels(limitText, channelText) {
  const limit = String(limitText || "").trim();
  const channel = String(channelText || "").trim();
  let distributor = quotaValueAfter("代销", `${limit} ${channel}`);
  let direct = quotaValueAfter("直销", `${limit} ${channel}`);
  if (!direct && /仅[^；。]*直销/.test(channel) && limit && limit !== "—") direct = limit;
  if (/代销[^；。]*无(?:此)?额度/.test(channel) || /代销[^；。]*不(?:销售|开放)/.test(channel)) distributor = "无额度";
  if (/直销[^；。]*暂停/.test(channel)) direct = "暂停申购";
  if (!distributor && !direct) distributor = limit && limit !== "—" ? limit : "未单列";
  if (!distributor) distributor = "未单列";
  if (!direct) direct = "未单列";
  return { distributor, direct };
}

function topicTableHtml(html, topic) {
  const escaped = topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return String(html || "").match(new RegExp(`<h3\\b[^>]*>\\s*${escaped}[\\s\\S]*?<table\\b[^>]*>([\\s\\S]*?)<\\/table>`, "i"))?.[1] || "";
}

function parseQdiiQuotaHtml(html) {
  const source = String(html || "");
  const reportDate = decodeHtmlText(source).match(/当日速览\s*[·・]?\s*(\d{4}-\d{2}-\d{2})/)?.[1] || "";
  const funds = [];
  for (const topic of QDII_TOPICS) {
    const table = topicTableHtml(source, topic);
    for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = tableCells(row[1]);
      if (cells.length < 4) continue;
      const link = cells[0].html.match(/href=["']\/fund\/(\d{6})\.html["'][^>]*>([\s\S]*?)<\/a>/i);
      if (!link) continue;
      const rawStatus = cells[1].text;
      if (/暂停申购|场内交易/.test(rawStatus)) continue;
      const status = /开放申购/.test(rawStatus) ? "开放申购" : /限大额|限额/.test(rawStatus) ? "限额申购" : "";
      if (!status) continue;
      const channels = quotaChannels(cells[2].text, cells[3].text);
      funds.push({
        topic,
        code: link[1],
        name: decodeHtmlText(link[2]),
        status,
        distributor: channels.distributor,
        direct: channels.direct,
        managementFee: "",
        custodyFee: "",
        profileUrl: `https://anxinletech.com/fund/${link[1]}.html`,
      });
    }
  }
  if (!reportDate || !funds.length) throw new Error("QDII额度日报格式异常");
  return { reportDate, funds };
}

function parseQdiiFundFees(html) {
  const source = String(html || "");
  const field = (name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = source.match(new RegExp(`<span\\b[^>]*class=["'][^"']*\\bk\\b[^"']*["'][^>]*>\\s*${escaped}\\s*<\\/span>\\s*<span\\b[^>]*>([\\s\\S]*?)<\\/span>`, "i"));
    const value = match ? decodeHtmlText(match[1]) : "";
    const rate = value.match(/^(\d+(?:\.\d+)?)%$/);
    return rate ? `${Number(rate[1]).toFixed(2)}%` : value;
  };
  return { managementFee: field("管理费率"), custodyFee: field("托管费率") };
}

function normalizeQdiiQuotaCache(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const funds = Array.isArray(source.funds) ? source.funds.filter((fund) => (
    QDII_TOPICS.includes(String(fund?.topic || ""))
      && /^\d{6}$/.test(String(fund?.code || ""))
      && ["开放申购", "限额申购"].includes(String(fund?.status || ""))
  )).map((fund) => ({
    topic: String(fund.topic),
    code: String(fund.code),
    name: String(fund.name || fund.code),
    status: String(fund.status),
    distributor: String(fund.distributor || "未单列"),
    direct: String(fund.direct || "未单列"),
    managementFee: String(fund.managementFee || ""),
    custodyFee: String(fund.custodyFee || ""),
    profileUrl: `https://anxinletech.com/fund/${fund.code}.html`,
  })) : [];
  return {
    checkedDate: /^\d{4}-\d{2}-\d{2}$/.test(String(source.checkedDate || "")) ? String(source.checkedDate) : "",
    reportDate: /^\d{4}-\d{2}-\d{2}$/.test(String(source.reportDate || "")) ? String(source.reportDate) : "",
    funds,
  };
}

function qdiiFeeTotal(fund) {
  const management = Number.parseFloat(String(fund?.managementFee || ""));
  const custody = Number.parseFloat(String(fund?.custodyFee || ""));
  return Number.isFinite(management) && Number.isFinite(custody) ? management + custody : NaN;
}

function qdiiQuotaAmount(value) {
  const normalized = String(value || "").trim();
  if (normalized === "正常申购") return Number.POSITIVE_INFINITY;
  const match = normalized.match(/^(\d+(?:\.\d+)?)(万|亿)?元$/);
  if (!match) return -1;
  const multiplier = match[2] === "亿" ? 100000000 : match[2] === "万" ? 10000 : 1;
  return Number(match[1]) * multiplier;
}

function sortQdiiFunds(funds, key = "default") {
  const rows = (Array.isArray(funds) ? funds : []).map((fund, index) => ({ fund, index }));
  if (key === "default") return rows.map(({ fund }) => fund);
  return rows.sort((left, right) => {
    let difference = 0;
    if (key === "fee") {
      const leftFee = qdiiFeeTotal(left.fund);
      const rightFee = qdiiFeeTotal(right.fund);
      if (Number.isNaN(leftFee) && !Number.isNaN(rightFee)) difference = 1;
      else if (!Number.isNaN(leftFee) && Number.isNaN(rightFee)) difference = -1;
      else difference = leftFee - rightFee;
    } else if (key === "distributor" || key === "direct") {
      difference = qdiiQuotaAmount(right.fund[key]) - qdiiQuotaAmount(left.fund[key]);
    } else if (key === "code") {
      difference = String(left.fund.code).localeCompare(String(right.fund.code));
    }
    return difference || String(left.fund.code).localeCompare(String(right.fund.code)) || left.index - right.index;
  }).map(({ fund }) => fund);
}

function renderQdiiQuota(plugin, element) {
  const cache = normalizeQdiiQuotaCache(plugin.settings?.qdiiQuota);
  const root = element.createDiv({ cls: "fund-qdii" });
  const header = root.createDiv({ cls: "fund-qdii-head" });
  const heading = header.createDiv();
  heading.createEl("h1", { text: "QDII额度" });
  heading.createEl("span", { text: cache.reportDate ? `更新于 ${cache.reportDate}` : "尚未更新" });
  const actions = header.createDiv({ cls: "fund-qdii-actions" });
  const sortSelect = actions.createEl("select", { attr: { "aria-label": "QDII基金排序" } });
  for (const [value, label] of [
    ["default", "默认"],
    ["fee", "费率"],
    ["distributor", "代销额度"],
    ["direct", "直销额度"],
    ["code", "基金代码"],
  ]) {
    const option = sortSelect.createEl("option", { text: label });
    option.value = value;
  }
  sortSelect.value = ["fee", "distributor", "direct", "code"].includes(plugin.settings?.qdiiSort)
    ? plugin.settings.qdiiSort
    : "default";
  sortSelect.addEventListener("change", async () => {
    plugin.settings.qdiiSort = sortSelect.value;
    try {
      await plugin.saveSettings();
    } catch (error) {
      console.error("[基金助手] QDII排序偏好保存失败", error);
    }
    plugin.scheduleRenderedRefresh();
  });
  const sourceLink = actions.createEl("a", {
    text: "数据来源",
    attr: { href: QDII_SOURCE_URL, target: "_blank", rel: "noopener noreferrer" },
  });
  sourceLink.addClass("fund-qdii-source-link");
  const refreshButton = actions.createEl("button", { cls: "mod-cta", text: "更新额度" });
  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    refreshButton.setText("正在更新…");
    try {
      await plugin.refreshQdiiQuota(true);
    } finally {
      refreshButton.disabled = false;
      refreshButton.setText("更新额度");
    }
  });

  if (!cache.funds.length) {
    root.createDiv({ cls: "fund-qdii-empty", text: plugin.qdiiRefreshing ? "正在获取额度与费率…" : "正在准备额度数据…" });
    plugin.ensureQdiiQuotaFresh();
    return;
  }

  for (const topic of QDII_TOPICS) {
    const funds = sortQdiiFunds(cache.funds.filter((fund) => fund.topic === topic), sortSelect.value);
    const section = root.createDiv({ cls: "fund-qdii-section" });
    const sectionHead = section.createDiv({ cls: "fund-qdii-section-head" });
    sectionHead.createEl("h2", { text: topic });
    sectionHead.createSpan({ text: `${funds.length} 只可申购` });
    const scroll = section.createDiv({ cls: "fund-qdii-table-scroll" });
    const table = scroll.createEl("table", { cls: "fund-qdii-table" });
    const headerRow = table.createEl("thead").createEl("tr");
    for (const label of ["基金", "代销额度", "直销额度", "费率"]) headerRow.createEl("th", { text: label });
    const body = table.createEl("tbody");
    for (const fund of funds) {
      const row = body.createEl("tr");
      const identity = row.createEl("td");
      identity.createEl("a", {
        text: fund.name,
        attr: { href: fund.profileUrl, target: "_blank", rel: "noopener noreferrer" },
      });
      identity.createEl("small", { text: fund.code });
      row.createEl("td", { text: fund.distributor === "未单列" ? "-" : fund.distributor });
      row.createEl("td", { text: fund.direct === "未单列" ? "-" : fund.direct });
      const totalFee = qdiiFeeTotal(fund);
      row.createEl("td", { cls: "fund-qdii-fee", text: Number.isFinite(totalFee) ? `${totalFee.toFixed(2)}%` : "-" });
    }
  }
  plugin.ensureQdiiQuotaFresh();
}

module.exports = {
  QDII_SOURCE_URL,
  QDII_TOPICS,
  normalizeQdiiQuotaCache,
  parseQdiiFundFees,
  parseQdiiQuotaHtml,
  quotaChannels,
  qdiiFeeTotal,
  qdiiQuotaAmount,
  renderQdiiQuota,
  sortQdiiFunds,
};
