const assert = require("node:assert/strict");
const Module = require("node:module");
const originalModuleLoad = Module._load;
Module._load = function loadTestDependency(request, parent, isMain) {
  if (request === "obsidian") return require("./test-stubs/obsidian");
  return originalModuleLoad.call(this, request, parent, isMain);
};
const Plugin = require("./main.js");
Module._load = originalModuleLoad;
const { buildOverviewData, sortFunds } = require("./overview");
const { groupColor } = require("./constants");
const {
  GRID_VISIBLE_LEVELS,
  buildGridChartModel,
  buildGridTriggerPoints,
  calculateGridBand,
  calculateSuggestedAxis,
  calculateSuggestedSpacing,
  evaluateGridAxisReview,
  gridCycleId,
  gridDateTickIndexes,
  gridDecimalPlaces,
  gridFixedDecimal,
  gridLevelPrice,
  gridMarketIsProvisional,
  gridMarketSymbol,
  gridOfficialRows,
  gridPendingAction,
  gridPendingCloseAction,
  gridPositionLabel,
  gridQuoteIsOfficialClose,
  parseGridKlinePayload,
  parseGridQuoteText,
} = require("./grid");
const {
  createFundNoteContent,
  createGridOverviewNoteContent,
  createOverviewNoteContent,
  dailyHoldingProfit,
  decodeGridQuoteResponse,
  applyGridStrategyChanges,
  dueNavPoints,
  effectiveDcaStartDate,
  fixedDecimal,
  fundPropertiesNeedNormalization,
  gridAxisAdoptionMode,
  gridExecutedLevelsFromTrades,
  gridSpacingAdoptionEnabled,
  normalizeFundProperties,
  normalizeGridExecutedLevels,
  normalizeGridTradeRecords,
  normalizeNavHistory,
  parseDate,
  parseFundName,
  positionFromSnapshot,
  positiveNumber,
  sanitizeFundName,
  totalHoldingCost,
  validDcaSettings,
  validGroupName,
} = Plugin.testables;

assert.equal(fixedDecimal(1.233, 4), "1.2330");
assert.equal(fixedDecimal(1.2334, 4), "1.2334");

