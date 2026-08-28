const fs = require("node:fs");
const path = require("node:path");

const root = __dirname;
const read = (name) => fs.readFileSync(path.join(root, name), "utf8").trim();
const withoutExports = (source) => source.replace(/\nmodule\.exports\s*=\s*\{[\s\S]*?\};?\s*$/, "");

const constants = withoutExports(read("constants.js"));
const fundMath = withoutExports(read("fund-math.js"));
const overview = withoutExports(read("overview.js"))
  .replace(/^const \{ FUND_GROUPS, groupColor \} = require\("\.\/constants"\);\r?\n/, "")
  .replace(/^const \{ dailyHoldingProfit, totalHoldingCost \} = require\("\.\/fund-math"\);\r?\n/, "");

const bundledOverview = [
  "const { buildOverviewData, renderFundOverview } = (() => {",
  overview.split("\n").map((line) => `  ${line}`).join("\n"),
  "  return { buildOverviewData, renderFundOverview };",
  "})();",
].join("\n");

const grid = withoutExports(read("grid.js"));
const bundledGrid = [
  "const { GRID_LOOKBACK_DAYS, GRID_VISIBLE_LEVELS, buildGridChartModel, buildGridTriggerPoints, calculateGridBand, calculateSuggestedAxis, calculateSuggestedSpacing, evaluateGridAxisReview, gridCycleId, gridLevelPrice, gridMarketIsProvisional, gridMarketSymbol, gridOfficialRows, gridPendingCloseAction, gridPositionLabel, gridQuoteIsOfficialClose, parseGridKlinePayload, parseGridQuoteText, renderGridOverview } = (() => {",
  grid.split("\n").map((line) => `  ${line}`).join("\n"),
  "  return { GRID_LOOKBACK_DAYS, GRID_VISIBLE_LEVELS, buildGridChartModel, buildGridTriggerPoints, calculateGridBand, calculateSuggestedAxis, calculateSuggestedSpacing, evaluateGridAxisReview, gridCycleId, gridLevelPrice, gridMarketIsProvisional, gridMarketSymbol, gridOfficialRows, gridPendingCloseAction, gridPositionLabel, gridQuoteIsOfficialClose, parseGridKlinePayload, parseGridQuoteText, renderGridOverview };",
  "})();",
].join("\n");

const qdii = withoutExports(read("qdii.js"));
const bundledQdii = [
  "const { QDII_SOURCE_URL, normalizeQdiiQuotaCache, parseQdiiFundFees, parseQdiiQuotaHtml, qdiiQuotaChangeCounts, renderQdiiQuota } = (() => {",
  qdii.split("\n").map((line) => `  ${line}`).join("\n"),
  "  return { QDII_SOURCE_URL, normalizeQdiiQuotaCache, parseQdiiFundFees, parseQdiiQuotaHtml, qdiiQuotaChangeCounts, renderQdiiQuota };",
  "})();",
].join("\n");

let main = read("main.js")
  .replace(/^const \{ FUND_GROUPS, groupColor \} = require\("\.\/constants"\);\r?\n/m, "")
  .replace(/^const \{ dailyHoldingProfit, totalHoldingCost \} = require\("\.\/fund-math"\);\r?\n/m, "")
  .replace(/^const \{ renderFundOverview \} = require\("\.\/overview"\);\r?\n/m, "")
  .replace(/^const \{\r?\n  QDII_SOURCE_URL,\r?\n  normalizeQdiiQuotaCache,\r?\n  parseQdiiFundFees,\r?\n  parseQdiiQuotaHtml,\r?\n  qdiiQuotaChangeCounts,\r?\n  renderQdiiQuota,\r?\n\} = require\("\.\/qdii"\);\r?\n/m, "")
  .replace(/^const \{\r?\n  GRID_LOOKBACK_DAYS,\r?\n  calculateSuggestedAxis,\r?\n  calculateSuggestedSpacing,\r?\n  evaluateGridAxisReview,\r?\n  gridCycleId,\r?\n  gridMarketSymbol,\r?\n  gridOfficialRows,\r?\n  parseGridKlinePayload,\r?\n  parseGridQuoteText,\r?\n  renderGridOverview,\r?\n\} = require\("\.\/grid"\);\r?\n/m, "");

const marker = "const DEFAULT_SETTINGS =";
if (!main.includes(marker)) throw new Error("无法定位 main.js 插入点");
main = main.replace(marker, `${constants}\n\n${fundMath}\n\n${bundledOverview}\n\n${bundledGrid}\n\n${bundledQdii}\n\n${marker}`);

const outputDir = path.join(root, "build");
fs.mkdirSync(outputDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, "main.js"), `${main}\n`, "utf8");
fs.copyFileSync(path.join(root, "manifest.json"), path.join(outputDir, "manifest.json"));
fs.copyFileSync(path.join(root, "styles.css"), path.join(outputDir, "styles.css"));
console.log("fund-assistant build complete");
