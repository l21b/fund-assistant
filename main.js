const {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
} = require("obsidian");
const { FUND_GROUPS, groupColor } = require("./constants");
const { dailyHoldingProfit, totalHoldingCost } = require("./fund-math");
const { renderFundOverview } = require("./overview");
const {
  GRID_LOOKBACK_DAYS,
  calculateSuggestedAxis,
  calculateSuggestedSpacing,
  evaluateGridAxisReview,
  gridCycleId,
  gridMarketSymbol,
  gridOfficialRows,
  parseGridKlinePayload,
  parseGridQuoteText,
  renderGridOverview,
} = require("./grid");

const FUND_FOLDER = "投资/基金持仓";
const OVERVIEW_FILE = "投资/投资总览.md";
const GROUP_CONFIG_FILE = "投资/基金配置.json";
const GRID_OVERVIEW_FILE = "投资/网格策略.md";
const DEFAULT_SETTINGS = {
  refreshOnStartup: true,
  setupPromptShown: false,
  gridHistory: {},
  selectedGridFundCode: "",
  groupReturnMetric: "rate",
};
const FUND_PROPERTY_ORDER = [
  "基金编号",
  "持仓份额",
  "持有金额",
  "持有收益",
  "持仓成本价",
  "持仓总成本",
  "持有收益率",
  "最新净值",
  "昨日净值",
  "净值日期",
  "涨跌幅",
  "网格启用",
  "网格参考代码",
  "网格参考名称",
  "网格当前价格",
  "网格行情日期",
  "网格行情时间",
  "网格执行中轴",
  "网格中轴日期",
  "网格建议中轴",
  "网格中轴状态",
  "网格间距",
  "网格建议间距",
  "网格已执行",
  "网格交易记录",
  "定投启用",
  "定投金额",
  "定投频率",
  "定投日期",
  "手续费率",
  "定投开始日期",
  "最后定投日期",
  "最近定投份额",
  "cssclasses",
];
const OBSOLETE_FUND_PROPERTIES = new Set(["持仓成本", "持仓基准日期", "网格基准净值", "每格金额"]);

const FREQUENCIES = { daily: "日", weekly: "周", monthly: "月" };
const FREQUENCY_VALUES = { 日: "daily", 周: "weekly", 月: "monthly" };
const WEEKDAYS = { 1: "周一", 2: "周二", 3: "周三", 4: "周四", 5: "周五" };
const WEEKDAY_VALUES = Object.fromEntries(Object.entries(WEEKDAYS).map(([key, value]) => [value, Number(key)]));

const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const validNumber = (value) => Number.isFinite(Number(value));
const positiveNumber = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
const parseDate = (value) => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const parsed = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return parsed.toISOString().slice(0, 10) === match[0] ? parsed : null;
};
const dateKey = (date) => date.toISOString().slice(0, 10);
const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
const money = (value) => Number(value || 0).toLocaleString("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 2,
});
const decimal = (value, digits = 4) => Number(value || 0).toLocaleString("zh-CN", {
  maximumFractionDigits: digits,
});
const fixedDecimal = (value, digits = 4) => Number(value || 0).toLocaleString("zh-CN", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});
const toneOf = (value) => Number(value) > 0 ? "positive" : Number(value) < 0 ? "negative" : "";
const FILE_NAME_REPLACEMENTS = {
  "\\": "＼", "/": "／", ":": "：", "*": "＊", "?": "？", "\"": "＂", "<": "＜", ">": "＞", "|": "｜",
};