assert.equal(gridAxisAdoptionMode(1.2, 1.2, "正常"), "disabled");
assert.equal(gridAxisAdoptionMode(0, 1.2, "正常"), "disabled");
assert.equal(gridAxisAdoptionMode(1.2, 1.21, "建议换轴"), "direct");
assert.equal(gridAxisAdoptionMode(1.2, 1.21, "正常"), "confirm");
assert.equal(gridAxisAdoptionMode(1.2, 1.21, "关注"), "confirm");
assert.equal(gridAxisAdoptionMode(1.2, 1.21, "暂缓换轴"), "confirm");
assert.equal(gridSpacingAdoptionEnabled(3, 5), true);
assert.equal(gridSpacingAdoptionEnabled(3, 3), false);
assert.equal(gridSpacingAdoptionEnabled(3.5, 3), false);
assert.equal(gridSpacingAdoptionEnabled(0, 3), false);
assert.equal(Plugin.prototype.hasChanges.call({}, {}, { 网格已执行: [] }), false);
assert.equal(Plugin.prototype.hasChanges.call({}, { 网格已执行: ["buy-1"] }, { 网格已执行: ["buy-1"] }), false);
assert.equal(Plugin.prototype.hasChanges.call({}, { 网格已执行: ["buy-1"] }, { 网格已执行: ["buy-2"] }), true);
assert.equal(GRID_VISIBLE_LEVELS, 5);
assert.equal(gridLevelPrice(100, 5, "buy", 3), 85);
assert.ok(Math.abs(gridLevelPrice(100, 5, "sell", 3) - 115) < 1e-12);
assert.throws(() => gridLevelPrice(100, 20, "buy", 1), /小于 20%/);
assert.throws(() => gridLevelPrice(100, 5, "buy", 6), /1到5/);
assert.equal(gridCycleId("518880", "2026-08-26", 100, 5), "518880@2026-08-26@100@5");
assert.equal(gridCycleId("510310", "2026-08-26", 4.592000, 3.0000), "510310@2026-08-26@4.592@3");
assert.equal(gridCycleId("", "2026-08-26", 100, 5), "");
assert.equal(gridDecimalPlaces(1.82, 4), 2);
assert.equal(gridDecimalPlaces(1.8, 4), 1);
assert.equal(gridDecimalPlaces(3, 2), 0);
assert.equal(gridFixedDecimal(1.8, 2), "1.80");
assert.deepEqual(gridDateTickIndexes(40), [0, 10, 20, 29, 39]);
assert.deepEqual(gridDateTickIndexes(3), [0, 1, 2]);
assert.deepEqual(gridDateTickIndexes(1), [0]);
assert.deepEqual(gridDateTickIndexes(0), []);
assert.notEqual(
  gridCycleId("518880", "2026-08-26", 100, 5),
  gridCycleId("510310", "2026-08-26", 100, 5),
);
assert.equal(gridQuoteIsOfficialClose("14:59"), false);
assert.equal(gridQuoteIsOfficialClose("15:00"), true);
const rawCloseRows = [
  { date: "2026-08-26", close: 100 },
  { date: "2026-08-27", close: 101 },
];
const provisionalRows = gridOfficialRows(rawCloseRows, {
  date: "2026-08-27", current: 102, time: "14:30",
});
assert.deepEqual(provisionalRows, [{ date: "2026-08-26", close: 100 }]);
assert.equal(gridMarketIsProvisional(provisionalRows, "2026-08-27", "14:30"), true);
const officialRows = gridOfficialRows(rawCloseRows, {
  date: "2026-08-27", current: 102, time: "15:00",
});
assert.deepEqual(officialRows, [
  { date: "2026-08-26", close: 100 },
  { date: "2026-08-27", close: 102 },
]);
assert.equal(gridMarketIsProvisional(officialRows, "2026-08-27", "15:00"), false);
assert.equal(gridMarketIsProvisional(officialRows, "2026-08-27", ""), false);
const chartModel = buildGridChartModel([
  { date: "2026-08-25", close: 98 },
  { date: "2026-08-26", close: 99 },
], 100, 5, 101, "2026-08-27");
assert.equal(chartModel.levels.length, 11);
assert.equal(chartModel.levels.find((level) => level.position === 0).price, 100);
assert.equal(chartModel.levels.find((level) => level.position === -5).price, 75);
assert.equal(chartModel.points.at(-1).close, 101);
assert.equal(chartModel.points.at(-1).date, "2026-08-27");
assert.equal(buildGridChartModel([], 0, 5, 100, "2026-08-27"), null);
const triggerPoints = buildGridTriggerPoints([
  { date: "2026-08-25", close: 100 },
  { date: "2026-08-26", close: 89 },
  { date: "2026-08-27", close: 88 },
  { date: "2026-08-28", close: 106 },
], 100, 5);
assert.deepEqual(triggerPoints.filter((point) => point.date === "2026-08-26"), [
  { date: "2026-08-26", side: "buy", position: -1, price: 89, levelPrice: 95 },
  { date: "2026-08-26", side: "buy", position: -2, price: 89, levelPrice: 90 },
]);
assert.equal(triggerPoints.some((point) => point.date === "2026-08-27"), false);
assert.deepEqual(triggerPoints.filter((point) => point.date === "2026-08-28"), [
  { date: "2026-08-28", side: "sell", position: -1, price: 106, levelPrice: 95 },
  { date: "2026-08-28", side: "sell", position: 0, price: 106, levelPrice: 100 },
  { date: "2026-08-28", side: "sell", position: 1, price: 106, levelPrice: 105 },
]);
assert.deepEqual(buildGridTriggerPoints([
  { date: "2026-08-24", close: 100 },
  { date: "2026-08-25", close: 106 },
  { date: "2026-08-26", close: 104 },
  { date: "2026-08-27", close: 106 },
], 100, 5), [
  { date: "2026-08-25", side: "sell", position: 1, price: 106, levelPrice: 105 },
]);
assert.deepEqual(calculateGridBand(100, 5, 100), {
  rawPosition: 0,
  percent: 50,
  range: "inside",
  reachedBuy: 0,
  reachedSell: 0,
});
const thirdBuyBand = calculateGridBand(100, 5, 85);
assert.equal(thirdBuyBand.rawPosition, -3);
assert.equal(thirdBuyBand.percent, 20);
assert.equal(thirdBuyBand.reachedBuy, 3);
const overflowSellBand = calculateGridBand(100, 5, 135);
assert.equal(overflowSellBand.range, "above");
assert.equal(overflowSellBand.percent, 100);
assert.equal(overflowSellBand.reachedSell, 5);
assert.match(gridPositionLabel(overflowSellBand), /已超出网格范围/);
assert.match(gridPositionLabel(thirdBuyBand), /买入第3格/);
assert.deepEqual(gridPendingAction(thirdBuyBand, ["buy-1"], "2026-08-27", "2026-08-27"), {
  side: "buy",
  levels: [2, 3],
  label: "今日买入",
  detail: "第2至第3格待确认",
});
assert.equal(gridPendingAction(thirdBuyBand, ["buy-1", "buy-2", "buy-3"], "2026-08-27", "2026-08-27"), null);
assert.equal(gridPendingAction(calculateGridBand(100, 5, 115), [], "2026-08-26", "2026-08-27").label, "待确认卖出");
assert.equal(calculateGridBand(100, 20, 100), null);
assert.deepEqual(
  normalizeGridExecutedLevels(["sell-2", "buy-3", "buy-1", "buy-3", "hold-1", "sell-6"]),
  ["buy-1", "buy-3", "sell-2"],
);
assert.deepEqual(normalizeGridExecutedLevels("buy-1"), []);
assert.deepEqual(normalizeGridTradeRecords([
  "2026-08-27 · 买入 · 买1 · 4.5 · 周期 510310@2026-08-26@4.6@3",
  "2026-08-27 · 卖出 · 中轴 · 4.6 · 周期 510310@2026-08-26@4.6@3",
  "2026-08-27 · 买入 · 买2 · 4.4 · 周期 510310@2026-08-26@4.6@3 · 已取消",
  "bad-record",
]), [
  { raw: "2026-08-27 · 买入 · 买1 · 4.5 · 周期 510310@2026-08-26@4.6@3", date: "2026-08-27", side: "buy", position: -1, price: 4.5, cycleId: "510310@2026-08-26@4.6@3", canceled: false },
  { raw: "2026-08-27 · 卖出 · 中轴 · 4.6 · 周期 510310@2026-08-26@4.6@3", date: "2026-08-27", side: "sell", position: 0, price: 4.6, cycleId: "510310@2026-08-26@4.6@3", canceled: false },
  { raw: "2026-08-27 · 买入 · 买2 · 4.4 · 周期 510310@2026-08-26@4.6@3 · 已取消", date: "2026-08-27", side: "buy", position: -2, price: 4.4, cycleId: "510310@2026-08-26@4.6@3", canceled: true },
]);
const cycleA = "518880@2026-08-26@100@5";
const cycleB = "518880@2026-08-27@101@5";
assert.deepEqual(gridExecutedLevelsFromTrades([
  `2026-08-27 · 买入 · 买1 · 95 · 周期 ${cycleA}`,
  `2026-08-27 · 买入 · 买2 · 90 · 周期 ${cycleA}`,
  `2026-08-28 · 卖出 · 买1 · 95 · 周期 ${cycleA}`,
], cycleA), ["buy-1"]);
assert.deepEqual(gridExecutedLevelsFromTrades([
  `2026-08-27 · 卖出 · 卖1 · 105 · 周期 ${cycleA}`,
  `2026-08-28 · 买入 · 中轴 · 100 · 周期 ${cycleA}`,
], cycleA), []);
assert.deepEqual(gridExecutedLevelsFromTrades([
  `2026-08-27 · 买入 · 买1 · 95 · 周期 ${cycleA} · 已取消`,
], cycleA), []);
assert.deepEqual(gridExecutedLevelsFromTrades([
  `2026-08-27 · 买入 · 买1 · 95 · 周期 ${cycleA}`,
  `2026-08-28 · 卖出 · 卖1 · 106.05 · 周期 ${cycleB}`,
], cycleA), ["buy-1"]);
assert.deepEqual(gridPendingCloseAction(calculateGridBand(100, 5, 100), ["buy-1"], "2026-08-27", "2026-08-27"), {
  mode: "close",
  side: "sell",
  openSide: "buy",
  openLevel: 1,
  triggerSide: "axis",
  triggerLevel: 0,
  isAxis: true,
  label: "今日卖出",
  detail: "中轴待确认",
});
assert.equal(gridPendingCloseAction(calculateGridBand(100, 5, 99), ["buy-1"]), null);
assert.equal(gridPendingCloseAction(calculateGridBand(100, 5, 90), ["buy-3"]).triggerLevel, 2);
assert.equal(gridPendingCloseAction(calculateGridBand(100, 5, 100), ["sell-1"]).side, "buy");
const clearedGridState = { 网格已执行: ["buy-1"] };
applyGridStrategyChanges(clearedGridState, { 网格已执行: [] });
assert.equal("网格已执行" in clearedGridState, false);

