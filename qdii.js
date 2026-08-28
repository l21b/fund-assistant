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
  const checkedAt = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(String(source.checkedAt || "")) ? String(source.checkedAt) : "";
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
    checkedDate: /^\d{4}-\d{2}-\d{2}$/.test(String(source.checkedDate || "")) ? String(source.checkedDate) : checkedAt.slice(0, 10),
    checkedAt,
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
  if (!match) return NaN;
  const multiplier = match[2] === "亿" ? 100000000 : match[2] === "万" ? 10000 : 1;
  return Number(match[1]) * multiplier;
}

function qdiiQuotaDisplay(value) {
  const normalized = String(value || "").trim();
  return !normalized || normalized === "未单列" || normalized === "无额度" ? "-" : normalized;
}

function compareQdiiNumbers(left, right, direction = "desc") {
  const leftMissing = Number.isNaN(left);
  const rightMissing = Number.isNaN(right);
  if (leftMissing || rightMissing) {
    if (leftMissing && rightMissing) return 0;
    return leftMissing ? 1 : -1;
  }
  return direction === "desc" ? right - left : left - right;
}

function qdiiTotalQuota(fund) {
  const amounts = [qdiiQuotaAmount(fund?.distributor), qdiiQuotaAmount(fund?.direct)].filter((value) => !Number.isNaN(value));
  return amounts.length ? amounts.reduce((total, value) => total + value, 0) : NaN;
}

function sortQdiiFunds(funds) {
  const rows = (Array.isArray(funds) ? funds : []).map((fund, index) => ({ fund, index }));
  return rows.sort((left, right) => {
    const difference = compareQdiiNumbers(qdiiTotalQuota(left.fund), qdiiTotalQuota(right.fund));
    return difference
      || String(left.fund.name || "").localeCompare(String(right.fund.name || ""), "zh-CN-u-co-pinyin", { sensitivity: "base" })
      || String(left.fund.code).localeCompare(String(right.fund.code))
      || left.index - right.index;
  }).map(({ fund }) => fund);
}

const QDII_FUND_COMPARE_FIELDS = ["topic", "code", "name", "status", "distributor", "direct", "managementFee", "custodyFee"];

function qdiiQuotaChangeCounts(previousFunds, nextFunds, failedCodes = []) {
  const previous = Array.isArray(previousFunds) ? previousFunds : [];
  const next = Array.isArray(nextFunds) ? nextFunds : [];
  const failures = new Set(Array.from(failedCodes || [], (code) => String(code || "")));
  const previousByCode = new Map(previous.map((fund) => [String(fund?.code || ""), fund]));
  const nextCodes = new Set(next.map((fund) => String(fund?.code || "")));
  let updated = previous.filter((fund) => !nextCodes.has(String(fund?.code || ""))).length;
  let unchanged = 0;
  for (const fund of next) {
    if (failures.has(String(fund?.code || ""))) continue;
    const stored = previousByCode.get(String(fund?.code || ""));
    if (stored && QDII_FUND_COMPARE_FIELDS.every((field) => String(stored[field] || "") === String(fund[field] || ""))) unchanged += 1;
    else updated += 1;
  }
  return { updated, unchanged };
}

function renderQdiiQuota(plugin, element) {
  const cache = normalizeQdiiQuotaCache(plugin.settings?.qdiiQuota);
  const root = element.createDiv({ cls: "fund-qdii" });
  const header = root.createDiv({ cls: "fund-qdii-head fund-grid-head" });
  const heading = header.createDiv();
  heading.createEl("h1", { text: "QDII额度" });
  heading.createEl("span", { text: cache.checkedAt ? `更新于 ${cache.checkedAt}` : cache.reportDate ? `更新于 ${cache.reportDate}` : "尚未更新" });
  const actions = header.createDiv({ cls: "fund-qdii-actions fund-grid-actions" });
  const sourceButton = actions.createEl("button", { text: "数据来源" });
  sourceButton.addEventListener("click", () => window.open(QDII_SOURCE_URL, "_blank", "noopener,noreferrer"));
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
    root.createDiv({ cls: "fund-qdii-empty", text: plugin.qdiiRefreshing ? "正在获取额度与费率…" : "暂无额度数据，请点击更新额度" });
    return;
  }

  const heldFunds = typeof plugin.getFundRecords === "function" ? plugin.getFundRecords() : [];
  const heldByCode = new Map(heldFunds.map((fund) => [String(fund.code || ""), fund]));

  for (const topic of QDII_TOPICS) {
    const funds = sortQdiiFunds(cache.funds.filter((fund) => fund.topic === topic));
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
      const heldFund = heldByCode.get(fund.code);
      if (heldFund) {
        row.addClass("is-held");
        const definition = typeof plugin.getGroupDefinition === "function" ? plugin.getGroupDefinition(heldFund.group) : null;
        row.style.setProperty("--fund-held-color", definition?.color || "#d5a936");
      }
      const identity = row.createEl("td");
      identity.createEl("a", {
        text: fund.name,
        attr: { href: fund.profileUrl, target: "_blank", rel: "noopener noreferrer" },
      });
      identity.createEl("small", { text: fund.code });
      row.createEl("td", { text: qdiiQuotaDisplay(fund.distributor) });
      row.createEl("td", { text: qdiiQuotaDisplay(fund.direct) });
      const totalFee = qdiiFeeTotal(fund);
      row.createEl("td", { cls: "fund-qdii-fee", text: Number.isFinite(totalFee) ? `${totalFee.toFixed(2)}%` : "-" });
    }
  }
}

module.exports = {
  QDII_SOURCE_URL,
  QDII_TOPICS,
  normalizeQdiiQuotaCache,
  parseQdiiFundFees,
  parseQdiiQuotaHtml,
  quotaChannels,
  qdiiFeeTotal,
  qdiiQuotaChangeCounts,
  qdiiQuotaAmount,
  qdiiQuotaDisplay,
  qdiiTotalQuota,
  renderQdiiQuota,
  sortQdiiFunds,
};