function sanitizeFundName(value) {
  return String(value || "").trim()
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[\\/:*?"<>|]/g, (character) => FILE_NAME_REPLACEMENTS[character])
    .replace(/[. ]+$/g, "");
}

function validGroupName(value) {
  const name = String(value || "").trim();
  return Boolean(name && name !== "." && name !== ".." && sanitizeFundName(name) === name);
}

function fundGroupName(file) {
  const parentPath = String(file?.parent?.path || "").replace(/\\/g, "/");
  const parentName = String(file?.parent?.name || "").trim();
  if (parentPath === FUND_FOLDER || parentName === FUND_FOLDER.split("/").at(-1)) return "未分类";
  return parentName || "未分类";
}

function parseFundName(source) {
  const match = String(source || "").match(/fS_name\s*=\s*("(?:\\.|[^"\\])*")\s*;/);
  if (!match) throw new Error("没有找到基金名称");
  const name = String(JSON.parse(match[1]) || "").trim();
  if (!name) throw new Error("基金名称为空");
  return name;
}

function normalizeNavHistory(raw) {
  if (!Array.isArray(raw)) throw new Error("历史净值格式异常");
  const unique = new Map();
  for (const item of raw) {
    const timestamp = Number(item?.x);
    const date = Number.isFinite(timestamp)
      ? new Date(timestamp).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" })
      : "";
    const nav = Number(item?.y);
    const rawChange = Number(item?.equityReturn ?? 0);
    if (parseDate(date) && Number.isFinite(nav) && nav > 0) {
      unique.set(date, {
        date,
        nav,
        change: Number.isFinite(rawChange) ? rawChange : 0,
      });
    }
  }
  return [...unique.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function decodeGridQuoteResponse(response) {
  const bytes = response?.arrayBuffer;
  if (bytes && Number(bytes.byteLength) > 0) {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch (error) {
      console.warn("[基金助手] ETF名称解码失败，尝试使用文本响应", error);
    }
  }
  return String(response?.text || "");
}

function gridAxisAdoptionMode(executionAxis, suggestedAxis, status) {
  if (!positiveNumber(executionAxis) || !positiveNumber(suggestedAxis)
    || Number(executionAxis) === Number(suggestedAxis)) return "disabled";
  return status === "建议换轴" ? "direct" : "confirm";
}

function gridSpacingAdoptionEnabled(spacing, suggestedSpacing) {
  return positiveNumber(spacing) && positiveNumber(suggestedSpacing)
    && Math.abs(Number(spacing) - Number(suggestedSpacing)) >= 1;
}

function normalizeGridExecutedLevels(value) {
  if (!Array.isArray(value)) return [];
  const valid = [...new Set(value.map((item) => String(item || "").trim())
    .filter((item) => /^(buy|sell)-[1-5]$/.test(item)))];
  return valid.sort((left, right) => {
    const [leftSide, leftLevel] = left.split("-");
    const [rightSide, rightLevel] = right.split("-");
    if (leftSide !== rightSide) return leftSide === "buy" ? -1 : 1;
    return Number(leftLevel) - Number(rightLevel);
  });
}

function normalizeGridTradeRecords(value) {
  if (!Array.isArray(value)) return [];
  const records = [];
  for (const item of value) {
    const raw = String(item && typeof item === "object" ? item.raw || "" : item || "").trim();
    const match = raw.match(/^(\d{4}-\d{2}-\d{2})\s*·\s*(买入|卖出)\s*·\s*(中轴|[买卖][1-5])\s*·\s*(\d+(?:\.\d+)?)\s*·\s*周期\s+(\d{6}@\d{4}-\d{2}-\d{2}@\d+(?:\.\d+)?@\d+(?:\.\d+)?)(?:\s*·\s*(已取消))?$/);
    if (!match || !parseDate(match[1])) continue;
    const position = match[3] === "中轴" ? 0 : (match[3][0] === "买" ? -1 : 1) * Number(match[3].slice(1));
    const price = Number(match[4]);
    const cycleParts = match[5].split("@");
    const cycleId = gridCycleId(cycleParts[0], cycleParts[1], Number(cycleParts[2]), Number(cycleParts[3]));
    if (!Number.isInteger(position) || position < -5 || position > 5 || !(price > 0) || cycleId !== match[5]) continue;
    records.push({
      raw,
      date: match[1],
      side: match[2] === "买入" ? "buy" : "sell",
      position,
      price,
      cycleId,
      canceled: match[6] === "已取消",
    });
  }
  return records;
}

function gridTradeRecordValue(date, side, position, price, cycleId) {
  const normalizedDate = String(date || "");
  const normalizedSide = String(side || "");
  const normalizedPosition = Number(position);
  const normalizedPrice = Number(price);
  const normalizedCycleId = String(cycleId || "").trim();
  const cycleParts = normalizedCycleId.split("@");
  if (!parseDate(normalizedDate) || !/^(buy|sell)$/.test(normalizedSide)
    || !Number.isInteger(normalizedPosition) || normalizedPosition < -5 || normalizedPosition > 5
    || !(normalizedPrice > 0) || cycleParts.length !== 4
    || gridCycleId(cycleParts[0], cycleParts[1], Number(cycleParts[2]), Number(cycleParts[3])) !== normalizedCycleId) {
    throw new Error("网格买卖记录无效");
  }
  const positionLabel = normalizedPosition === 0
    ? "中轴"
    : `${normalizedPosition < 0 ? "买" : "卖"}${Math.abs(normalizedPosition)}`;
  return `${normalizedDate} · ${normalizedSide === "buy" ? "买入" : "卖出"} · ${positionLabel} · ${round(normalizedPrice, 6)} · 周期 ${normalizedCycleId}`;
}

function gridTradeRecordWithCanceledState(raw, canceled) {
  const record = normalizeGridTradeRecords([raw])[0];
  if (!record) throw new Error("网格买卖记录无效");
  const activeValue = gridTradeRecordValue(record.date, record.side, record.position, record.price, record.cycleId);
  return canceled ? `${activeValue} · 已取消` : activeValue;
}

function gridExecutedLevelsFromTrades(value, cycleId = "") {
  const states = new Set();
  const records = normalizeGridTradeRecords(value).map((trade, index) => ({ ...trade, index }))
    .sort((left, right) => left.date.localeCompare(right.date) || left.index - right.index);
  for (const trade of records) {
    if (trade.canceled || (cycleId && trade.cycleId !== cycleId)) continue;
    if (trade.side === "buy" && trade.position < 0) {
      states.add(`buy-${Math.abs(trade.position)}`);
    } else if (trade.side === "sell" && trade.position > 0) {
      states.add(`sell-${trade.position}`);
    } else if (trade.side === "sell") {
      states.delete(`buy-${Math.abs(trade.position) + 1}`);
    } else {
      states.delete(`sell-${trade.position + 1}`);
    }
  }
  return normalizeGridExecutedLevels([...states]);
}

function dcaScheduleValue(form) {
  return form.frequency === "weekly"
    ? WEEKDAYS[Number(form.weekday)]
    : form.frequency === "monthly"
      ? Number(form.monthday)
      : "每个交易日";
}

function effectiveDcaStartDate(initiallyEnabled, enabled, storedDate, today) {
  if (enabled && !initiallyEnabled) return today;
  return parseDate(storedDate) ? storedDate : today;
}

function validDcaSettings(enabled, amount, feeRate, startDate, frequency, schedule) {
  if (!enabled) return true;
  return Number.isFinite(Number(amount)) && Number(amount) > 0
    && Number.isFinite(Number(feeRate)) && Number(feeRate) >= 0 && Number(feeRate) <= 10
    && Boolean(parseDate(startDate))
    && (frequency === "daily" || (frequency === "weekly" && schedule >= 1 && schedule <= 5)
      || (frequency === "monthly" && schedule >= 1 && schedule <= 28));
}

function positionFromSnapshot(sharesValue, amountValue, profitValue) {
  if ([sharesValue, amountValue, profitValue].some((value) => value === null || value === undefined || String(value).trim() === "")) {
    return null;
  }
  const shares = Number(sharesValue);
  const amount = Number(amountValue);
  const profit = Number(profitValue);
  const totalCost = amount - profit;
  if (!(shares > 0) || !(amount > 0) || !Number.isFinite(profit) || !(totalCost > 0)) return null;
  return {
    shares: round(shares, 12),
    totalCost: round(totalCost, 12),
    costPrice: round(totalCost / shares, 12),
    amount: round(amount, 2),
    profit: round(profit, 2),
    profitRate: round(profit / totalCost * 100, 2),
  };
}

function createFundNoteContent(form) {
  const position = positionFromSnapshot(form.shares, form.holdingAmount, form.holdingProfit);
  if (!position) throw new Error("持仓信息不完整或格式不正确");
  const lines = [
    "---",
    `基金编号: "${form.code}"`,
    `持仓份额: ${position.shares}`,
    `持仓成本价: ${position.costPrice}`,
    `持仓总成本: ${position.totalCost}`,
    "网格启用: false",
    `定投启用: ${Boolean(form.dcaEnabled)}`,
    `定投金额: ${form.dcaEnabled ? round(form.amount, 2) : 0}`,
  ];
  if (form.dcaEnabled) {
    lines.push(
      `定投频率: ${FREQUENCIES[form.frequency]}`,
      `定投日期: ${dcaScheduleValue(form)}`,
      `手续费率: ${round(form.feeRate, 4)}`,
      `定投开始日期: ${form.startDate}`,
    );
  }
  lines.push(
    "cssclasses:",
    "  - fund-dashboard-note",
    "---",
    "",
    "```fund-dashboard",
    "```",
    "",
  );
  return lines.join("\n");
}

function createOverviewNoteContent() {
  return [
    "---",
    '更新日期: ""',
    "tags:",
    "  - 投资",
    "  - 基金",
    "cssclasses:",
    "  - fund-overview-note",
    "---",
    "",
    "```fund-overview",
    "```",
    "",
  ].join("\n");
}

function createGridOverviewNoteContent() {
  return [
    "---",
    "tags:",
    "  - 投资",
    "  - 网格",
    "cssclasses:",
    "  - fund-grid-overview-note",
    "---",
    "",
    "```fund-grid-overview",
    "```",
    "",
  ].join("\n");
}

function normalizedFundPropertyKeys(frontmatter) {
  const existing = Object.keys(frontmatter).filter((key) => !OBSOLETE_FUND_PROPERTIES.has(key));
  const existingSet = new Set(existing);
  const knownSet = new Set(FUND_PROPERTY_ORDER);
  return [
    ...FUND_PROPERTY_ORDER.filter((key) => existingSet.has(key)),
    ...existing.filter((key) => !knownSet.has(key)),
  ];
}

function fundPropertiesNeedNormalization(frontmatter) {
  const current = Object.keys(frontmatter);
  if (current.some((key) => OBSOLETE_FUND_PROPERTIES.has(key))) return true;
  const expected = normalizedFundPropertyKeys(frontmatter);
  return current.length !== expected.length || current.some((key, index) => key !== expected[index]);
}

function normalizeFundProperties(frontmatter) {
  const values = new Map(Object.entries(frontmatter));
  for (const key of Object.keys(frontmatter)) delete frontmatter[key];
  for (const key of normalizedFundPropertyKeys(Object.fromEntries(values))) {
    frontmatter[key] = values.get(key);
  }
  return frontmatter;
}

function applyGridStrategyChanges(frontmatter, changes) {
  for (const [key, value] of Object.entries(changes)) {
    if ((key === "网格已执行" || key === "网格交易记录") && Array.isArray(value) && value.length === 0) delete frontmatter[key];
    else frontmatter[key] = value;
  }
  return normalizeFundProperties(frontmatter);
}

function firstPointOnOrAfter(points, start) {
  return points.find((point) => point.date >= start);
}

function dueNavPoints(points, plan) {
  const startDate = parseDate(plan.startDate);
  if (!startDate || !points.length) return [];
  const latestDate = points.at(-1).date;
  const lastDate = plan.lastDate || "";
  const eligible = (point) => point.date >= plan.startDate && point.date > lastDate;

  if (plan.frequency === "daily") {
    return points.filter((point) => {
      const day = parseDate(point.date)?.getUTCDay();
      return eligible(point) && day >= 1 && day <= 5;
    });
  }

  const selected = [];
  const usedDates = new Set();
  if (plan.frequency === "weekly") {
    let cursor = new Date(startDate);
    while (cursor.getUTCDay() !== plan.schedule) cursor = addDays(cursor, 1);
    while (dateKey(cursor) <= latestDate) {
      const due = dateKey(cursor);
      const point = firstPointOnOrAfter(points, due);
      if (point && eligible(point) && !usedDates.has(point.date)) {
        selected.push(point);
        usedDates.add(point.date);
      }
      cursor = addDays(cursor, 7);
    }
  } else if (plan.frequency === "monthly") {
    let year = startDate.getUTCFullYear();
    let month = startDate.getUTCMonth();
    while (true) {
      const dueDate = new Date(Date.UTC(year, month, plan.schedule));
      const due = dateKey(dueDate);
      if (due > latestDate) break;
      if (due >= plan.startDate) {
        const point = firstPointOnOrAfter(points, due);
        if (point && eligible(point) && !usedDates.has(point.date)) {
          selected.push(point);
          usedDates.add(point.date);
        }
      }
      month += 1;
      if (month > 11) {
        month = 0;
        year += 1;
      }
    }
  }
  return selected;
}

class FundNavRefreshPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!this.settings.gridHistory || typeof this.settings.gridHistory !== "object" || Array.isArray(this.settings.gridHistory)) {
      this.settings.gridHistory = {};
    }
    this.settings.selectedGridFundCode = String(this.settings.selectedGridFundCode || "");
    this.settings.groupReturnMetric = this.settings.groupReturnMetric === "profit" ? "profit" : "rate";
    this.groupConfig = await this.loadGroupConfiguration();
    this.refreshing = false;
    this.gridRefreshing = false;
    this.fundDashboardViews = new Set();
    this.fundOverviewViews = new Set();
    this.gridOverviewViews = new Set();
    this.renderRefreshTimer = null;
    this.sessionRefreshTimer = null;
    this.sessionRefreshState = "idle";

    this.addCommand({
      id: "refresh-fund-nav",
      name: "更新基金净值与定投",
      callback: () => this.refreshAll(true),
    });
    this.addCommand({
      id: "initialize-investment-workspace",
      name: "初始化投资空间",
      callback: () => this.initializeInvestmentWorkspace(true),
    });
    this.addCommand({
      id: "open-grid-strategy",
      name: "打开网格策略",
      callback: () => this.openGridOverview(),
    });
    this.addCommand({
      id: "refresh-grid-market",
      name: "更新网格参考行情",
      callback: () => this.refreshGridStrategies(true),
    });
    this.addCommand({
      id: "configure-current-fund-dca",
      name: "设置当前基金定投",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        const valid = Boolean(file && this.isFundFile(file));
        if (valid && !checking) new DcaSettingsModal(this.app, this, file).open();
        return valid;
      },
    });
    this.registerMarkdownCodeBlockProcessor("fund-dashboard", (_source, element, context) => {
      const file = this.app.vault.getFileByPath(context.sourcePath);
      if (file) {
        this.fundDashboardViews.add({ element, file });
        this.renderFundDashboard(element, file);
      }
    });
    this.registerMarkdownCodeBlockProcessor("fund-overview", (_source, element, context) => {
      const file = this.app.vault.getFileByPath(context.sourcePath);
      if (file) {
        this.fundOverviewViews.add({ element, file });
        renderFundOverview(this, element, file);
      }
    });
    this.registerMarkdownCodeBlockProcessor("fund-grid-overview", (_source, element, context) => {
      const file = this.app.vault.getFileByPath(context.sourcePath);
      if (file) {
        this.gridOverviewViews.add({ element, file });
        renderGridOverview(this, element, file);
      }
    });
    this.registerEvent(this.app.metadataCache.on("changed", (file) => {
      if (this.isFundFile(file) || file.path === OVERVIEW_FILE || file.path === GRID_OVERVIEW_FILE) {
        this.scheduleRenderedRefresh();
      }
    }));
    const reloadGroupConfiguration = async (file) => {
      if (file.path === GROUP_CONFIG_FILE) {
        this.groupConfig = await this.loadGroupConfiguration();
        this.scheduleRenderedRefresh();
      }
    };
    this.registerEvent(this.app.vault.on("modify", reloadGroupConfiguration));
    this.registerEvent(this.app.vault.on("create", reloadGroupConfiguration));
    this.registerEvent(this.app.vault.on("delete", reloadGroupConfiguration));
    this.registerEvent(this.app.workspace.on("file-open", (file) => {
      this.maybeRunSessionRefresh(file);
    }));
    this.addSettingTab(new FundNavRefreshSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      if (this.settings.setupPromptShown || this.isInvestmentWorkspaceReady()) return;
      this.settings.setupPromptShown = true;
      await this.saveSettings();
      new InvestmentWorkspaceSetupModal(this.app, this).open();
    });

    this.app.workspace.onLayoutReady(() => {
      this.maybeRunSessionRefresh(this.app.workspace.getActiveFile());
    });
  }

  onunload() {
    if (this.renderRefreshTimer !== null) window.clearTimeout(this.renderRefreshTimer);
    if (this.sessionRefreshTimer !== null) window.clearTimeout(this.sessionRefreshTimer);
  }

  isInvestmentPage(file) {
    return Boolean(file && (this.isFundFile(file) || file.path === OVERVIEW_FILE || file.path === GRID_OVERVIEW_FILE));
  }

  maybeRunSessionRefresh(file) {
    if (!this.settings.refreshOnStartup || this.sessionRefreshState !== "idle"
      || !this.isFundWorkspaceReady() || !this.isInvestmentPage(file)) return;
    this.sessionRefreshState = "scheduled";
    this.sessionRefreshTimer = window.setTimeout(async () => {
      this.sessionRefreshTimer = null;
      if (!this.settings.refreshOnStartup) {
        this.sessionRefreshState = "idle";
        return;
      }
      this.sessionRefreshState = "running";
      try {
        await this.refreshAll(false);
        await this.refreshGridStrategies(false);
      } finally {
        this.sessionRefreshState = "complete";
        this.scheduleRenderedRefresh();
      }
    }, 300);
  }

  scheduleRenderedRefresh() {
    if (this.renderRefreshTimer !== null) window.clearTimeout(this.renderRefreshTimer);
    this.renderRefreshTimer = window.setTimeout(() => {
      this.renderRefreshTimer = null;
      this.refreshRenderedContent();
    }, 80);
  }

  refreshRenderedContent() {
    for (const view of [...this.fundDashboardViews]) {
      if (!view.element.isConnected) {
        this.fundDashboardViews.delete(view);
        continue;
      }
      view.element.empty();
      this.renderFundDashboard(view.element, view.file);
    }
    for (const view of [...this.fundOverviewViews]) {
      if (!view.element.isConnected) {
        this.fundOverviewViews.delete(view);
        continue;
      }
      view.element.empty();
      renderFundOverview(this, view.element, view.file);
    }
    for (const view of [...this.gridOverviewViews]) {
      if (!view.element.isConnected) {
        this.gridOverviewViews.delete(view);
        continue;
      }
      view.element.empty();
      renderGridOverview(this, view.element, view.file);
    }
  }

  isFundFile(file) {
    const prefix = `${FUND_FOLDER}/`;
    return file?.extension === "md" && file.path.startsWith(prefix);
  }

  getFundRecords() {
    return this.app.vault.getMarkdownFiles().filter((file) => this.isFundFile(file)).map((file) => {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const gridExecutionAxis = Number(frontmatter["网格执行中轴"] || 0);
      const gridAxisDate = String(frontmatter["网格中轴日期"] || "");
      const gridSpacing = Number(frontmatter["网格间距"] || 0);
      const gridReferenceCode = String(frontmatter["网格参考代码"] || "").trim();
      const cycleId = gridCycleId(gridReferenceCode, gridAxisDate, gridExecutionAxis, gridSpacing);
      const gridTradeRecords = normalizeGridTradeRecords(frontmatter["网格交易记录"]);
      return {
        file,
        name: file.basename,
        code: String(frontmatter["基金编号"] || "").trim(),
        group: fundGroupName(file),
        nav: Number(frontmatter["最新净值"] || 0),
        navDate: String(frontmatter["净值日期"] || ""),
        gridEnabled: frontmatter["网格启用"] === true,
        gridReferenceCode,
        gridReferenceName: String(frontmatter["网格参考名称"] || "").trim(),
        gridCurrentPrice: Number(frontmatter["网格当前价格"] || 0),
        gridMarketDate: String(frontmatter["网格行情日期"] || ""),
        gridMarketTime: String(frontmatter["网格行情时间"] || ""),
        gridExecutionAxis,
        gridAxisDate,
        gridSuggestedAxis: Number(frontmatter["网格建议中轴"] || 0),
        gridAxisStatus: String(frontmatter["网格中轴状态"] || ""),
        gridSpacing,
        gridSuggestedSpacing: Number(frontmatter["网格建议间距"] || 0),
        gridCycleId: cycleId,
        gridExecutedLevels: gridTradeRecords.length
          ? gridExecutedLevelsFromTrades(gridTradeRecords, cycleId)
          : normalizeGridExecutedLevels(frontmatter["网格已执行"]),
        gridTradeRecords,
      };
    }).filter((record) => /^\d{6}$/.test(record.code));
  }

  getFundGroupName(file) {
    return fundGroupName(file);
  }

  getFundGroupNames() {
    const root = this.app.vault.getAbstractFileByPath(FUND_FOLDER);
    const folders = Array.isArray(root?.children)
      ? root.children.filter((item) => Array.isArray(item.children)).map((item) => item.name)
      : [];
    const configured = Object.keys(this.groupConfig?.groups || {});
    const defaults = configured.length ? [] : FUND_GROUPS.map((item) => item.name);
    return [...new Set(["未分类", ...configured, ...defaults, ...folders])]
      .filter(Boolean);
  }

  async loadGroupConfiguration() {
    const file = this.app.vault.getFileByPath(GROUP_CONFIG_FILE);
    if (!file) return { groups: {} };
    try {
      const parsed = JSON.parse(await this.app.vault.read(file));
      return parsed && typeof parsed.groups === "object" && parsed.groups !== null
        ? { groups: parsed.groups }
        : { groups: {} };
    } catch (error) {
      console.error("[基金助手] 分组配置读取失败", error);
      return { groups: {} };
    }
  }

  getGroupDefinition(name) {
    const normalized = String(name || "未分类").trim() || "未分类";
    const configured = this.groupConfig?.groups?.[normalized] || {};
    const builtIn = FUND_GROUPS.find((group) => group.name === normalized);
    const configuredTarget = Number(configured.target);
    const target = Number.isFinite(configuredTarget)
      ? Math.min(100, Math.max(0, configuredTarget))
      : normalized === "未分类" ? 0 : Number(builtIn?.target ?? 0);
    const configuredColor = String(configured.color || "");
    return {
      name: normalized,
      target,
      color: /^#[0-9a-f]{6}$/i.test(configuredColor) ? configuredColor : groupColor(normalized),
    };
  }

  getGroupDefinitions() {
    return this.getFundGroupNames().map((name) => this.getGroupDefinition(name));
  }

  async saveGroupConfiguration(groups) {
    await this.ensureFolder(GROUP_CONFIG_FILE.split("/").slice(0, -1).join("/"));
    const content = `${JSON.stringify({ groups }, null, 2)}\n`;
    const file = this.app.vault.getFileByPath(GROUP_CONFIG_FILE);
    if (file) await this.app.vault.modify(file, content);
    else await this.app.vault.create(GROUP_CONFIG_FILE, content);
    this.groupConfig = { groups };
    this.scheduleRenderedRefresh();
  }

  getGridExecutionsFor(fund) {
    return normalizeGridExecutedLevels(fund?.gridExecutedLevels).map((key) => {
      const [side, level] = key.split("-");
      return { side, level: Number(level) };
    });
  }

  getGridTradeRecordsFor(fund) {
    return normalizeGridTradeRecords(fund?.gridTradeRecords);
  }

  requestGridExecution(options) {
    new GridExecutionConfirmModal(this.app, this, options).open();
  }

  async selectGridFund(code) {
    const normalized = String(code || "").trim();
    if (!/^\d{6}$/.test(normalized) || this.settings.selectedGridFundCode === normalized) return;
    this.settings.selectedGridFundCode = normalized;
    await this.saveSettings();
    this.scheduleRenderedRefresh();
  }

  async toggleGridExecution({ fund, mode = "", side, levelPrice, tradeIndex = null, tradeRaw = "", tradePosition = null, tradeDate = "", tradeCycleId = "" }) {
    const latestFund = this.getFundRecords().find((item) => item.code === fund.code);
    if (!latestFund) throw new Error("没有找到对应的基金策略");
    const currentCycleId = latestFund.gridCycleId
      || gridCycleId(latestFund.gridReferenceCode, latestFund.gridAxisDate, latestFund.gridExecutionAxis, latestFund.gridSpacing);
    if (!currentCycleId) throw new Error("网格参数不完整，请先完成策略设置");
    const currentTrades = normalizeGridTradeRecords(latestFund.gridTradeRecords);
    const normalizedMode = String(mode || "");
    if (!["record-trade", "cancel-trade", "restore-trade"].includes(normalizedMode)) {
      throw new Error("网格记录操作无效");
    }
    let nextTrades = currentTrades.map((record) => record.raw);
    if (normalizedMode === "cancel-trade" || normalizedMode === "restore-trade") {
      const normalizedTradeIndex = Number(tradeIndex);
      if (!Number.isInteger(normalizedTradeIndex) || normalizedTradeIndex < 0
        || normalizedTradeIndex >= nextTrades.length || nextTrades[normalizedTradeIndex] !== String(tradeRaw || "")) {
        throw new Error("这条买卖记录已经发生变化，请重新操作");
      }
      const targetTrade = currentTrades[normalizedTradeIndex];
      const restoring = normalizedMode === "restore-trade";
      if (restoring && !targetTrade.canceled) throw new Error("这条记录已经恢复");
      if (!restoring && targetTrade.canceled) throw new Error("这条记录已经取消");
      nextTrades[normalizedTradeIndex] = gridTradeRecordWithCanceledState(targetTrade.raw, !restoring);
    } else {
      const normalizedSide = String(side || "");
      const normalizedPosition = Number(tradePosition);
      const normalizedDate = String(tradeDate || "");
      const normalizedPrice = Number(levelPrice);
      const normalizedCycleId = String(tradeCycleId || "");
      if (normalizedCycleId !== currentCycleId) throw new Error("网格周期已变化，请刷新后重试");
      if (!/^(buy|sell)$/.test(normalizedSide) || !Number.isInteger(normalizedPosition)
        || normalizedPosition < -5 || normalizedPosition > 5 || !parseDate(normalizedDate)
        || !(normalizedPrice > 0)) throw new Error("网格触发点无效");
      const expectedPrice = this.getGridHistory(latestFund.gridReferenceCode)
        .find((row) => row.date === normalizedDate)?.close;
      if (!(expectedPrice > 0) || Math.abs(expectedPrice - normalizedPrice) > 1e-5) {
        throw new Error("参考收盘价已经变化，请刷新后重试");
      }
      const alreadyRecorded = currentTrades.some((trade) => trade.cycleId === normalizedCycleId
        && trade.date === normalizedDate && trade.side === normalizedSide && trade.position === normalizedPosition);
      if (alreadyRecorded) throw new Error("这个触发点已经有记录，请刷新后重试");
      nextTrades.push(gridTradeRecordValue(
        normalizedDate,
        normalizedSide,
        normalizedPosition,
        normalizedPrice,
        normalizedCycleId,
      ));
    }
    const next = gridExecutedLevelsFromTrades(nextTrades, currentCycleId);
    await this.app.fileManager.processFrontMatter(latestFund.file, (frontmatter) => {
      if (next.length) frontmatter["网格已执行"] = next;
      else delete frontmatter["网格已执行"];
      if (nextTrades.length) frontmatter["网格交易记录"] = nextTrades;
      else delete frontmatter["网格交易记录"];
      normalizeFundProperties(frontmatter);
    });
    this.scheduleRenderedRefresh();
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  getGridHistory(referenceCode) {
    const rows = this.settings.gridHistory?.[String(referenceCode || "").trim()];
    if (!Array.isArray(rows)) return [];
    return rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(String(row?.date || ""))
      && positiveNumber(row?.close)).map((row) => ({ date: String(row.date), close: Number(row.close) }));
  }

  async cacheGridHistory(market) {
    if (!/^\d{6}$/.test(String(market?.code || "")) || !Array.isArray(market?.rows)) return;
    this.settings.gridHistory[market.code] = market.rows.slice(-60).map((row) => ({
      date: String(row.date),
      close: round(row.close, 6),
    }));
    await this.saveSettings();
  }

  openAddFundModal() {
    new AddFundModal(this.app, this).open();
  }

  openGridStrategyModal(fundFile = null) {
    new GridStrategyModal(this.app, this, fundFile).open();
  }

  async openGridOverview() {
    let file = this.app.vault.getFileByPath(GRID_OVERVIEW_FILE);
    if (!file) {
      await this.ensureFolder(GRID_OVERVIEW_FILE.split("/").slice(0, -1).join("/"));
      file = await this.app.vault.create(GRID_OVERVIEW_FILE, createGridOverviewNoteContent());
    }
    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async gridMarketData(referenceCode) {
    const code = String(referenceCode || "").trim();
    const symbol = gridMarketSymbol(code);
    const [historyResponse, quoteResponse] = await Promise.all([
      requestUrl({
        url: `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${encodeURIComponent(`${symbol},day,,,100`)}`,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" },
        throw: false,
      }),
      requestUrl({
        url: `https://qt.gtimg.cn/q=${encodeURIComponent(symbol)}`,
        method: "GET",
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://gu.qq.com/" },
        throw: false,
      }),
    ]);
    if (historyResponse.status < 200 || historyResponse.status >= 300) {
      throw new Error(`ETF历史行情 HTTP ${historyResponse.status}`);
    }
    if (quoteResponse.status < 200 || quoteResponse.status >= 300) {
      throw new Error(`ETF实时报价 HTTP ${quoteResponse.status}`);
    }
    const parsedRows = parseGridKlinePayload(historyResponse.text, symbol);
    const quote = parseGridQuoteText(decodeGridQuoteResponse(quoteResponse), code);
    const rows = gridOfficialRows(parsedRows, quote);
    if (rows.length < GRID_LOOKBACK_DAYS) throw new Error(`ETF正式收盘行情不足${GRID_LOOKBACK_DAYS}个交易日`);
    const latestClose = rows.at(-1);
    const quoteIsLatest = !latestClose || quote.date >= latestClose.date;
    return {
      code,
      symbol,
      name: quote.name,
      rows,
      currentPrice: quoteIsLatest ? quote.current : latestClose.close,
      marketDate: quoteIsLatest ? quote.date : latestClose.date,
      marketTime: quoteIsLatest ? quote.time : "",
      closePrice: latestClose.close,
      closeDate: latestClose.date,
      suggestedAxis: calculateSuggestedAxis(rows, GRID_LOOKBACK_DAYS, 3),
      suggestedSpacing: calculateSuggestedSpacing(rows, GRID_LOOKBACK_DAYS),
    };
  }

  gridStrategyChanges(frontmatter, market, form = {}) {
    const spacing = Number(form.spacing ?? frontmatter["网格间距"]);
    const storedReferenceCode = String(frontmatter["网格参考代码"] || "").trim();
    const referenceChanged = storedReferenceCode !== market.code;
    let executionAxis = Number(form.executionAxis ?? frontmatter["网格执行中轴"]);
    let axisDate = String(form.axisDate ?? frontmatter["网格中轴日期"] ?? "");
    const closeDate = String(market.closeDate || market.marketDate || "");
    const closePrice = Number(market.closePrice || market.currentPrice);
    if (referenceChanged || !positiveNumber(executionAxis) || form.applySuggested === true) {
      executionAxis = market.suggestedAxis;
      axisDate = closeDate;
    }
    if (!parseDate(axisDate)) axisDate = closeDate;
    const storedAxis = Number(frontmatter["网格执行中轴"]);
    const storedSpacing = Number(frontmatter["网格间距"]);
    const storedAxisDate = String(frontmatter["网格中轴日期"] || "");
    const nextAxis = round(executionAxis, 4);
    const nextSpacing = round(spacing, 2);
    const cycleChanged = referenceChanged
      || storedAxis !== nextAxis
      || storedSpacing !== nextSpacing
      || storedAxisDate !== axisDate;
    const cycleId = gridCycleId(market.code, axisDate, nextAxis, nextSpacing);
    const tradeRecords = normalizeGridTradeRecords(frontmatter["网格交易记录"]);
    const executedLevels = cycleChanged
      ? []
      : tradeRecords.length
        ? gridExecutedLevelsFromTrades(tradeRecords, cycleId)
        : normalizeGridExecutedLevels(frontmatter["网格已执行"]);
    const review = evaluateGridAxisReview({
      rows: market.rows,
      executionAxis,
      suggestedAxis: market.suggestedAxis,
      spacingPercent: spacing,
      axisStartDate: axisDate,
      currentPrice: closePrice,
      executedLevels,
    });
    return {
      "网格启用": true,
      "网格参考代码": market.code,
      "网格参考名称": market.name,
      "网格当前价格": round(market.currentPrice, 4),
      "网格行情日期": market.marketDate,
      "网格行情时间": market.marketTime,
      "网格执行中轴": nextAxis,
      "网格中轴日期": axisDate,
      "网格建议中轴": round(market.suggestedAxis, 4),
      "网格中轴状态": form.applySuggested === true ? "正常" : review.status,
      "网格间距": nextSpacing,
      "网格建议间距": round(market.suggestedSpacing, 2),
      "网格已执行": executedLevels,
    };
  }

  async saveGridStrategy(fundFile, form) {
    const code = String(form.code || "").trim();
    const fund = this.getFundRecords().find((record) => record.code === code);
    if (!fund || (fundFile && fund.file.path !== fundFile.path)) throw new Error("请选择有效的持有基金");

    if (!form.enabled) {
      await this.app.fileManager.processFrontMatter(fund.file, (frontmatter) => {
        frontmatter["网格启用"] = false;
        normalizeFundProperties(frontmatter);
      });
      this.scheduleRenderedRefresh();
      return fund.file;
    }

    const referenceCode = String(form.referenceCode || "").trim();
    const spacing = Number(form.spacing);
    if (!/^\d{6}$/.test(referenceCode)
      || !Number.isFinite(spacing) || spacing <= 0 || spacing >= 20) {
      throw new Error("请检查参考ETF代码和网格间距");
    }
    const market = await this.gridMarketData(referenceCode);
    await this.cacheGridHistory(market);
    const stored = this.app.metadataCache.getFileCache(fund.file)?.frontmatter || {};
    const changes = this.gridStrategyChanges(stored, market, { ...form, spacing });
    await this.app.fileManager.processFrontMatter(fund.file, (frontmatter) => {
      applyGridStrategyChanges(frontmatter, changes);
    });
    this.scheduleRenderedRefresh();
    return fund.file;
  }

  async refreshGridStrategies(showNotice = false) {
    if (this.gridRefreshing) {
      if (showNotice) new Notice("网格行情正在更新，请稍候");
      return { updated: 0, unchanged: 0, failures: [] };
    }
    const funds = this.getFundRecords().filter((fund) => fund.gridEnabled);
    if (!funds.length) {
      if (showNotice) new Notice("没有已启用的网格策略");
      return { updated: 0, unchanged: 0, failures: [] };
    }
    this.gridRefreshing = true;
    if (showNotice) new Notice("正在更新网格参考行情…");
    let updated = 0;
    let unchanged = 0;
    const failures = [];
    try {
      for (const fund of funds) {
        try {
          if (!/^\d{6}$/.test(fund.gridReferenceCode)) throw new Error("请先设置参考ETF代码");
          const market = await this.gridMarketData(fund.gridReferenceCode);
          await this.cacheGridHistory(market);
          const frontmatter = this.app.metadataCache.getFileCache(fund.file)?.frontmatter || {};
          const changes = this.gridStrategyChanges(frontmatter, market);
          if (!this.hasChanges(frontmatter, changes) && !fundPropertiesNeedNormalization(frontmatter)) {
            unchanged += 1;
            continue;
          }
          await this.app.fileManager.processFrontMatter(fund.file, (target) => {
            applyGridStrategyChanges(target, changes);
          });
          updated += 1;
        } catch (error) {
          failures.push(`${fund.name}：${error?.message || String(error)}`);
        }
      }
      this.scheduleRenderedRefresh();
      if (showNotice) {
        const summary = `网格行情：${updated} 个更新，${unchanged} 个已是最新，${failures.length} 个失败`;
        new Notice(failures.length ? `${summary}\n${failures.join("\n")}` : summary, failures.length ? 10000 : 4500);
      }
      if (failures.length) console.warn("[基金助手] 网格行情", failures);
      return { updated, unchanged, failures };
    } finally {
      this.gridRefreshing = false;
    }
  }

  openGroupConfigurationModal() {
    new GroupConfigurationModal(this.app, this).open();
  }

  async ensureFolder(folderPath) {
    let currentPath = "";
    for (const segment of folderPath.split("/").filter(Boolean)) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (existing && "extension" in existing) throw new Error(`${currentPath} 已被同名文件占用`);
      if (!existing) await this.app.vault.createFolder(currentPath);
    }
  }

  isFundWorkspaceReady() {
    return Boolean(
      this.app.vault.getAbstractFileByPath(FUND_FOLDER)
      && this.app.vault.getFileByPath(OVERVIEW_FILE),
    );
  }

  isInvestmentWorkspaceReady() {
    return this.isFundWorkspaceReady() && Boolean(this.app.vault.getFileByPath(GRID_OVERVIEW_FILE));
  }

  async initializeInvestmentWorkspace(openOverview = false) {
    try {
      await this.ensureFolder(FUND_FOLDER);
      const logPath = OVERVIEW_FILE;
      const parent = logPath.split("/").slice(0, -1).join("/");
      if (parent) await this.ensureFolder(parent);

      let overviewFile = this.app.vault.getFileByPath(logPath);
      if (!overviewFile) overviewFile = await this.app.vault.create(logPath, createOverviewNoteContent());
      if (!this.app.vault.getFileByPath(GRID_OVERVIEW_FILE)) {
        await this.app.vault.create(GRID_OVERVIEW_FILE, createGridOverviewNoteContent());
      }
      if (!this.app.vault.getFileByPath(GROUP_CONFIG_FILE)) {
        const groups = Object.fromEntries(this.getGroupDefinitions().map((group) => [group.name, {
          target: group.target,
          color: group.color,
        }]));
        await this.saveGroupConfiguration(groups);
      }
      if (openOverview) await this.app.workspace.getLeaf(false).openFile(overviewFile);
      new Notice("投资空间已就绪");
      return true;
    } catch (error) {
      new Notice(`初始化失败：${error?.message || String(error)}`);
      return false;
    }
  }

  async createFund(form) {
    const code = String(form.code || "").trim();
    const group = String(form.group || "").trim();
    const shares = Number(form.shares);
    const position = positionFromSnapshot(form.shares, form.holdingAmount, form.holdingProfit);
    const allowedGroups = new Set(this.getFundGroupNames());
    const schedule = form.frequency === "weekly" ? Number(form.weekday) : form.frequency === "monthly" ? Number(form.monthday) : 0;
    const validDca = validDcaSettings(
      form.dcaEnabled,
      form.amount,
      form.feeRate,
      form.startDate,
      form.frequency,
      schedule,
    );
    if (!/^\d{6}$/.test(code) || !position || !allowedGroups.has(group) || !validDca) {
      throw new Error("基金信息不完整或格式不正确");
    }

    const duplicateCode = this.app.vault.getMarkdownFiles().find((file) => {
      if (!this.isFundFile(file)) return false;
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      return String(frontmatter["基金编号"] || "").trim() === code;
    });
    if (duplicateCode) throw new Error(`基金代码已存在：${duplicateCode.basename}`);

    const resolvedName = form.resolvedCode === code && form.resolvedName
      ? form.resolvedName
      : await this.fundName(code);
    const name = sanitizeFundName(resolvedName);
    if (!name) throw new Error("无法识别基金名称");

    const rootFolder = FUND_FOLDER;
    const targetFolder = `${rootFolder}/${group}`;
    await this.ensureFolder(targetFolder);
    const path = `${targetFolder}/${name}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) throw new Error(`基金已存在：${name}`);

    const file = await this.app.vault.create(path, createFundNoteContent({
      ...form,
      code,
      shares,
      resolvedName,
    }));
    await this.app.fileManager.processFrontMatter(file, () => {});
    return file;
  }

  renderFundDashboard(element, file) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const root = element.createDiv({ cls: "fund-dashboard" });
    const groupName = this.getFundGroupName(file);
    root.style.setProperty("--fund-group-color", this.getGroupDefinition(groupName).color);
    const shares = Number(fm["持仓份额"] || 0);
    const costPrice = Number(fm["持仓成本价"]);
    const totalCost = Number(fm["持仓总成本"]);
    const legacyCost = Number(fm["持仓成本"]);
    const displayedCostPrice = shares && Number.isFinite(totalCost)
      ? totalCost / shares
      : Number.isFinite(costPrice) ? costPrice : shares && Number.isFinite(legacyCost) ? legacyCost / shares : 0;
    const amount = Number(fm["持有金额"] || 0);
    const profit = Number(fm["持有收益"] || 0);
    const profitRate = Number(fm["持有收益率"] || 0);
    const change = Number(fm["涨跌幅"] || 0);
    const dailyProfit = dailyHoldingProfit(fm);
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    const dailyProfitLabel = String(fm["净值日期"] || "") === today ? "今日收益" : "昨日收益";

    const header = root.createDiv({ cls: "fund-dashboard-head" });
    const identity = header.createDiv({ cls: "fund-dashboard-identity" });
    identity.createEl("h2", { text: file.basename });
    const identityMeta = identity.createDiv({ cls: "fund-dashboard-identity-meta" });
    identityMeta.createSpan({ cls: "fund-dashboard-code", text: String(fm["基金编号"] || "--") });
    identityMeta.createSpan({ cls: "fund-dashboard-tag", text: groupName });
    if (fm["定投启用"] === true) identityMeta.createSpan({ cls: "fund-dashboard-plan-tag", text: "定投" });
    if (fm["网格启用"] === true) identityMeta.createSpan({ cls: "fund-dashboard-plan-tag", text: "网格" });
    const actions = header.createDiv({ cls: "fund-dashboard-actions" });
    const calibrateButton = actions.createEl("button", { text: "持仓校准" });
    calibrateButton.addEventListener("click", () => new HoldingCalibrationModal(this.app, this, file).open());
    const settingsButton = actions.createEl("button", { text: "定投设置" });
    settingsButton.addEventListener("click", () => new DcaSettingsModal(this.app, this, file).open());
    const refreshButton = actions.createEl("button", { cls: "mod-cta", text: "更新净值" });
    refreshButton.addEventListener("click", async () => {
      refreshButton.disabled = true;
      refreshButton.setText("正在更新…");
      try {
        await this.refreshAll(true);
      } finally {
        refreshButton.disabled = false;
        refreshButton.setText("更新净值");
      }
    });

    const hero = root.createDiv({ cls: "fund-dashboard-hero" });
    const amountBlock = hero.createDiv({ cls: "fund-dashboard-amount" });
    amountBlock.createSpan({ text: "持有金额" });
    amountBlock.createEl("strong", { text: money(amount) });
    const heroReturns = hero.createDiv({ cls: "fund-dashboard-returns" });
    const addReturn = (label, value, text) => {
      const item = heroReturns.createDiv();
      item.createSpan({ text: label });
      item.createEl("b", { cls: toneOf(value), text });
    };
    addReturn(
      dailyProfitLabel,
      dailyProfit ?? 0,
      dailyProfit === null ? "--" : `${dailyProfit > 0 ? "+" : ""}${money(dailyProfit)}`,
    );
    addReturn("持有收益", profit, `${profit > 0 ? "+" : ""}${money(profit)}`);
    addReturn("持有收益率", profitRate, `${profitRate > 0 ? "+" : ""}${fixedDecimal(profitRate, 2)}%`);

    const sections = root.createDiv({ cls: "fund-dashboard-sections" });
    const addMetric = (parent, label, value, tone = "") => {
      const item = parent.createDiv({ cls: "fund-dashboard-metric" });
      item.createSpan({ text: label });
      item.createEl("b", { cls: tone, text: value });
    };
    const navCard = sections.createDiv({ cls: "fund-dashboard-card" });
    navCard.createEl("h3", { text: "净值信息" });
    const navGrid = navCard.createDiv({ cls: "fund-dashboard-grid" });
    addMetric(navGrid, "最新净值", fixedDecimal(fm["最新净值"], 4));
    addMetric(navGrid, "涨跌幅", `${change > 0 ? "+" : ""}${decimal(change, 2)}%`, toneOf(change));
    addMetric(navGrid, "净值日期", String(fm["净值日期"] || "尚未更新"));

    const positionCard = sections.createDiv({ cls: "fund-dashboard-card" });
    positionCard.createEl("h3", { text: "持仓信息" });
    const positionGrid = positionCard.createDiv({ cls: "fund-dashboard-grid fund-dashboard-position-grid" });
    addMetric(positionGrid, "持仓成本价", shares ? decimal(displayedCostPrice) : "--");
    addMetric(positionGrid, "持仓份额", decimal(shares, 2));

    const dcaCard = root.createDiv({ cls: "fund-dashboard-card fund-dashboard-dca" });
    const dcaHead = dcaCard.createDiv({ cls: "fund-dashboard-card-head" });
    dcaHead.createEl("h3", { text: "定投计划" });
    const enabled = fm["定投启用"] === true;
    dcaHead.createSpan({
      cls: `fund-dashboard-status ${enabled ? "enabled" : ""}`,
      text: enabled ? "已启用" : "未启用",
    });
    const dcaGrid = dcaCard.createDiv({ cls: "fund-dashboard-grid fund-dashboard-grid-four" });
    addMetric(dcaGrid, "每期金额", money(fm["定投金额"]));
    addMetric(dcaGrid, "定投频率", enabled ? `${fm["定投频率"] || "--"} · ${fm["定投日期"] || "--"}` : "--");
    addMetric(dcaGrid, "费率", `${decimal(fm["手续费率"], 4)}%`);
    addMetric(dcaGrid, "最近确认", String(fm["最后定投日期"] || "尚未执行"));
  }

  async fundSource(code) {
    const response = await requestUrl({
      url: `https://fund.eastmoney.com/pingzhongdata/${encodeURIComponent(code)}.js`,
      method: "GET",
      headers: { "User-Agent": "Mozilla/5.0", Referer: "https://fund.eastmoney.com/" },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    return response.text;
  }

  async fundName(code) {
    return parseFundName(await this.fundSource(code));
  }

  async navHistory(code) {
    const source = await this.fundSource(code);
    const match = source.match(/Data_netWorthTrend\s*=\s*(\[.*?\]);/s);
    if (!match) throw new Error("没有找到历史净值");

    let raw;
    try {
      raw = JSON.parse(match[1]);
    } catch {
      throw new Error("历史净值格式异常");
    }
    const points = normalizeNavHistory(raw);
    if (!points.length) throw new Error("历史净值为空");
    return points;
  }

  prepareFund(frontmatter, history) {
    const latest = history.at(-1);
    const previous = history.at(-2) || null;
    let shares = Number(frontmatter["持仓份额"]);
    let cost = totalHoldingCost(frontmatter);
    const result = { latest, previous, shares, cost, executions: [] };

    if (!Number.isFinite(shares) || shares < 0 || !Number.isFinite(cost) || cost < 0) {
      result.positionWarning = "缺少有效的持仓份额或持仓总成本";
      return result;
    }

    if (frontmatter["定投启用"] === true && Number(frontmatter["定投金额"]) > 0) {
      const frequency = FREQUENCY_VALUES[String(frontmatter["定投频率"])] || String(frontmatter["定投频率"] || "");
      const scheduleRaw = frontmatter["定投日期"];
      const schedule = frequency === "weekly"
        ? WEEKDAY_VALUES[String(scheduleRaw)] || Number(scheduleRaw)
        : frequency === "monthly"
          ? Number(scheduleRaw)
          : 0;
      const plan = {
        amount: Number(frontmatter["定投金额"]),
        feeRate: Number(frontmatter["手续费率"] || 0),
        frequency,
        schedule,
        startDate: String(frontmatter["定投开始日期"] || ""),
        lastDate: String(frontmatter["最后定投日期"] || ""),
      };
      const validPlan = parseDate(plan.startDate)
        && ["daily", "weekly", "monthly"].includes(plan.frequency)
        && plan.feeRate >= 0 && plan.feeRate <= 10
        && (plan.frequency === "daily" || (plan.frequency === "weekly" && plan.schedule >= 1 && plan.schedule <= 5)
          || (plan.frequency === "monthly" && plan.schedule >= 1 && plan.schedule <= 28));
      if (!validPlan) {
        result.planWarning = "定投设置不完整";
        return result;
      }

      result.executions = dueNavPoints(history, plan);
      for (const point of result.executions) {
        const netAmount = plan.amount / (1 + plan.feeRate / 100);
        const acquiredShares = netAmount / point.nav;
        shares += acquiredShares;
        cost += plan.amount;
        result.lastExecutionShares = acquiredShares;
      }
      result.shares = shares;
      result.cost = cost;
      result.plan = plan;
    }
    return result;
  }

  buildChanges(frontmatter, prepared) {
    const { latest, previous } = prepared;
    const changes = {
      "最新净值": latest.nav,
      "净值日期": latest.date,
      "昨日净值": previous?.nav ?? null,
      "涨跌幅": latest.change,
    };

    if (Number.isFinite(prepared.shares) && Number.isFinite(prepared.cost)) {
      // Keep enough precision in frontmatter for future DCA accumulation.
      // Formatting belongs to the renderer; rounding the stored position here
      // permanently loses fractional shares on every refresh.
      const storedShares = round(prepared.shares, 12);
      const storedCostPrice = storedShares ? round(prepared.cost / prepared.shares, 12) : 0;
      const amount = prepared.shares * latest.nav;
      const profit = amount - prepared.cost;
      Object.assign(changes, {
        "持仓份额": storedShares,
        "持仓成本价": storedCostPrice,
        "持仓总成本": round(prepared.cost, 12),
        "持有金额": round(amount, 2),
        "持有收益": round(profit, 2),
        "持有收益率": prepared.cost ? round(profit / prepared.cost * 100, 2) : 0,
      });
    }
    if (prepared.executions.length && prepared.plan) {
      const last = prepared.executions.at(-1);
      changes["最后定投日期"] = last.date;
      changes["最近定投份额"] = round(prepared.lastExecutionShares, 12);
    }
    return changes;
  }

  hasChanges(frontmatter, changes) {
    return Object.entries(changes).some(([key, value]) => {
      const current = frontmatter[key];
      if (typeof value === "number") return !validNumber(current) || Number(current) !== value;
      if (Array.isArray(value)) {
        if (value.length === 0 && current === undefined) return false;
        return JSON.stringify(Array.isArray(current) ? current : []) !== JSON.stringify(value);
      }
      return current !== value;
    });
  }

  async refreshAll(showStartNotice) {
    if (this.refreshing) {
      if (showStartNotice) new Notice("基金数据正在更新，请稍候");
      return;
    }
    this.refreshing = true;
    if (showStartNotice) new Notice("正在更新基金净值与定投…");
    try {
      const files = this.app.vault.getMarkdownFiles().filter((file) => this.isFundFile(file));
      if (!files.length) {
        new Notice(`没有在 ${FUND_FOLDER} 找到基金笔记`);
        return;
      }

      const histories = new Map();
      const failures = [];
      const warnings = [];
      const updatedItems = [];
      const unchangedItems = [];
      let updated = 0;
      let unchanged = 0;
      let organized = 0;
      let executionCount = 0;

      for (const file of files) {
        const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
        const code = String(frontmatter["基金编号"] ?? "").trim();
        if (!/^\d{6}$/.test(code)) {
          failures.push(`${file.basename}：基金编号无效`);
          continue;
        }
        try {
          if (!histories.has(code)) histories.set(code, await this.navHistory(code));
          const prepared = this.prepareFund(frontmatter, histories.get(code));
          if (prepared.positionWarning) warnings.push(`${file.basename}：${prepared.positionWarning}`);
          if (prepared.planWarning) warnings.push(`${file.basename}：${prepared.planWarning}`);
          const changes = this.buildChanges(frontmatter, prepared);
          const dataChanged = this.hasChanges(frontmatter, changes);
          const propertiesChanged = fundPropertiesNeedNormalization(frontmatter);
          if (!dataChanged && !propertiesChanged) {
            unchanged += 1;
            unchangedItems.push(`${file.basename}：净值已是最新`);
            continue;
          }
          await this.app.fileManager.processFrontMatter(file, (target) => {
            for (const [key, value] of Object.entries(changes)) target[key] = value;
            normalizeFundProperties(target);
          });
          if (dataChanged) {
            updated += 1;
            const executionText = prepared.executions.length ? `，补算 ${prepared.executions.length} 期定投` : "";
            updatedItems.push(`${file.basename}：已更新至 ${prepared.latest.date}${executionText}`);
          }
          else {
            organized += 1;
            unchanged += 1;
            unchangedItems.push(`${file.basename}：净值已是最新，已整理属性`);
          }
          executionCount += prepared.executions.length;
        } catch (error) {
          failures.push(`${file.basename}：${error?.message || String(error)}`);
        }
      }

      if (updated > 0) await this.updateLogDate();
      const summary = `更新完成：成功 ${updated} · 未更新 ${unchanged} · 失败 ${failures.length}`;
      const notice = new Notice(`${summary} · 点击查看详情`, 8000);
      if (notice.noticeEl) {
        notice.noticeEl.addClass("fund-refresh-summary-notice");
        notice.noticeEl.setAttribute("role", "button");
        notice.noticeEl.setAttribute("tabindex", "0");
        const openDetails = () => new RefreshResultModal(this.app, {
          summary,
          updatedItems,
          unchangedItems,
          failures,
          warnings,
          executionCount,
          organized,
        }).open();
        notice.noticeEl.addEventListener("click", openDetails);
        notice.noticeEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openDetails();
          }
        });
      }
      if (failures.length) console.error("[基金助手]", failures);
      if (warnings.length) console.warn("[基金助手]", warnings);
    } finally {
      this.refreshing = false;
    }
  }

  async updateLogDate() {
    const file = this.app.vault.getFileByPath(OVERVIEW_FILE);
    if (!file) return;
    const localDate = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter["更新日期"] = localDate;
    });
  }
}