const unorderedProperties = {
  自定义备注: "保留",
  持有收益: 10,
  持有金额: 110,
  持有收益率: 10,
  持仓成本价: 1,
  持仓总成本: 100,
  基金编号: "000216",
  网格间距: 3,
  网格已执行: ["buy-1"],
  网格交易记录: ["2026-08-27 · 买入 · 买1 · 4.5"],
  每格金额: 100,
  网格启用: true,
  网格基准净值: 1.2,
  网格参考代码: "510310",
  网格执行中轴: 4.5,
  持仓基准日期: "2026-08-01",
  持仓份额: 100,
  cssclasses: ["fund-dashboard-note"],
};
assert.equal(fundPropertiesNeedNormalization(unorderedProperties), true);
normalizeFundProperties(unorderedProperties);
assert.deepEqual(Object.keys(unorderedProperties), [
  "基金编号",
  "持仓份额",
  "持有金额",
  "持有收益",
  "持仓成本价",
  "持仓总成本",
  "持有收益率",
  "网格启用",
  "网格参考代码",
  "网格执行中轴",
  "网格间距",
  "网格已执行",
  "网格交易记录",
  "cssclasses",
  "自定义备注",
]);
assert.equal(unorderedProperties["自定义备注"], "保留");
assert.equal("持仓基准日期" in unorderedProperties, false);
assert.equal("网格基准净值" in unorderedProperties, false);
assert.equal("每格金额" in unorderedProperties, false);
assert.equal(fundPropertiesNeedNormalization(unorderedProperties), false);

const overviewNote = createOverviewNoteContent();
assert.match(overviewNote, /cssclasses:\n  - fund-overview-note/);
assert.match(overviewNote, /```fund-overview\n```/);
assert.doesNotMatch(overviewNote, /fund-dashboard/);

