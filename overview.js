const { FUND_GROUPS, groupColor } = require("./constants");
const { dailyHoldingProfit, totalHoldingCost } = require("./fund-math");

const numberOf = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const hasFiniteValue = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
const money = (value) => numberOf(value).toLocaleString("zh-CN", {
  style: "currency",
  currency: "CNY",
  maximumFractionDigits: 2,
});
const percent = (value) => `${numberOf(value).toFixed(2)}%`;
const signedMoney = (value) => `${numberOf(value) > 0 ? "+" : ""}${money(value)}`;
const signedPercent = (value) => `${numberOf(value) > 0 ? "+" : ""}${percent(value)}`;
const toneOf = (value) => numberOf(value) > 0 ? "positive" : numberOf(value) < 0 ? "negative" : "";
const GROUP_ORDER = new Map(FUND_GROUPS.map((group, index) => [group.name, index]));

function sortFunds(funds, key = "group") {
  const numericKey = {
    amount: "amount",
    profit: "profit",
    profitRate: "profitRate",
    dailyProfit: "dailyProfit",
  }[key];
  return funds.map((fund, index) => ({ fund, index })).sort((left, right) => {
    const a = left.fund;
    const b = right.fund;
    let difference = 0;
    if (key === "group") {
      const aRank = GROUP_ORDER.has(a.group) ? GROUP_ORDER.get(a.group) : FUND_GROUPS.length;
      const bRank = GROUP_ORDER.has(b.group) ? GROUP_ORDER.get(b.group) : FUND_GROUPS.length;
      difference = aRank - bRank || String(a.group).localeCompare(String(b.group), "zh-CN");
    } else if (numericKey === "dailyProfit") {
      if (a.dailyProfit === null && b.dailyProfit !== null) difference = 1;
      else if (a.dailyProfit !== null && b.dailyProfit === null) difference = -1;
      else difference = numberOf(b.dailyProfit) - numberOf(a.dailyProfit);
    } else {
      difference = numberOf(b[numericKey]) - numberOf(a[numericKey]);
    }
    if (difference) return difference;
    const amountDifference = numberOf(b.amount) - numberOf(a.amount);
    if (amountDifference) return amountDifference;
    return String(a.name).localeCompare(String(b.name), "zh-CN") || left.index - right.index;
  }).map(({ fund }) => fund);
}

function buildOverviewData(records, today, configuredGroups = null) {
  const funds = records.map((record) => {
    const amount = numberOf(record.amount);
    const cost = numberOf(record.cost);
    const profit = hasFiniteValue(record.profit) ? Number(record.profit) : amount - cost;
    return {
      ...record,
      amount,
      cost,
      profit,
      profitRate: hasFiniteValue(record.profitRate)
        ? Number(record.profitRate)
        : cost ? profit / cost * 100 : 0,
    };
  });
  const totalAmount = funds.reduce((sum, fund) => sum + numberOf(fund.amount), 0);
  const totalCost = funds.reduce((sum, fund) => sum + numberOf(fund.cost), 0);
  const totalProfit = funds.reduce((sum, fund) => sum + numberOf(fund.profit), 0);
  const latestDate = funds.map((fund) => fund.navDate || "").sort().at(-1) || "";
  const currentFunds = funds.filter((fund) => fund.navDate === latestDate && fund.dailyProfit !== null);
  const dailyProfit = currentFunds.reduce((sum, fund) => sum + numberOf(fund.dailyProfit), 0);

  const baseGroups = Array.isArray(configuredGroups) ? configuredGroups : FUND_GROUPS;
  const configuredNames = new Set(baseGroups.map((group) => group.name));
  const extraNames = [...new Set(funds.map((fund) => fund.group).filter((name) => !configuredNames.has(name)))];
  const groupDefinitions = [
    ...baseGroups,
    ...extraNames.map((name) => ({ name, color: groupColor(name), target: null })),
  ];
  const groups = groupDefinitions.map((definition) => {
    const items = funds.filter((fund) => fund.group === definition.name);
    const amount = items.reduce((sum, fund) => sum + numberOf(fund.amount), 0);
    const cost = items.reduce((sum, fund) => sum + numberOf(fund.cost), 0);
    const profit = items.reduce((sum, fund) => sum + numberOf(fund.profit), 0);
    const share = totalAmount ? amount / totalAmount * 100 : 0;
    return {
      ...definition,
      amount,
      cost,
      profit,
      profitRate: cost ? profit / cost * 100 : 0,
      share,
      deviation: definition.target === null ? null : share - definition.target,
      funds: items,
    };
  }).filter((group) => group.name === "未分类"
    ? group.funds.length > 0
    : group.funds.length > 0 || group.target !== null);

  return {
    funds: funds.sort((a, b) => numberOf(b.amount) - numberOf(a.amount)),
    groups,
    summary: {
      totalAmount,
      totalCost,
      totalProfit,
      totalProfitRate: totalCost ? totalProfit / totalCost * 100 : 0,
      dailyProfit,
      latestDate,
      updatedCount: currentFunds.length,
      totalCount: funds.length,
      dailyLabel: latestDate && latestDate === today ? "今日收益" : "昨日收益",
    },
  };
}