class RefreshResultModal extends Modal {
  constructor(app, result) {
    super(app);
    this.result = result;
  }

  onOpen() {
    const { contentEl } = this;
    const result = this.result;
    contentEl.empty();
    contentEl.addClass("fund-refresh-result-modal");
    contentEl.createEl("h2", { text: "净值更新结果" });
    contentEl.createEl("p", { cls: "fund-refresh-result-summary", text: result.summary });

    const addSection = (title, items, emptyText) => {
      const section = contentEl.createDiv({ cls: "fund-refresh-result-section" });
      section.createEl("h3", { text: `${title} ${items.length}` });
      if (!items.length) {
        section.createEl("p", { cls: "fund-refresh-result-empty", text: emptyText });
        return;
      }
      const list = section.createEl("ul");
      for (const item of items) list.createEl("li", { text: item });
    };

    addSection("成功", result.updatedItems, "本次没有基金需要更新");
    addSection("未更新", result.unchangedItems, "没有已是最新的基金");
    addSection("失败", result.failures, "没有更新失败");
    if (result.warnings.length) addSection("配置提醒", result.warnings, "");

    const extras = [];
    if (result.executionCount) extras.push(`补算 ${result.executionCount} 期定投`);
    if (result.organized) extras.push(`整理 ${result.organized} 只基金属性`);
    if (extras.length) contentEl.createEl("p", { cls: "fund-refresh-result-extra", text: extras.join(" · ") });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GroupConfigurationModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.rows = plugin.getGroupDefinitions().map((group) => ({ ...group }));
    this.initialNames = new Set(this.rows.map((group) => group.name));
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("fund-group-config-modal");
    contentEl.empty();
    contentEl.createEl("h2", { text: "分组配置" });
    contentEl.createEl("p", { text: "设置各分组的目标占比和颜色，目标占比合计需要等于 100%。" });

    new Setting(contentEl)
      .setName("分组列表")
      .setDesc("新分组会在保存时创建对应文件夹。")
      .addButton((button) => button.setButtonText("添加分组").onClick(() => this.addGroupRow()));
    this.listEl = contentEl.createDiv({ cls: "fund-group-config-list" });
    this.renderRows();

    this.totalEl = contentEl.createDiv({ cls: "fund-group-config-total" });
    this.updateTotal();
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText("保存").onClick(() => this.save()));
  }

  addGroupRow() {
    this.rows.push({
      name: "",
      target: 0,
      color: groupColor(`新分组-${Date.now()}-${this.rows.length}`),
      isNew: true,
    });
    this.renderRows();
    this.updateTotal();
    this.listEl.querySelector(".fund-group-name-input:last-of-type")?.focus();
  }

  renderRows() {
    if (!this.listEl) return;
    this.listEl.empty();
    for (const row of this.rows) {
      const setting = new Setting(this.listEl).setName(row.isNew ? "新分组" : row.name);
      if (row.isNew) {
        setting.addText((text) => {
          text.inputEl.addClass("fund-group-name-input");
          text.setPlaceholder("分组名称").setValue(row.name).onChange((value) => {
            row.name = value;
          });
        });
      }
      setting
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "0";
          text.inputEl.max = "100";
          text.inputEl.step = "0.01";
          text.inputEl.addClass("fund-group-target-input");
          text.setPlaceholder("占比").setValue(String(row.target)).onChange((value) => {
            row.target = value.trim() === "" ? NaN : Number(value);
            this.updateTotal();
          });
        })
        .addColorPicker((picker) => picker.setValue(row.color).onChange((value) => {
          row.color = value;
        }));
      if (row.name !== "未分类") {
        setting.addExtraButton((button) => button.setIcon("trash-2").setTooltip("移除").onClick(() => {
          if (!row.isNew && this.plugin.getFundRecords().some((fund) => fund.group === row.name)) {
            new Notice("该分组仍有基金，请先移动或删除其中的基金");
            return;
          }
          this.rows = this.rows.filter((item) => item !== row);
          this.renderRows();
          this.updateTotal();
        }));
      }
    }
  }

  updateTotal() {
    if (!this.totalEl) return;
    const valid = this.rows.every((row) => Number.isFinite(row.target) && row.target >= 0 && row.target <= 100);
    const total = this.rows.reduce((sum, row) => sum + (Number.isFinite(row.target) ? row.target : 0), 0);
    const complete = valid && Math.abs(total - 100) <= 0.01;
    this.totalEl.className = `fund-group-config-total ${complete ? "is-complete" : "is-incomplete"}`;
    this.totalEl.setText(`目标占比合计 ${total.toFixed(2)}%${complete ? "" : " · 还需调整"}`);
  }

  async save() {
    const names = this.rows.map((row) => String(row.name || "").trim());
    const normalizedNames = names.map((name) => name.toLocaleLowerCase("zh-CN"));
    if (names.some((name) => !validGroupName(name)) || new Set(normalizedNames).size !== names.length) {
      new Notice("请检查分组名称，名称不能为空、重复或包含文件名禁用字符");
      return;
    }
    const total = this.rows.reduce((sum, row) => sum + Number(row.target), 0);
    const valid = this.rows.every((row) => Number.isFinite(row.target) && row.target >= 0 && row.target <= 100)
      && Math.abs(total - 100) <= 0.01;
    if (!valid) {
      new Notice("目标占比合计需要等于 100%" );
      return;
    }
    try {
      const removedNames = [...this.initialNames].filter((name) => name !== "未分类" && !names.includes(name));
      for (const name of removedNames) {
        const folder = this.app.vault.getAbstractFileByPath(`${FUND_FOLDER}/${name}`);
        if (folder && (!Array.isArray(folder.children) || folder.children.length)) {
          throw new Error(`${name} 分组仍包含文件，无法删除`);
        }
      }
      for (const row of this.rows.filter((item) => item.isNew)) {
        await this.plugin.ensureFolder(`${FUND_FOLDER}/${String(row.name).trim()}`);
      }
      const groups = Object.fromEntries(this.rows.map((row) => [String(row.name).trim(), {
        target: round(row.target, 2),
        color: row.color,
      }]));
      for (const name of removedNames) {
        const folder = this.app.vault.getAbstractFileByPath(`${FUND_FOLDER}/${name}`);
        if (folder) await this.app.vault.delete(folder, true);
      }
      await this.plugin.saveGroupConfiguration(groups);
      this.close();
      new Notice("分组配置已保存");
    } catch (error) {
      new Notice(`分组保存失败：${error?.message || String(error)}`);
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class InvestmentWorkspaceSetupModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "创建投资空间" });
    contentEl.createEl("p", { text: "一键创建投资总览、网格策略页面和基金持仓目录，已有文件不会被覆盖。" });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("暂不创建").onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText("一键创建").onClick(async () => {
        button.setDisabled(true);
        if (await this.plugin.initializeInvestmentWorkspace(true)) this.close();
        else button.setDisabled(false);
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class HoldingCalibrationModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    this.saving = false;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
    this.form = {
      shares: String(fm["持仓份额"] ?? ""),
      holdingAmount: String(fm["持有金额"] ?? ""),
      holdingProfit: String(fm["持有收益"] ?? ""),
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `${this.file.basename} · 持仓校准` });
    const addNumber = (name, key, placeholder, allowNegative = false) => {
      new Setting(contentEl).setName(name).addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.step = "0.01";
        if (!allowNegative) text.inputEl.min = "0.01";
        text.setPlaceholder(placeholder).setValue(this.form[key])
          .onChange((value) => { this.form[key] = value; });
      });
    };
    addNumber("持仓份额", "shares", "支付宝当前份额");
    addNumber("持有金额", "holdingAmount", "支付宝当前金额");
    addNumber("持有收益", "holdingProfit", "亏损请输入负数", true);
    new Setting(contentEl).addButton((button) => button.setCta().setButtonText("保存校准").onClick(() => this.save()));
  }

  async save() {
    if (this.saving) return;
    const position = positionFromSnapshot(this.form.shares, this.form.holdingAmount, this.form.holdingProfit);
    if (!position) {
      new Notice("请检查持仓份额、持有金额和持有收益");
      return;
    }
    this.saving = true;
    try {
      await this.app.fileManager.processFrontMatter(this.file, (fm) => {
        fm["持仓份额"] = position.shares;
        fm["持仓成本价"] = position.costPrice;
        fm["持仓总成本"] = position.totalCost;
        fm["持有金额"] = position.amount;
        fm["持有收益"] = position.profit;
        fm["持有收益率"] = position.profitRate;
        normalizeFundProperties(fm);
      });
      this.close();
      new Notice("持仓已校准");
    } finally {
      this.saving = false;
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class AddFundModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.saving = false;
    this.lookupRequest = 0;
    this.form = {
      code: "",
      resolvedCode: "",
      resolvedName: "",
      shares: "",
      holdingAmount: "",
      holdingProfit: "",
      group: "未分类",
      dcaEnabled: false,
      amount: 100,
      frequency: "daily",
      weekday: 1,
      monthday: 1,
      feeRate: 0,
      startDate: new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }),
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "添加基金" });

    new Setting(contentEl).setName("基金代码").addText((text) => {
      text.inputEl.inputMode = "numeric";
      text.inputEl.maxLength = 6;
      text.setPlaceholder("6位基金代码")
        .onChange((value) => {
          this.form.code = value.replace(/\D/g, "").slice(0, 6);
          this.lookupFundName();
        });
      window.setTimeout(() => text.inputEl.focus(), 0);
    });
    new Setting(contentEl).setName("基金名称").addText((text) => {
      this.nameText = text;
      text.setDisabled(true);
    });
    new Setting(contentEl).setName("持仓份额").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "0.01";
      text.inputEl.step = "0.01";
      text.setPlaceholder("0.00")
        .onChange((value) => { this.form.shares = value; });
    });
    new Setting(contentEl).setName("持有金额").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "0.01";
      text.inputEl.step = "0.01";
      text.setPlaceholder("0.00")
        .onChange((value) => { this.form.holdingAmount = value; });
    });
    new Setting(contentEl).setName("持有收益").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.step = "0.01";
      text.setPlaceholder("亏损请输入负数")
        .onChange((value) => { this.form.holdingProfit = value; });
    });
    new Setting(contentEl).setName("分组").addDropdown((dropdown) => dropdown
      .addOptions(Object.fromEntries(this.plugin.getFundGroupNames().map((group) => [group, group])))
      .setValue(this.form.group)
      .onChange((value) => { this.form.group = value; }));
    let dcaContainer;
    const syncDcaVisibility = () => {
      if (dcaContainer) dcaContainer.style.display = this.form.dcaEnabled ? "" : "none";
    };
    new Setting(contentEl).setName("是否定投")
      .addToggle((toggle) => toggle.setValue(this.form.dcaEnabled)
        .onChange((value) => { this.form.dcaEnabled = value; syncDcaVisibility(); }));

    dcaContainer = contentEl.createDiv({ cls: "fund-add-dca-fields" });
    new Setting(dcaContainer).setName("每期金额").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "0.01";
      text.inputEl.step = "0.01";
      text.setValue(String(this.form.amount)).onChange((value) => { this.form.amount = Number(value); });
    });
    new Setting(dcaContainer).setName("定投频率").addDropdown((dropdown) => dropdown
      .addOptions({ daily: "日", weekly: "周", monthly: "月" })
      .setValue(this.form.frequency)
      .onChange((value) => { this.form.frequency = value; syncScheduleVisibility(); }));
    const weeklySetting = new Setting(dcaContainer).setName("每周执行日").addDropdown((dropdown) => dropdown
      .addOptions(Object.fromEntries(Object.entries(WEEKDAYS).map(([key, value]) => [key, value])))
      .setValue(String(this.form.weekday))
      .onChange((value) => { this.form.weekday = Number(value); }));
    const monthlySetting = new Setting(dcaContainer).setName("每月执行日").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "1";
      text.inputEl.max = "28";
      text.setValue(String(this.form.monthday)).onChange((value) => { this.form.monthday = Number(value); });
    });
    new Setting(dcaContainer).setName("手续费率").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "0";
      text.inputEl.max = "10";
      text.inputEl.step = "0.01";
      text.setValue(String(this.form.feeRate)).onChange((value) => { this.form.feeRate = Number(value); });
    });
    const syncScheduleVisibility = () => {
      weeklySetting.settingEl.style.display = this.form.frequency === "weekly" ? "" : "none";
      monthlySetting.settingEl.style.display = this.form.frequency === "monthly" ? "" : "none";
    };
    syncScheduleVisibility();
    syncDcaVisibility();
    new Setting(contentEl).addButton((button) => button.setCta().setButtonText("添加基金").onClick(() => this.save()));
  }

  async lookupFundName() {
    const requestId = ++this.lookupRequest;
    const code = this.form.code;
    this.form.resolvedCode = "";
    this.form.resolvedName = "";
    this.nameText?.setValue(code.length === 6 ? "正在获取…" : "");
    if (code.length !== 6) return;
    try {
      const name = await this.plugin.fundName(code);
      if (requestId !== this.lookupRequest || code !== this.form.code) return;
      this.form.resolvedCode = code;
      this.form.resolvedName = name;
      this.nameText?.setValue(name);
    } catch {
      if (requestId !== this.lookupRequest || code !== this.form.code) return;
      this.nameText?.setValue("无法识别");
    }
  }

  async save() {
    if (this.saving) return;
    const schedule = this.form.frequency === "weekly" ? this.form.weekday : this.form.frequency === "monthly" ? this.form.monthday : 0;
    const validDca = !this.form.dcaEnabled || (
      positiveNumber(this.form.amount)
      && Number(this.form.feeRate) >= 0 && Number(this.form.feeRate) <= 10
      && (this.form.frequency === "daily" || (this.form.frequency === "weekly" && schedule >= 1 && schedule <= 5)
        || (this.form.frequency === "monthly" && schedule >= 1 && schedule <= 28))
    );
    const valid = /^\d{6}$/.test(this.form.code)
      && Boolean(positionFromSnapshot(this.form.shares, this.form.holdingAmount, this.form.holdingProfit))
      && validDca;
    if (!valid) {
      new Notice("请检查基金代码、持仓信息和定投设置");
      return;
    }

    this.saving = true;
    try {
      const file = await this.plugin.createFund(this.form);
      this.close();
      new Notice(`已添加 ${file.basename}，正在获取最新净值…`);
      await this.plugin.refreshAll(false);
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      new Notice(error?.message || String(error));
    } finally {
      this.saving = false;
    }
  }
}