const gridOverviewNote = createGridOverviewNoteContent();
assert.match(gridOverviewNote, /cssclasses:\n  - fund-grid-overview-note/);
assert.match(gridOverviewNote, /```fund-grid-overview\n```/);
assert.equal(gridMarketSymbol("510310"), "sh510310");
assert.equal(gridMarketSymbol("159919"), "sz159919");
assert.throws(() => gridMarketSymbol("51031"), /6位数字/);
const sampleKlines = Array.from({ length: 40 }, (_, index) => [
  `2026-07-${String(index + 1).padStart(2, "0")}`,
  "1",
  String(index + 1),
]);
const parsedKlines = parseGridKlinePayload({ data: { sh510310: { day: sampleKlines } } }, "sh510310");
assert.equal(parsedKlines.length, 40);
assert.equal(calculateSuggestedAxis(parsedKlines), 20.5);
const lowVolatilityRows = Array.from({ length: 40 }, (_, index) => ({
  date: `2026-08-${index + 1}`,
  close: 100 * Math.pow(1.01, index % 2),
}));
assert.equal(calculateSuggestedSpacing(lowVolatilityRows), 2);
const highVolatilityRows = Array.from({ length: 40 }, (_, index) => ({
  date: `2026-08-${index + 1}`,
  close: 100 * Math.pow(1.05, index % 2),
}));
assert.equal(calculateSuggestedSpacing(highVolatilityRows), 10);
assert.throws(() => calculateSuggestedSpacing(parsedKlines.slice(0, 39)), /至少需要40个交易日/);
assert.throws(() => parseGridKlinePayload({ data: {} }, "sh510310"), /不足40个交易日/);
const parsedQuote = parseGridQuoteText('v_sh510310="1~沪深300ETF易方达~510310~4.520~4.483~~20260826161450~";', "510310");
assert.deepEqual(parsedQuote, {
  name: "沪深300ETF易方达",
  code: "510310",
  current: 4.52,
  date: "2026-08-26",
  time: "16:14",
});
assert.throws(() => parseGridQuoteText('v_sh510310="1~沪深300ETF易方达~510310~4.520~~20260826161450~";', "518880"), /代码不匹配/);
const gb18030QuoteBytes = Uint8Array.from("76-5F-73-68-35-31-30-33-31-30-3D-22-31-7E-BB-A6-C9-EE-33-30-30-45-54-46-D2-D7-B7-BD-B4-EF-7E-35-31-30-33-31-30-7E-34-2E-35-32-30-7E-7E-32-30-32-36-30-38-32-36-31-36-31-34-35-30-7E-22-3B".split("-").map((value) => Number.parseInt(value, 16)));
const decodedQuote = decodeGridQuoteResponse({ arrayBuffer: gb18030QuoteBytes.buffer, text: "乱码响应" });
assert.match(decodedQuote, /沪深300ETF易方达/);
assert.equal(parseGridQuoteText(decodedQuote, "510310").name, "沪深300ETF易方达");
assert.throws(() => parseGridQuoteText('v_sh510310="1~���~510310~4.520~~20260826161450~";', "510310"), /有效的场内ETF行情/);
const risingRows = Array.from({ length: 50 }, (_, index) => ({
  date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}`,
  close: 120,
}));
const replaceReview = evaluateGridAxisReview({
  rows: risingRows,
  executionAxis: 100,
  suggestedAxis: 120,
  spacingPercent: 3,
  axisStartDate: risingRows[0].date,
  currentPrice: 120,
});
assert.equal(replaceReview.status, "建议换轴");
assert.equal(replaceReview.persistentDays, 7);
const chaseReview = evaluateGridAxisReview({
  rows: risingRows,
  executionAxis: 100,
  suggestedAxis: 120,
  spacingPercent: 3,
  axisStartDate: risingRows[0].date,
  currentPrice: 130,
});
assert.equal(chaseReview.status, "暂缓换轴");
const stableRows = Array.from({ length: 50 }, (_, index) => ({
  date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String(index % 28 + 1).padStart(2, "0")}`,
  close: index >= 47 ? 122.5 : 100,
}));
const insideFiveLevelBoundary = evaluateGridAxisReview({
  rows: stableRows,
  executionAxis: 100,
  suggestedAxis: 100,
  spacingPercent: 5,
  axisStartDate: stableRows[0].date,
  currentPrice: 122.5,
});
assert.equal(insideFiveLevelBoundary.status, "正常");
const outsideFiveLevelBoundary = evaluateGridAxisReview({
  rows: stableRows.map((row, index) => ({ ...row, close: index >= 47 ? 126 : row.close })),
  executionAxis: 100,
  suggestedAxis: 100,
  spacingPercent: 5,
  axisStartDate: stableRows[0].date,
  currentPrice: 126,
});
assert.equal(outsideFiveLevelBoundary.status, "关注");
const executionProgressReview = evaluateGridAxisReview({
  rows: stableRows.map((row) => ({ ...row, close: 100 })),
  executionAxis: 100,
  suggestedAxis: 100,
  spacingPercent: 5,
  axisStartDate: stableRows[0].date,
  currentPrice: 100,
  executedLevels: ["buy-1", "buy-2", "buy-3", "buy-4"],
});
assert.equal(executionProgressReview.status, "关注");
assert.equal(executionProgressReview.maxDoneRatio, 0.8);
const storedGridState = {
  网格参考代码: "510310",
  网格执行中轴: 100,
  网格中轴日期: risingRows[0].date,
  网格间距: 3,
  网格已执行: ["buy-1", "sell-1"],
};
const gridMarket = {
  code: "510310",
  name: "测试ETF",
  currentPrice: 120,
  marketDate: risingRows.at(-1).date,
  marketTime: "15:00",
  suggestedAxis: 120,
  suggestedSpacing: 4,
  rows: risingRows,
};
const unchangedCycle = Plugin.prototype.gridStrategyChanges.call({}, storedGridState, gridMarket, {
  spacing: 3,
  executionAxis: 100,
  axisDate: risingRows[0].date,
});
assert.deepEqual(unchangedCycle["网格已执行"], ["buy-1", "sell-1"]);
const foreignReferenceCycle = gridCycleId("588080", risingRows[0].date, 100, 3);
const isolatedReferenceState = Plugin.prototype.gridStrategyChanges.call({}, {
  ...storedGridState,
  网格交易记录: [`${risingRows[0].date} · 买入 · 买1 · 97 · 周期 ${foreignReferenceCycle}`],
}, gridMarket, {
  spacing: 3,
  executionAxis: 100,
  axisDate: risingRows[0].date,
});
assert.deepEqual(isolatedReferenceState["网格已执行"], []);
const changedSpacingCycle = Plugin.prototype.gridStrategyChanges.call({}, storedGridState, gridMarket, {
  spacing: 4,
  executionAxis: 100,
  axisDate: risingRows[0].date,
});
assert.deepEqual(changedSpacingCycle["网格已执行"], []);
const changedAxisCycle = Plugin.prototype.gridStrategyChanges.call({}, storedGridState, gridMarket, {
  spacing: 3,
  executionAxis: 120,
  axisDate: gridMarket.marketDate,
  applySuggested: true,
});
assert.deepEqual(changedAxisCycle["网格已执行"], []);