function createSvgElement(tag, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function ringPath(cx, cy, outerRadius, innerRadius, startAngle, endAngle) {
  const point = (radius, angle) => {
    const radians = (angle - 90) * Math.PI / 180;
    return [cx + radius * Math.cos(radians), cy + radius * Math.sin(radians)];
  };
  const span = Math.min(endAngle - startAngle, 359.999);
  const end = startAngle + span;
  const [outerStartX, outerStartY] = point(outerRadius, startAngle);
  const [outerEndX, outerEndY] = point(outerRadius, end);
  const [innerEndX, innerEndY] = point(innerRadius, end);
  const [innerStartX, innerStartY] = point(innerRadius, startAngle);
  const largeArc = span > 180 ? 1 : 0;
  return [
    `M ${outerStartX} ${outerStartY}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEndX} ${outerEndY}`,
    `L ${innerEndX} ${innerEndY}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStartX} ${innerStartY}`,
    "Z",
  ].join(" ");
}

function renderFundOverview(plugin, element, sourceFile) {
  const files = plugin.app.vault.getMarkdownFiles().filter((file) => plugin.isFundFile(file));
  const records = files.map((file) => {
    const frontmatter = plugin.app.metadataCache.getFileCache(file)?.frontmatter || {};
    const amount = numberOf(frontmatter["持有金额"]);
    const cost = numberOf(totalHoldingCost(frontmatter));
    return {
      file,
      name: file.basename,
      code: String(frontmatter["基金编号"] || "--"),
      group: plugin.getFundGroupName(file),
      amount,
      cost,
      profit: hasFiniteValue(frontmatter["持有收益"]) ? Number(frontmatter["持有收益"]) : amount - cost,
      profitRate: hasFiniteValue(frontmatter["持有收益率"])
        ? Number(frontmatter["持有收益率"])
        : cost ? (amount - cost) / cost * 100 : 0,
      dailyProfit: dailyHoldingProfit(frontmatter),
      change: hasFiniteValue(frontmatter["涨跌幅"]) ? Number(frontmatter["涨跌幅"]) : null,
      navDate: String(frontmatter["净值日期"] || ""),
      dcaEnabled: frontmatter["定投启用"] === true,
      gridEnabled: frontmatter["网格启用"] === true,
    };
  });
  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  const data = buildOverviewData(records, today, plugin.getGroupDefinitions());
  const sourceFm = plugin.app.metadataCache.getFileCache(sourceFile)?.frontmatter || {};

  const root = element.createDiv({ cls: "fund-overview" });
  const header = root.createDiv({ cls: "fund-overview-head" });
  const heading = header.createDiv();
  heading.createEl("h1", { text: "投资总览" });
  heading.createEl("span", { text: `更新于 ${sourceFm["更新日期"] || data.summary.latestDate || "尚未更新"}` });
  const actions = header.createDiv({ cls: "fund-overview-actions" });
  const addButton = actions.createEl("button", { text: "添加基金" });
  addButton.addEventListener("click", () => plugin.openAddFundModal());
  const refreshButton = actions.createEl("button", { cls: "mod-cta", text: "更新净值" });
  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    refreshButton.setText("正在更新…");
    try {
      await plugin.refreshAll(true);
    } finally {
      refreshButton.disabled = false;
      refreshButton.setText("更新净值");
    }
  });

  const hero = root.createDiv({ cls: "fund-dashboard-hero fund-overview-hero" });
  const amountBlock = hero.createDiv({ cls: "fund-dashboard-amount" });
  amountBlock.createSpan({ text: "持有金额" });
  amountBlock.createEl("strong", { text: money(data.summary.totalAmount) });
  const heroReturns = hero.createDiv({ cls: "fund-dashboard-returns" });
  const addSummaryReturn = (label, value, tone = "") => {
    const item = heroReturns.createDiv();
    item.createSpan({ text: label });
    item.createEl("b", { cls: tone, text: value });
  };
  addSummaryReturn(data.summary.dailyLabel, signedMoney(data.summary.dailyProfit), toneOf(data.summary.dailyProfit));
  addSummaryReturn("持有收益", signedMoney(data.summary.totalProfit), toneOf(data.summary.totalProfit));
  addSummaryReturn("持有收益率", signedPercent(data.summary.totalProfitRate), toneOf(data.summary.totalProfitRate));

  const allocationSection = root.createDiv({ cls: "fund-overview-section" });
  const allocationHead = allocationSection.createDiv({ cls: "fund-overview-section-head" });
  allocationHead.createEl("h2", { text: "资产配置" });
  const groupConfigButton = allocationHead.createEl("button", { text: "分组配置" });
  groupConfigButton.addEventListener("click", () => plugin.openGroupConfigurationModal());
  const allocation = allocationSection.createDiv({ cls: "fund-overview-allocation" });
  const chartWrap = allocation.createDiv({ cls: "fund-overview-chart" });
  const svg = createSvgElement("svg", { viewBox: "0 0 260 260", role: "img", "aria-label": "基金资产配置" });
  chartWrap.appendChild(svg);
  const visibleGroups = data.groups.filter((group) => group.amount > 0);
  let angle = 0;
  const centerName = createSvgElement("text", { x: 130, y: 118, "text-anchor": "middle", class: "fund-overview-chart-amount" });
  const centerValue = createSvgElement("text", { x: 130, y: 140, "text-anchor": "middle", class: "fund-overview-chart-label" });
  const centerShare = createSvgElement("text", { x: 130, y: 158, "text-anchor": "middle", class: "fund-overview-chart-share" });
  const setChartCenter = (group = null) => {
    centerName.textContent = group?.name || "全部资产";
    centerValue.textContent = money(group?.amount ?? data.summary.totalAmount);
    centerShare.textContent = percent(group?.share ?? (data.summary.totalAmount > 0 ? 100 : 0));
  };
  setChartCenter();
  for (const group of visibleGroups) {
    const span = data.summary.totalAmount ? group.amount / data.summary.totalAmount * 360 : 0;
    const gap = Math.min(0.6, span / 4);
    const path = createSvgElement("path", {
      class: "fund-overview-segment",
      d: ringPath(130, 130, 94, 62, angle + gap, angle + span - gap),
      fill: group.color,
      tabindex: "0",
      "aria-label": `${group.name}，${money(group.amount)}，占比 ${percent(group.share)}`,
    });
    path.addEventListener("mouseenter", () => setChartCenter(group));
    path.addEventListener("mouseleave", () => setChartCenter());
    path.addEventListener("focus", () => setChartCenter(group));
    path.addEventListener("blur", () => setChartCenter());
    svg.appendChild(path);
    angle += span;
  }
  svg.appendChild(centerName);
  svg.appendChild(centerValue);
  svg.appendChild(centerShare);

  const groupList = allocation.createDiv({ cls: "fund-overview-groups" });
  for (const group of data.groups) {
    const row = groupList.createDiv({ cls: "fund-overview-group" });
    row.style.setProperty("--group-color", group.color);
    const groupMain = row.createDiv({ cls: "fund-overview-group-main" });
    const name = groupMain.createDiv({ cls: "fund-overview-group-name" });
    name.createSpan({ cls: "fund-overview-dot" });
    name.createEl("strong", { text: group.name });
    groupMain.createEl("b", { text: money(group.amount) });
    const metrics = row.createDiv({ cls: "fund-overview-group-metrics" });
    const addMetric = (label, value, tone = "") => {
      const item = metrics.createDiv();
      item.createSpan({ text: label });
      item.createEl("b", { cls: tone, text: value });
    };
    addMetric("持有收益", signedMoney(group.profit), toneOf(group.profit));
    addMetric("当前占比", percent(group.share));
    addMetric("目标占比", group.target === null ? "--" : percent(group.target));
    addMetric("偏差", group.deviation === null ? "--" : signedPercent(group.deviation), toneOf(group.deviation));
  }

  const returnSection = root.createDiv({ cls: "fund-overview-section" });
  returnSection.createEl("h2", { text: "分组收益率" });
  const returnChart = returnSection.createDiv({ cls: "fund-overview-return-chart" });
  const returnGroups = data.groups.filter((group) => group.funds.length);
  const maxAbsoluteRate = Math.max(1, ...returnGroups.map((group) => Math.abs(numberOf(group.profitRate))));
  const axis = returnChart.createDiv({ cls: "fund-overview-return-axis" });
  axis.createSpan({ cls: "fund-overview-return-axis-spacer" });
  const axisScale = axis.createDiv({ cls: "fund-overview-return-axis-scale" });
  axisScale.createSpan({ text: `-${percent(maxAbsoluteRate)}` });
  axisScale.createSpan({ text: "0%" });
  axisScale.createSpan({ text: `+${percent(maxAbsoluteRate)}` });
  axis.createSpan({ cls: "fund-overview-return-axis-spacer" });
  for (const group of returnGroups) {
    const rate = numberOf(group.profitRate);
    const width = Math.abs(rate) / maxAbsoluteRate * 50;
    const row = returnChart.createDiv({ cls: "fund-overview-return-row" });
    const identity = row.createDiv({ cls: "fund-overview-return-name" });
    identity.style.setProperty("--group-color", group.color);
    identity.createSpan({ cls: "fund-overview-dot" });
    identity.createSpan({ text: group.name });
    const plot = row.createDiv({ cls: "fund-overview-return-plot" });
    if (rate !== 0) {
      const bar = plot.createDiv({ cls: `fund-overview-return-bar ${rate > 0 ? "positive-bar" : "negative-bar"}` });
      bar.style.width = `${width}%`;
    }
    row.createEl("b", { cls: toneOf(rate), text: signedPercent(rate) });
  }

  const fundSection = root.createDiv({ cls: "fund-overview-section" });
  const fundSectionHead = fundSection.createDiv({ cls: "fund-overview-section-head" });
  fundSectionHead.createEl("h2", { text: "基金明细" });
  const sortSelect = fundSectionHead.createEl("select", { attr: { "aria-label": "基金明细排序" } });
  const sortOptions = [
    ["group", "分组"],
    ["amount", "持有金额"],
    ["profit", "持有收益"],
    ["profitRate", "收益率"],
    ["dailyProfit", "昨日收益"],
  ];
  for (const [value, label] of sortOptions) {
    const option = sortSelect.createEl("option", { text: label });
    option.value = value;
  }
  sortSelect.value = "group";
  const fundList = fundSection.createDiv({ cls: "fund-overview-funds" });
  const renderFundList = (sortKey) => {
    fundList.empty();
    for (const fund of sortFunds(data.funds, sortKey)) {
      const row = fundList.createDiv({ cls: "fund-overview-fund" });
      const identity = row.createDiv({ cls: "fund-overview-fund-identity" });
      const nameButton = identity.createEl("button", { cls: "fund-overview-fund-link", text: fund.name });
      nameButton.addEventListener("click", () => plugin.app.workspace.getLeaf(false).openFile(fund.file));
      const meta = identity.createDiv({ cls: "fund-overview-fund-meta" });
      meta.createSpan({ text: fund.code });
      const tag = meta.createSpan({ cls: "fund-overview-fund-tag", text: fund.group });
      tag.style.setProperty("--group-color", plugin.getGroupDefinition(fund.group).color);
      if (fund.dcaEnabled) meta.createSpan({ cls: "fund-overview-dca-tag", text: "定投" });
      if (fund.gridEnabled) meta.createSpan({ cls: "fund-overview-grid-tag", text: "网格" });
      const metrics = row.createDiv({ cls: "fund-overview-fund-metrics" });
      const addFundMetric = (label, value, tone = "") => {
        const item = metrics.createDiv({ cls: "fund-overview-fund-metric" });
        item.createSpan({ text: label });
        item.createEl("b", { cls: tone, text: value });
      };
      addFundMetric("持有金额", money(fund.amount));
      addFundMetric("持有收益", signedMoney(fund.profit), toneOf(fund.profit));
      addFundMetric("收益率", signedPercent(fund.profitRate), toneOf(fund.profitRate));
      addFundMetric(
        fund.navDate === today ? "今日收益" : "昨日收益",
        fund.dailyProfit === null ? "--" : signedMoney(fund.dailyProfit),
        toneOf(fund.dailyProfit),
      );
      addFundMetric(
        "涨跌幅",
        fund.change === null ? "--" : signedPercent(fund.change),
        toneOf(fund.change),
      );
    }
  };
  sortSelect.addEventListener("change", () => renderFundList(sortSelect.value));
  renderFundList(sortSelect.value);
}

module.exports = { buildOverviewData, renderFundOverview, sortFunds };