class GridStrategyModal extends Modal {
  constructor(app, plugin, fundFile = null) {
    super(app);
    this.plugin = plugin;
    this.fundFile = fundFile;
    this.saving = false;
    this.lookingUp = false;
    this.lookupTimer = null;
    this.funds = plugin.getFundRecords().sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
    const frontmatter = fundFile ? app.metadataCache.getFileCache(fundFile)?.frontmatter || {} : {};
    const code = fundFile ? String(frontmatter["基金编号"] || "").trim() : this.funds[0]?.code || "";
    this.form = this.formForFund(code, Boolean(fundFile));
    this.originalReferenceCode = this.form.referenceCode;
  }

  formForFund(code, preserveEnabled = false) {
    const fund = this.funds.find((item) => item.code === code);
    const frontmatter = fund ? this.app.metadataCache.getFileCache(fund.file)?.frontmatter || {} : {};
    return {
      code,
      enabled: preserveEnabled ? frontmatter["网格启用"] === true : true,
      referenceCode: String(frontmatter["网格参考代码"] || "").trim(),
      referenceName: String(frontmatter["网格参考名称"] || "").trim(),
      currentPrice: positiveNumber(frontmatter["网格当前价格"]) ? Number(frontmatter["网格当前价格"]) : "",
      marketDate: String(frontmatter["网格行情日期"] || ""),
      marketTime: String(frontmatter["网格行情时间"] || ""),
      executionAxis: positiveNumber(frontmatter["网格执行中轴"]) ? Number(frontmatter["网格执行中轴"]) : "",
      axisDate: String(frontmatter["网格中轴日期"] || ""),
      suggestedAxis: positiveNumber(frontmatter["网格建议中轴"]) ? Number(frontmatter["网格建议中轴"]) : "",
      axisStatus: String(frontmatter["网格中轴状态"] || ""),
      spacing: positiveNumber(frontmatter["网格间距"]) ? Number(frontmatter["网格间距"]) : 3,
      suggestedSpacing: positiveNumber(frontmatter["网格建议间距"]) ? Number(frontmatter["网格建议间距"]) : "",
      executedLevels: normalizeGridExecutedLevels(frontmatter["网格已执行"]),
      applySuggested: false,
    };
  }