assert.equal(parseDate("2026-08-26")?.toISOString().slice(0, 10), "2026-08-26");
assert.equal(parseDate("2026-02-29"), null);
assert.equal(parseDate("2026-13-01"), null);
assert.equal(parseDate("26-08-26"), null);
const normalizedHistory = normalizeNavHistory([
  { x: Date.parse("2026-08-03T00:00:00+08:00"), y: 1, equityReturn: 0.1 },
  { x: Date.parse("2026-08-03T00:00:00+08:00"), y: 1.1, equityReturn: 0.2 },
  { x: Date.parse("2026-08-04T00:00:00+08:00"), y: 1.2, equityReturn: "invalid" },
]);
assert.deepEqual(normalizedHistory, [
  { date: "2026-08-03", nav: 1.1, change: 0.2 },
  { date: "2026-08-04", nav: 1.2, change: 0 },
]);
assert.equal(positiveNumber(1), true);
assert.equal(positiveNumber(Infinity), false);
assert.equal(positiveNumber(""), false);
assert.equal(effectiveDcaStartDate(false, true, "2026-08-01", "2026-08-26"), "2026-08-26");
assert.equal(effectiveDcaStartDate(true, true, "2026-08-01", "2026-08-26"), "2026-08-01");
assert.equal(validDcaSettings(false, 0, 99, "", "bad", 0), true);
assert.equal(validDcaSettings(true, 100, 0.06, "2026-08-26", "daily", 0), true);
assert.equal(validDcaSettings(true, 0, 0.06, "2026-08-26", "daily", 0), false);
assert.equal(validDcaSettings(true, 100, 0.06, "2026-08-26", "weekly", 6), false);

const detectedGroups = Plugin.prototype.getFundGroupNames.call({
  app: {
    vault: {
      getAbstractFileByPath: () => ({
        children: [
          { name: "沪深300", children: [] },
          { name: "基金说明.md", extension: "md" },
        ],
      }),
    },
  },
});
assert.ok(detectedGroups.includes("沪深300"));
assert.ok(detectedGroups.includes("黄金"));
assert.ok(detectedGroups.includes("未分类"));
assert.equal(detectedGroups[0], "未分类");
assert.ok(!detectedGroups.includes("基金说明.md"));
const configuredEmptyGroups = Plugin.prototype.getFundGroupNames.call({
  groupConfig: { groups: { 未分类: { target: 0 }, 沪深300: { target: 25 }, 自定义空组: { target: 0 } } },
  app: { vault: { getAbstractFileByPath: () => ({ children: [] }) } },
});
assert.deepEqual(configuredEmptyGroups, ["未分类", "沪深300", "自定义空组"]);
assert.equal(Plugin.prototype.getFundGroupName.call({}, {
  parent: { name: "基金持仓", path: "投资/基金持仓" },
}), "未分类");
assert.equal(Plugin.prototype.getFundGroupName.call({}, {
  parent: { name: "沪深300", path: "投资/基金持仓/沪深300" },
}), "沪深300");
assert.equal(groupColor("黄金"), "#d5a936");
assert.equal(groupColor("未分类"), "#87909f");
assert.equal(groupColor("沪深300"), groupColor("沪深300"));
assert.notEqual(groupColor("沪深300"), groupColor("现金"));
const customGroup = Plugin.prototype.getGroupDefinition.call({
  groupConfig: { groups: { 沪深300: { target: 12.5, color: "#123456" } } },
}, "沪深300");
assert.deepEqual(customGroup, { name: "沪深300", target: 12.5, color: "#123456" });
const defaultUnclassified = Plugin.prototype.getGroupDefinition.call({ groupConfig: { groups: {} } }, "未分类");
assert.equal(defaultUnclassified.target, 0);
assert.equal(defaultUnclassified.color, "#87909f");

const gridFundFile = { basename: "黄金A", path: "投资/基金持仓/黄金/黄金A.md", parent: { name: "黄金" } };
const gridFundRecords = Plugin.prototype.getFundRecords.call({
  isFundFile: () => true,
  app: {
    vault: { getMarkdownFiles: () => [gridFundFile] },
    metadataCache: { getFileCache: () => ({ frontmatter: {
      基金编号: "000216",
      最新净值: 3.4,
      净值日期: "2026-08-26",
      网格启用: true,
      网格参考代码: "510310",
      网格参考名称: "沪深300ETF易方达",
      网格当前价格: 4.52,
      网格行情日期: "2026-08-26",
      网格行情时间: "16:14",
      网格执行中轴: 4.6,
      网格中轴日期: "2026-08-26",
      网格建议中轴: 4.58,
      网格中轴状态: "正常",
      网格间距: 3,
      网格建议间距: 4,
      网格已执行: ["sell-2", "buy-1"],
    } }) },
  },
});
assert.equal(gridFundRecords.length, 1);
assert.equal(gridFundRecords[0].gridEnabled, true);
assert.equal(gridFundRecords[0].group, "黄金");
assert.equal(gridFundRecords[0].gridReferenceCode, "510310");
assert.equal(gridFundRecords[0].gridReferenceName, "沪深300ETF易方达");
assert.equal(gridFundRecords[0].gridCurrentPrice, 4.52);
assert.equal(gridFundRecords[0].gridExecutionAxis, 4.6);
assert.equal(gridFundRecords[0].gridSuggestedAxis, 4.58);
assert.equal(gridFundRecords[0].gridSpacing, 3);
assert.equal(gridFundRecords[0].gridSuggestedSpacing, 4);
assert.deepEqual(gridFundRecords[0].gridExecutedLevels, ["buy-1", "sell-2"]);

const points = [
  ["2026-08-03", 1],
  ["2026-08-04", 2],
  ["2026-08-05", 4],
  ["2026-08-10", 5],
  ["2026-08-17", 10],
].map(([date, nav]) => ({ date, nav, change: 0 }));

assert.deepEqual(
  dueNavPoints(points, { frequency: "daily", startDate: "2026-08-03", lastDate: "2026-08-04" }).map((p) => p.date),
  ["2026-08-05", "2026-08-10", "2026-08-17"],
);
assert.deepEqual(
  dueNavPoints(points, { frequency: "weekly", schedule: 1, startDate: "2026-08-03", lastDate: "" }).map((p) => p.date),
  ["2026-08-03", "2026-08-10", "2026-08-17"],
);
assert.deepEqual(
  dueNavPoints(points, { frequency: "monthly", schedule: 3, startDate: "2026-08-03", lastDate: "" }).map((p) => p.date),
  ["2026-08-03"],
);
assert.deepEqual(
  dueNavPoints(points, { frequency: "weekly", schedule: 4, startDate: "2026-08-03", lastDate: "" }).map((p) => p.date),
  ["2026-08-10", "2026-08-17"],
);
assert.deepEqual(
  dueNavPoints(points, { frequency: "weekly", schedule: 1, startDate: "2026-08-03", lastDate: "2026-08-17" }),
  [],
);
assert.deepEqual(
  dueNavPoints([
    { date: "2026-08-03", nav: 1, change: 0 },
    { date: "2026-08-24", nav: 2, change: 0 },
  ], { frequency: "weekly", schedule: 1, startDate: "2026-08-10", lastDate: "2026-08-03" }).map((p) => p.date),
  ["2026-08-24"],
);

const context = {};
const invalidPosition = Plugin.prototype.prepareFund.call(context, {
  "持仓份额": "",
  "持仓成本价": "",
}, points);
assert.equal(invalidPosition.positionWarning, "缺少有效的持仓份额或持仓总成本");
assert.equal(invalidPosition.executions.length, 0);

const directPosition = Plugin.prototype.prepareFund.call(context, {
  "持仓份额": 100,
  "持仓成本价": 2,
  "定投启用": false,
}, points);
assert.equal(directPosition.shares, 100);
assert.equal(directPosition.cost, 200);
assert.equal(directPosition.executions.length, 0);
const directChanges = Plugin.prototype.buildChanges.call(context, {}, directPosition);
assert.equal(directChanges["持仓成本价"], 2);
assert.equal(directChanges["持仓总成本"], 200);
assert.equal(directChanges["持有金额"], 1000);
assert.equal(directChanges["持有收益"], 800);

const directDca = Plugin.prototype.prepareFund.call(context, {
  "持仓份额": 100,
  "持仓成本价": 2,
  "定投启用": true,
  "定投金额": 100,
  "定投频率": "日",
  "定投日期": "每个交易日",
  "手续费率": 0,
  "定投开始日期": "2026-08-17",
  "最后定投日期": "2026-08-10",
}, points);
assert.equal(directDca.executions.length, 1);
assert.equal(directDca.shares, 110);
assert.equal(directDca.cost, 300);
const feeDca = Plugin.prototype.prepareFund.call(context, {
  "持仓份额": 100,
  "持仓成本价": 2,
  "定投启用": true,
  "定投金额": 100,
  "定投频率": "日",
  "定投日期": "每个交易日",
  "手续费率": 1,
  "定投开始日期": "2026-08-17",
  "最后定投日期": "2026-08-10",
}, points);
assert.ok(Math.abs(feeDca.shares - (100 + 100 / 1.01 / 10)) < 1e-12);
const feeDcaChanges = Plugin.prototype.buildChanges.call(context, {}, feeDca);
assert.equal(feeDcaChanges["最近定投份额"], 9.90099009901);
assert.equal(feeDcaChanges["持仓份额"], 109.90099009901);
assert.equal(feeDcaChanges["持有金额"], 1099.01);
assert.equal(feeDcaChanges["持有收益"], 799.01);