  syncMarketFields() {
    this.executionAxisText?.setValue(this.form.executionAxis ? String(this.form.executionAxis) : "");
    this.suggestedAxisText?.setValue(this.form.suggestedAxis ? String(this.form.suggestedAxis) : "");
    this.suggestedSpacingText?.setValue(this.form.suggestedSpacing ? String(this.form.suggestedSpacing) : "");
    const marketLabel = this.form.marketDate
      ? `行情 ${this.form.marketDate}${this.form.marketTime ? ` ${this.form.marketTime}` : ""}`
      : "输入6位场内ETF代码后自动识别";
    this.referenceSetting?.setDesc(marketLabel);
    this.applyAxisButton?.setDisabled(gridAxisAdoptionMode(
      this.form.executionAxis,
      this.form.suggestedAxis,
      this.form.axisStatus,
    ) === "disabled");
    this.applySpacingButton?.setDisabled(!gridSpacingAdoptionEnabled(this.form.spacing, this.form.suggestedSpacing));
  }

  scheduleReferenceLookup() {
    if (this.lookupTimer !== null) window.clearTimeout(this.lookupTimer);
    if (!/^\d{6}$/.test(this.form.referenceCode)) return;
    this.lookupTimer = window.setTimeout(() => {
      this.lookupTimer = null;
      this.lookupReference(false);
    }, 450);
  }