assert.ok(Math.abs(dailyHoldingProfit({
  "持仓份额": 100,
  "最新净值": 1.1,
  "昨日净值": 1,
  "净值日期": "2026-08-26",
}) - 10) < 0.0000001);
assert.ok(Math.abs(dailyHoldingProfit({
  "持仓份额": 110,
  "最新净值": 1.1,
  "昨日净值": 1,
  "净值日期": "2026-08-26",
  "最后定投日期": "2026-08-26",
  "最近定投份额": 10,
  "定投金额": 1000,
  "手续费率": 5,
}) - 10) < 0.0000001);
assert.ok(Math.abs(dailyHoldingProfit({
  "持仓份额": 110,
  "最新净值": 1.1,
  "昨日净值": 1,
  "净值日期": "2026-08-26",
  "最后定投日期": "2026-08-26",
  "定投金额": 11,
  "手续费率": 0,
}) - 10) < 0.0000001);
assert.equal(dailyHoldingProfit({ "持仓份额": 100, "最新净值": 1.1 }), null);
assert.equal(dailyHoldingProfit({ "持仓份额": "", "最新净值": 1.1, "昨日净值": 1 }), null);
assert.equal(totalHoldingCost({ "持仓份额": 100, "持仓成本价": 1.23, "持仓成本": 999 }), 123);
assert.equal(totalHoldingCost({ "持仓总成本": 123.456, "持仓份额": 100, "持仓成本价": 9 }), 123.456);
assert.equal(totalHoldingCost({ "持仓份额": 100, "持仓成本": 456 }), 456);
assert.equal(totalHoldingCost({ "持仓份额": 100, "持仓成本价": "", "持仓成本": 456 }), 456);
assert.equal(sanitizeFundName(" 指数A/B？ "), "指数A／B？");
assert.equal(sanitizeFundName("指数\nA"), "指数A");
assert.equal(validGroupName("沪深300"), true);
assert.equal(validGroupName(""), false);
assert.equal(validGroupName("../黄金"), false);
assert.equal(validGroupName("黄金/现金"), false);
assert.equal(parseFundName('var fS_name = "华安黄金ETF联接A";'), "华安黄金ETF联接A");
const createdFundNote = createFundNoteContent({
  code: "000216",
  shares: 100,
  holdingAmount: 130,
  holdingProfit: 6.55,
  dcaEnabled: true,
  amount: 100,
  frequency: "weekly",
  weekday: 3,
  monthday: 1,
  feeRate: 0.06,
  startDate: "2026-08-26",
});
assert.match(createdFundNote, /基金编号: "000216"/);
assert.match(createdFundNote, /持仓份额: 100/);
assert.match(createdFundNote, /持仓成本价: 1\.2345/);
assert.match(createdFundNote, /持仓总成本: 123\.45/);
assert.doesNotMatch(createdFundNote, /持仓成本:/);
assert.match(createdFundNote, /网格启用: false/);
assert.match(createdFundNote, /定投启用: true/);
assert.match(createdFundNote, /定投金额: 100/);
assert.match(createdFundNote, /定投频率: 周/);
assert.match(createdFundNote, /定投日期: 周三/);
assert.match(createdFundNote, /手续费率: 0\.06/);
assert.match(createdFundNote, /定投开始日期: 2026-08-26/);
assert.match(createdFundNote, /```fund-dashboard/);
const nonDcaNote = createFundNoteContent({
  code: "007339",
  shares: 10,
  holdingAmount: 20,
  holdingProfit: 2,
  dcaEnabled: false,
});
assert.doesNotMatch(nonDcaNote, /定投频率:/);
assert.doesNotMatch(nonDcaNote, /定投开始日期:/);
const roundedPositionNote = createFundNoteContent({
  code: "000001",
  shares: 2525.456912,
  holdingAmount: 8000,
  holdingProfit: 300,
  dcaEnabled: false,
});
assert.match(roundedPositionNote, /持仓份额: 2525\.456912/);
assert.match(roundedPositionNote, /持仓总成本: 7700/);
const calibrated = positionFromSnapshot(14523.96, 20066.30, 64.94);
assert.equal(calibrated.totalCost, 20001.36);
assert.equal(calibrated.costPrice, 1.377128551717);
assert.equal(calibrated.profitRate, 0.32);
assert.equal(positionFromSnapshot(100, 120, ""), null);
assert.equal(positionFromSnapshot(100, 120, -10).totalCost, 130);

const overview = buildOverviewData([
  { name: "黄金A", group: "黄金", amount: 1200, cost: 1000, profit: 200, change: -0.81, navDate: "2026-08-26", dailyProfit: 12, gridEnabled: true },
  { name: "标普A", group: "标普500", amount: 880, cost: 800, profit: 80, navDate: "2026-08-25", dailyProfit: -5 },
  { name: "标普B", group: "标普500", amount: 1100, cost: 1000, profit: 100, navDate: "2026-08-26", dailyProfit: 8 },
], "2026-08-26");
assert.equal(overview.summary.totalAmount, 3180);
assert.equal(overview.funds.find((fund) => fund.name === "黄金A").gridEnabled, true);
assert.equal(overview.funds.find((fund) => fund.name === "黄金A").change, -0.81);
assert.equal(overview.summary.totalCost, 2800);
assert.equal(overview.summary.totalProfit, 380);
assert.equal(overview.summary.dailyProfit, 20);
assert.equal(overview.summary.updatedCount, 2);
assert.equal(overview.summary.dailyLabel, "今日收益");
assert.equal(overview.groups.find((group) => group.name === "标普500").amount, 1980);
assert.equal(overview.groups.find((group) => group.name === "标普500").profitRate, 10);
assert.equal(overview.funds[0].name, "黄金A");
assert.equal(buildOverviewData(overview.funds, "2026-08-27").summary.dailyLabel, "昨日收益");
assert.deepEqual(sortFunds(overview.funds, "group").map((fund) => fund.name), ["标普B", "标普A", "黄金A"]);
assert.deepEqual(sortFunds(overview.funds).map((fund) => fund.name), ["标普B", "标普A", "黄金A"]);
assert.deepEqual(sortFunds(overview.funds, "profit").map((fund) => fund.name), ["黄金A", "标普B", "标普A"]);
assert.deepEqual(sortFunds([
  { name: "未更新", amount: 100, dailyProfit: null },
  { name: "已更新", amount: 50, dailyProfit: -1 },
], "dailyProfit").map((fund) => fund.name), ["已更新", "未更新"]);
const configuredOverview = buildOverviewData(overview.funds, "2026-08-26", [
  { name: "黄金", color: "#111111", target: 40 },
  { name: "标普500", color: "#222222", target: 60 },
]);
assert.equal(configuredOverview.groups.find((group) => group.name === "黄金").target, 40);
assert.equal(configuredOverview.groups.find((group) => group.name === "黄金").color, "#111111");
const noUnclassifiedOverview = buildOverviewData(overview.funds, "2026-08-26", [
  { name: "未分类", color: "#999999", target: 0 },
  { name: "黄金", color: "#111111", target: 40 },
  { name: "标普500", color: "#222222", target: 60 },
]);
assert.equal(noUnclassifiedOverview.groups.some((group) => group.name === "未分类"), false);
const withUnclassifiedOverview = buildOverviewData([
  ...overview.funds,
  { name: "待分组", group: "未分类", amount: 10, cost: 10, profit: 0, navDate: "2026-08-26", dailyProfit: 0 },
], "2026-08-26", [
  { name: "未分类", color: "#999999", target: 0 },
]);
assert.equal(withUnclassifiedOverview.groups.some((group) => group.name === "未分类"), true);
const roundedOverview = buildOverviewData([{
  name: "舍入测试",
  group: "黄金",
  amount: 123.49,
  cost: 111.14433,
  profit: 12.34,
  profitRate: 11.1,
  navDate: "2026-08-26",
  dailyProfit: 0,
}], "2026-08-26");
assert.equal(roundedOverview.summary.totalProfit, 12.34);
assert.equal(roundedOverview.groups.find((group) => group.name === "黄金").profit, 12.34);
assert.equal(buildOverviewData([{
  name: "旧数据",
  group: "黄金",
  amount: 10,
  cost: 8,
  navDate: "2026-08-26",
  dailyProfit: 0,
}], "2026-08-26").summary.totalProfit, 2);

(async () => {
  const executionFund = {
    name: "测试基金",
    code: "000216",
    gridReferenceCode: "518880",
    gridExecutionAxis: 100,
    gridAxisDate: "2026-08-26",
    gridSpacing: 5,
    gridCurrentPrice: 90,
    gridMarketDate: "2026-08-27",
    file: { path: "投资/基金持仓/测试基金.md" },
  };
  const executionFrontmatter = {};
  const executionHistory = [
    { date: "2026-08-27", close: 90 },
    { date: "2026-08-28", close: 95 },
    { date: "2026-08-29", close: 106.05 },
  ];
  const executionPlugin = {
    getFundRecords: () => {
      const currentCycle = gridCycleId(
        executionFund.gridReferenceCode,
        executionFund.gridAxisDate,
        executionFund.gridExecutionAxis,
        executionFund.gridSpacing,
      );
      const trades = normalizeGridTradeRecords(executionFrontmatter["网格交易记录"]);
      return [{
        ...executionFund,
        gridCycleId: currentCycle,
        gridExecutedLevels: gridExecutedLevelsFromTrades(trades, currentCycle),
        gridTradeRecords: trades,
      }];
    },
    app: {
      fileManager: {
        processFrontMatter: async (_file, callback) => callback(executionFrontmatter),
      },
    },
    getGridHistory: () => executionHistory,
    scheduleRenderedRefresh: () => {},
  };
  await Plugin.prototype.toggleGridExecution.call(executionPlugin, {
    fund: executionFund,
    mode: "record-trade",
    side: "buy",
    levelPrice: 90,
    tradePosition: -2,
    tradeDate: "2026-08-27",
    tradeCycleId: cycleA,
  });
  const buyRecord = `2026-08-27 · 买入 · 买2 · 90 · 周期 ${cycleA}`;
  assert.deepEqual(executionFrontmatter["网格已执行"], ["buy-2"]);
  assert.deepEqual(executionFrontmatter["网格交易记录"], [buyRecord]);

  await Plugin.prototype.toggleGridExecution.call(executionPlugin, {
    fund: executionFund,
    mode: "record-trade",
    side: "sell",
    levelPrice: 95,
    tradePosition: -1,
    tradeDate: "2026-08-28",
    tradeCycleId: cycleA,
  });
  assert.equal("网格已执行" in executionFrontmatter, false);

  executionFund.gridExecutionAxis = 101;
  executionFund.gridAxisDate = "2026-08-27";
  const currentCycle = gridCycleId(
    executionFund.gridReferenceCode,
    executionFund.gridAxisDate,
    executionFund.gridExecutionAxis,
    executionFund.gridSpacing,
  );
  assert.equal(currentCycle, cycleB);
  await assert.rejects(() => Plugin.prototype.toggleGridExecution.call(executionPlugin, {
    fund: executionFund,
    mode: "record-trade",
    side: "buy",
    levelPrice: 95,
    tradePosition: -1,
    tradeDate: "2026-08-28",
    tradeCycleId: cycleA,
  }), /周期已变化/);

  await Plugin.prototype.toggleGridExecution.call(executionPlugin, {
    fund: executionFund,
    mode: "record-trade",
    side: "sell",
    levelPrice: 106.05,
    tradePosition: 1,
    tradeDate: "2026-08-29",
    tradeCycleId: cycleB,
  });
  assert.deepEqual(executionFrontmatter["网格已执行"], ["sell-1"]);
  const sellRecord = `2026-08-29 · 卖出 · 卖1 · 106.05 · 周期 ${cycleB}`;
  const sellIndex = executionFrontmatter["网格交易记录"].indexOf(sellRecord);

  await Plugin.prototype.toggleGridExecution.call(executionPlugin, {
    fund: executionFund,
    mode: "cancel-trade",
    side: "sell",
    levelPrice: 106.05,
    tradeIndex: sellIndex,
    tradeRaw: sellRecord,
    tradePosition: 1,
    tradeDate: "2026-08-29",
    tradeCycleId: cycleB,
  });
  assert.equal("网格已执行" in executionFrontmatter, false);
  const canceledSellRecord = `${sellRecord} · 已取消`;
  assert.equal(executionFrontmatter["网格交易记录"].includes(canceledSellRecord), true);

  await Plugin.prototype.toggleGridExecution.call(executionPlugin, {
    fund: executionFund,
    mode: "restore-trade",
    side: "sell",
    levelPrice: 106.05,
    tradeIndex: sellIndex,
    tradeRaw: canceledSellRecord,
    tradePosition: 1,
    tradeDate: "2026-08-29",
    tradeCycleId: cycleB,
  });
  assert.deepEqual(executionFrontmatter["网格已执行"], ["sell-1"]);

  const buyIndex = executionFrontmatter["网格交易记录"].indexOf(buyRecord);
  await Plugin.prototype.toggleGridExecution.call(executionPlugin, {
    fund: executionFund,
    mode: "cancel-trade",
    side: "buy",
    levelPrice: 90,
    tradeIndex: buyIndex,
    tradeRaw: buyRecord,
    tradePosition: -2,
    tradeDate: "2026-08-27",
    tradeCycleId: cycleA,
  });
  assert.deepEqual(executionFrontmatter["网格已执行"], ["sell-1"]);
  console.log("fund-assistant tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