  async lookupReference(showFailureNotice = true) {
    if (this.lookingUp) return;
    const code = String(this.form.referenceCode || "").trim();
    if (!/^\d{6}$/.test(code)) {
      if (showFailureNotice) new Notice("请输入6位参考ETF代码");
      return;
    }
    this.lookingUp = true;
    this.referenceSetting?.setDesc("正在获取ETF行情并计算中轴与间距…");
    try {
      const market = await this.plugin.gridMarketData(code);
      if (code !== this.form.referenceCode) return;
      const referenceChanged = code !== this.originalReferenceCode;
      this.form.referenceName = market.name;
      this.form.currentPrice = market.currentPrice;
      this.form.marketDate = market.marketDate;
      this.form.marketTime = market.marketTime;
      this.form.suggestedAxis = market.suggestedAxis;
      this.form.suggestedSpacing = market.suggestedSpacing;
      if (referenceChanged || !positiveNumber(this.form.executionAxis)) {
        this.form.executionAxis = market.suggestedAxis;
        this.form.axisDate = market.marketDate;
      }
      this.form.axisStatus = evaluateGridAxisReview({
        rows: market.rows,
        executionAxis: this.form.executionAxis,
        suggestedAxis: market.suggestedAxis,
        spacingPercent: this.form.spacing,
        axisStartDate: this.form.axisDate,
        currentPrice: market.currentPrice,
        executedLevels: referenceChanged ? [] : this.form.executedLevels,
      }).status;
      this.form.applySuggested = false;
      this.syncMarketFields();
    } catch (error) {
      this.referenceSetting?.setDesc("没有获取到有效的场内ETF行情");
      if (showFailureNotice) new Notice(error?.message || String(error));
    } finally {
      this.lookingUp = false;
    }
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("fund-grid-modal");
    contentEl.empty();
    contentEl.createEl("h2", { text: this.fundFile ? "网格设置" : "添加网格策略" });
    if (!this.funds.length) {
      contentEl.createEl("p", { text: "请先在投资总览中添加基金。" });
      new Setting(contentEl).addButton((button) => button.setButtonText("关闭").onClick(() => this.close()));
      return;
    }

    new Setting(contentEl).setName("基金").addDropdown((dropdown) => dropdown
      .addOptions(Object.fromEntries(this.funds.map((fund) => [fund.code, `${fund.name} · ${fund.code}`])))
      .setValue(this.form.code)
      .setDisabled(Boolean(this.fundFile))
      .onChange((value) => {
        this.form = this.formForFund(value, false);
        this.originalReferenceCode = this.form.referenceCode;
        this.enableToggle?.setValue(this.form.enabled);
        this.referenceCodeText?.setValue(this.form.referenceCode);
        this.spacingText?.setValue(String(this.form.spacing));
        this.suggestedSpacingText?.setValue(this.form.suggestedSpacing ? String(this.form.suggestedSpacing) : "");
        this.syncMarketFields();
      }));
    new Setting(contentEl).setName("启用策略")
      .addToggle((toggle) => {
        this.enableToggle = toggle;
        toggle.setValue(this.form.enabled).onChange((value) => { this.form.enabled = value; });
      });
    this.referenceSetting = new Setting(contentEl)
      .setName("参考ETF代码")
      .setDesc(this.form.marketDate ? `行情 ${this.form.marketDate}${this.form.marketTime ? ` ${this.form.marketTime}` : ""}` : "输入6位场内ETF代码后自动识别")
      .addText((text) => {
        this.referenceCodeText = text;
        text.inputEl.inputMode = "numeric";
        text.setPlaceholder("例如 510310").setValue(this.form.referenceCode)
          .onChange((value) => {
            this.form.referenceCode = value.trim();
            this.form.referenceName = "";
            this.form.currentPrice = "";
            this.form.marketDate = "";
            this.form.marketTime = "";
            this.form.suggestedAxis = "";
            this.form.suggestedSpacing = "";
            this.form.axisStatus = "";
            this.form.applySuggested = false;
            this.syncMarketFields();
            this.scheduleReferenceLookup();
          });
      })
      .addExtraButton((button) => button
        .setIcon("refresh-cw")
        .setTooltip("重新识别并计算中轴与间距")
        .onClick(() => this.lookupReference(true)));
    new Setting(contentEl).setName("执行中轴").setDesc("策略实际使用的固定中轴")
      .addText((text) => {
        this.executionAxisText = text;
        text.setDisabled(true).setValue(this.form.executionAxis ? String(this.form.executionAxis) : "");
      });
    new Setting(contentEl).setName("建议中轴").setDesc(`最近${GRID_LOOKBACK_DAYS}个交易日去极值均价`)
      .addText((text) => {
        this.suggestedAxisText = text;
        text.setDisabled(true).setValue(this.form.suggestedAxis ? String(this.form.suggestedAxis) : "");
      })
      .addButton((button) => {
        this.applyAxisButton = button;
        button.setButtonText("采用")
          .setDisabled(gridAxisAdoptionMode(this.form.executionAxis, this.form.suggestedAxis, this.form.axisStatus) === "disabled")
          .onClick(() => this.requestSuggestedAxisAdoption());
      });
    new Setting(contentEl).setName("执行间距").setDesc("相对执行中轴的上下百分比")
      .addText((text) => {
        this.spacingText = text;
        text.inputEl.type = "number";
        text.inputEl.min = "0.01";
        text.inputEl.max = "19.99";
        text.inputEl.step = "0.01";
        text.setValue(String(this.form.spacing)).onChange((value) => {
          this.form.spacing = value;
          this.syncMarketFields();
        });
      });
    new Setting(contentEl).setName("建议间距").setDesc(`根据最近${GRID_LOOKBACK_DAYS}个交易日的典型一周波动计算`)
      .addText((text) => {
        this.suggestedSpacingText = text;
        text.setDisabled(true).setValue(this.form.suggestedSpacing ? String(this.form.suggestedSpacing) : "");
      })
      .addButton((button) => {
        this.applySpacingButton = button;
        button.setButtonText("采用")
          .setDisabled(!gridSpacingAdoptionEnabled(this.form.spacing, this.form.suggestedSpacing))
          .onClick(() => this.requestSuggestedSpacingAdoption());
      });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText("保存").onClick(() => this.save()));
  }

  async save() {
    if (this.saving) return;
    this.saving = true;
    try {
      await this.plugin.saveGridStrategy(this.fundFile, this.form);
      this.close();
      new Notice("网格策略已保存");
    } catch (error) {
      new Notice(error?.message || String(error));
    } finally {
      this.saving = false;
    }
  }

  applySuggestedAxis() {
    if (gridAxisAdoptionMode(this.form.executionAxis, this.form.suggestedAxis, this.form.axisStatus) === "disabled") return;
    this.form.executionAxis = this.form.suggestedAxis;
    this.form.axisDate = this.form.marketDate;
    this.form.axisStatus = "正常";
    this.form.applySuggested = true;
    this.form.executedLevels = [];
    this.syncMarketFields();
  }

  requestSuggestedAxisAdoption() {
    const mode = gridAxisAdoptionMode(this.form.executionAxis, this.form.suggestedAxis, this.form.axisStatus);
    if (mode === "disabled") return;
    if (mode === "direct") {
      this.applySuggestedAxis();
      return;
    }
    new GridAxisConfirmModal(this.app, {
      executionAxis: this.form.executionAxis,
      suggestedAxis: this.form.suggestedAxis,
      status: this.form.axisStatus || "正常",
      onConfirm: () => this.applySuggestedAxis(),
    }).open();
  }

  applySuggestedSpacing() {
    if (!gridSpacingAdoptionEnabled(this.form.spacing, this.form.suggestedSpacing)) return;
    this.form.spacing = this.form.suggestedSpacing;
    this.spacingText?.setValue(String(this.form.spacing));
    this.syncMarketFields();
    new Notice("已采用建议间距，保存后生效");
  }

  requestSuggestedSpacingAdoption() {
    if (!gridSpacingAdoptionEnabled(this.form.spacing, this.form.suggestedSpacing)) return;
    new GridSpacingConfirmModal(this.app, {
      spacing: this.form.spacing,
      suggestedSpacing: this.form.suggestedSpacing,
      onConfirm: () => this.applySuggestedSpacing(),
    }).open();
  }

  onClose() {
    if (this.lookupTimer !== null) window.clearTimeout(this.lookupTimer);
    this.contentEl.empty();
  }
}

class GridAxisConfirmModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("fund-grid-axis-confirm-modal");
    contentEl.empty();
    contentEl.createEl("h2", { text: "确认采用建议中轴" });
    const statusClass = this.options.status === "暂缓换轴"
      ? "paused"
      : this.options.status === "关注"
        ? "watch"
        : this.options.status === "正常"
          ? "normal"
          : "unavailable";
    const statusLine = contentEl.createDiv({ cls: "fund-grid-axis-confirm-status" });
    statusLine.createSpan({ text: "当前状态" });
    statusLine.createSpan({ cls: `fund-grid-axis-status is-${statusClass}`, text: this.options.status });
    const metrics = contentEl.createDiv({ cls: "fund-grid-axis-confirm-grid" });
    const addMetric = (label, value) => {
      const item = metrics.createDiv();
      item.createSpan({ text: label });
      item.createEl("b", { text: value });
    };
    addMetric("执行中轴", decimal(this.options.executionAxis));
    addMetric("建议中轴", decimal(this.options.suggestedAxis));
    const deviation = Math.abs(Number(this.options.suggestedAxis) / Number(this.options.executionAxis) - 1) * 100;
    addMetric("偏离幅度", `${decimal(deviation, 2)}%`);
    const note = this.options.status === "暂缓换轴"
      ? "当前处于暂缓换轴阶段，行情可能尚未企稳。采用后将清空本轮圆点状态、重置中轴日期，并重新开始30个交易日观察周期。"
      : "当前尚未达到正式换轴条件。采用后将清空本轮圆点状态、重置中轴日期，并重新开始30个交易日观察周期。";
    contentEl.createEl("p", {
      cls: "fund-grid-axis-confirm-note",
      text: note,
    });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText("确认采用").onClick(() => {
        this.options.onConfirm?.();
        this.close();
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GridSpacingConfirmModal extends Modal {
  constructor(app, options) {
    super(app);
    this.options = options;
  }

  onOpen() {
    const { contentEl } = this;
    this.modalEl.addClass("fund-grid-axis-confirm-modal");
    contentEl.empty();
    contentEl.createEl("h2", { text: "确认采用建议间距" });
    const metrics = contentEl.createDiv({ cls: "fund-grid-axis-confirm-grid" });
    const addMetric = (label, value) => {
      const item = metrics.createDiv();
      item.createSpan({ text: label });
      item.createEl("b", { text: value });
    };
    const suggested = Number(this.options.suggestedSpacing);
    addMetric("执行间距", `${decimal(this.options.spacing, 2)}%`);
    addMetric("建议间距", `${decimal(suggested, 2)}%`);
    addMetric("新换轴阈值", `${decimal(Math.max(10, suggested * 1.5), 2)}%`);
    contentEl.createEl("p", {
      cls: "fund-grid-axis-confirm-note",
      text: "采用后将清空本轮圆点状态，买卖档位和换轴判断阈值会按新间距重新计算；执行中轴和中轴日期保持不变。",
    });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText("确认采用").onClick(() => {
        this.options.onConfirm?.();
        this.close();
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class GridExecutionConfirmModal extends Modal {
  constructor(app, plugin, options) {
    super(app);
    this.plugin = plugin;
    this.options = options;
    this.saving = false;
  }

  onOpen() {
    const { contentEl } = this;
    const action = this.options.side === "buy" ? "买入" : "卖出";
    const recordingTrade = this.options.mode === "record-trade";
    const cancelingTrade = this.options.mode === "cancel-trade";
    const restoringTrade = this.options.mode === "restore-trade";
    const changingTrade = cancelingTrade || restoringTrade;
    const pointTrade = recordingTrade || changingTrade;
    const removing = cancelingTrade;
    const triggerLabel = pointTrade
      ? Number(this.options.tradePosition) === 0
        ? "中轴"
        : `${Number(this.options.tradePosition) < 0 ? "买" : "卖"}${Math.abs(Number(this.options.tradePosition))}格`
      : "--";
    this.modalEl.addClass("fund-grid-axis-confirm-modal");
    contentEl.empty();
    contentEl.createEl("h2", { text: restoringTrade ? `恢复${action}记录` : removing ? `取消${action}记录` : `确认记录${action}` });
    const metrics = contentEl.createDiv({ cls: "fund-grid-axis-confirm-grid" });
    const addMetric = (label, value) => {
      const item = metrics.createDiv();
      item.createSpan({ text: label });
      item.createEl("b", { text: value });
    };
    addMetric("操作", restoringTrade ? `恢复${action}` : removing ? `取消${action}` : action);
    addMetric("触发位置", triggerLabel);
    addMetric("参考收盘价", decimal(this.options.levelPrice));
    addMetric("行情日期", pointTrade ? this.options.tradeDate || "--" : this.options.fund.gridMarketDate || "--");
    contentEl.createEl("p", {
      cls: "fund-grid-axis-confirm-note",
      text: restoringTrade
        ? "恢复后该空心点将变回实心点；只有当前网格周期的记录会参与策略计算。"
        : cancelingTrade
        ? "取消后该实心点将保留为空心点，并退出策略计算；以后仍可点击恢复。"
        : "请仅在已经完成对应操作后记录。实心点会参与当前网格周期计算。",
    });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("取消").onClick(() => this.close()))
      .addButton((button) => button.setCta().setButtonText(restoringTrade ? "确认恢复" : removing ? "确认取消" : "确认记录").onClick(async () => {
        if (this.saving) return;
        this.saving = true;
        try {
          await this.plugin.toggleGridExecution(this.options);
          new Notice(restoringTrade ? "已恢复网格记录" : removing ? "已取消网格记录" : `已记录${action}`);
          this.close();
        } catch (error) {
          new Notice(error?.message || String(error));
          this.saving = false;
        }
      }));
  }

  onClose() {
    this.contentEl.empty();
  }
}

class DcaSettingsModal extends Modal {
  constructor(app, plugin, file) {
    super(app);
    this.plugin = plugin;
    this.file = file;
    const fm = app.metadataCache.getFileCache(file)?.frontmatter || {};
    this.initiallyEnabled = fm["定投启用"] === true;
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
    this.form = {
      enabled: this.initiallyEnabled,
      amount: Number(fm["定投金额"] || 100),
      frequency: FREQUENCY_VALUES[String(fm["定投频率"])] || "daily",
      weekday: WEEKDAY_VALUES[String(fm["定投日期"])] || 1,
      monthday: Number(fm["定投日期"] || 1),
      feeRate: Number(fm["手续费率"] || 0),
      startDate: String(fm["定投开始日期"] || today),
      today,
    };
  }

  onOpen() {
    this.render();
  }

  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `${this.file.basename} · 定投设置` });

    new Setting(contentEl).setName("启用定投推算")
      .addToggle((toggle) => toggle.setValue(this.form.enabled).onChange((value) => { this.form.enabled = value; }));
    new Setting(contentEl).setName("每期金额").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "0.01";
      text.inputEl.step = "0.01";
      text.setValue(String(this.form.amount)).onChange((value) => { this.form.amount = Number(value); });
    });
    new Setting(contentEl).setName("手续费率").addText((text) => {
      text.inputEl.type = "number";
      text.inputEl.min = "0";
      text.inputEl.max = "10";
      text.inputEl.step = "0.01";
      text.setValue(String(this.form.feeRate)).onChange((value) => { this.form.feeRate = Number(value); });
    });
    new Setting(contentEl).setName("定投频率").addDropdown((dropdown) => dropdown
      .addOptions({ daily: "日", weekly: "周", monthly: "月" })
      .setValue(this.form.frequency)
      .onChange((value) => { this.form.frequency = value; this.render(); }));

    if (this.form.frequency === "weekly") {
      new Setting(contentEl).setName("每周执行日").addDropdown((dropdown) => dropdown
        .addOptions(Object.fromEntries(Object.entries(WEEKDAYS).map(([key, value]) => [key, value])))
        .setValue(String(this.form.weekday))
        .onChange((value) => { this.form.weekday = Number(value); }));
    } else if (this.form.frequency === "monthly") {
      new Setting(contentEl).setName("每月执行日")
        .addText((text) => {
          text.inputEl.type = "number";
          text.inputEl.min = "1";
          text.inputEl.max = "28";
          text.setValue(String(this.form.monthday)).onChange((value) => { this.form.monthday = Number(value); });
        });
    }
    new Setting(contentEl).addButton((button) => button.setCta().setButtonText("保存并刷新").onClick(() => this.save()));
  }

  async save() {
    const schedule = this.form.frequency === "weekly" ? this.form.weekday : this.form.frequency === "monthly" ? this.form.monthday : 0;
    const startDate = effectiveDcaStartDate(this.initiallyEnabled, this.form.enabled, this.form.startDate, this.form.today);
    const valid = validDcaSettings(
      this.form.enabled,
      this.form.amount,
      this.form.feeRate,
      startDate,
      this.form.frequency,
      schedule,
    );
    if (!valid) {
      new Notice("请检查定投金额、费率和频率");
      return;
    }
    await this.app.fileManager.processFrontMatter(this.file, (fm) => {
      fm["定投启用"] = this.form.enabled;
      if (this.form.enabled) {
        fm["定投金额"] = round(this.form.amount, 2);
        fm["定投频率"] = FREQUENCIES[this.form.frequency];
        fm["定投日期"] = this.form.frequency === "weekly" ? WEEKDAYS[schedule] : this.form.frequency === "monthly" ? schedule : "每个交易日";
        fm["手续费率"] = round(this.form.feeRate, 4);
        fm["定投开始日期"] = startDate;
      }
      normalizeFundProperties(fm);
    });
    this.close();
    await this.plugin.refreshAll(true);
  }
}

class FundNavRefreshSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "基金助手" });
    containerEl.createEl("h3", { text: "投资空间" });
    const ready = this.plugin.isInvestmentWorkspaceReady();
    new Setting(containerEl)
      .setName(ready ? "投资空间已就绪" : "投资空间尚未完成")
      .setDesc(ready ? "投资总览、网格策略页面和基金持仓目录均可用。" : "一键补齐投资总览、网格策略页面和基金持仓目录，不会覆盖已有文件。")
      .addButton((button) => {
        button.setButtonText(ready ? "检查并修复" : "一键创建");
        if (!ready) button.setCta();
        button.onClick(async () => {
          button.setDisabled(true);
          await this.plugin.initializeInvestmentWorkspace(false);
          this.display();
        });
      });
    containerEl.createEl("h3", { text: "净值更新" });
    new Setting(containerEl).setName("首次打开投资页面时更新").setDesc("每次启动 Obsidian 后，首次打开投资总览、网格策略或基金页面时更新一次。")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.refreshOnStartup).onChange(async (value) => {
        this.plugin.settings.refreshOnStartup = value;
        await this.plugin.saveSettings();
        if (value) this.plugin.maybeRunSessionRefresh(this.app.workspace.getActiveFile());
      }));
  }
}

FundNavRefreshPlugin.testables = {
  createFundNoteContent,
  createGridOverviewNoteContent,
  createOverviewNoteContent,
  dailyHoldingProfit,
  decodeGridQuoteResponse,
  applyGridStrategyChanges,
  gridAxisAdoptionMode,
  gridSpacingAdoptionEnabled,
  dueNavPoints,
  effectiveDcaStartDate,
  fixedDecimal,
  fundPropertiesNeedNormalization,
  fundGroupName,
  normalizeFundProperties,
  gridExecutedLevelsFromTrades,
  normalizeGridExecutedLevels,
  normalizeGridTradeRecords,
  normalizeNavHistory,
  parseDate,
  parseFundName,
  positionFromSnapshot,
  positiveNumber,
  sanitizeFundName,
  validDcaSettings,
  validGroupName,
  totalHoldingCost,
};
module.exports = FundNavRefreshPlugin;
