const assert = require("node:assert/strict");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  return request === "obsidian" ? require("./test-stubs/obsidian") : originalLoad.call(this, request, parent, isMain);
};
const Plugin = require(process.env.DCA_TEST_BUNDLE ? "./build/main" : "./main");
Module._load = originalLoad;
const { prepareDca, readDcaState, saveDcaPlanChange, calibrateDca } = require("./dca");
const { dailyHoldingProfit } = require("./fund-math");
const today = "2026-08-31";
const base = { 基金编号: "000001", 持仓份额: 100, 持仓总成本: 100,
  定投启用: true, 定投金额: 100, 定投频率: "日", 定投日期: "每个交易日",
  手续费率: 0, 定投开始日期: "2026-08-03", 最后定投日期: "2026-07-31" };
const points = (...dates) => dates.map((date) => ({ date, nav: 1, change: 0 }));
function refresh(fm, history, now = today) {
  const result = prepareDca(fm, history, now);
  return { ...fm, ...result.changes,
    持仓份额: fm.持仓份额 + result.added.reduce((sum, row) => sum + row.shares, 0),
    持仓总成本: fm.持仓总成本 + result.added.reduce((sum, row) => sum + row.amount, 0) };
}

// Offline and incremental updates converge, including repeated/stale responses.
const history = points("2026-08-03", "2026-08-04", "2026-08-05");
const batch = refresh(base, history);
assert.equal(batch.持仓份额, 400);
assert.equal(batch.定投记录.length, 3);
assert.deepEqual(refresh(batch, history), batch);
assert.deepEqual(refresh(refresh(base, history.slice(0, 1)), history), batch);
assert.deepEqual(refresh(batch, history.slice(0, 1)), batch);
assert.deepEqual(refresh(base, [...history].reverse().concat(history[0])), batch);

// A late daily point is recovered even when its date is earlier than the latest record.
const gap = refresh(base, [history[0], history[2]]);
assert.equal(gap.持仓份额, 300);
assert.deepEqual(refresh(gap, history), batch);
assert.equal(refresh({ ...base, 最后定投日期: "2026-08-04" }, history).持仓份额, 200, "legacy baseline is not rebooked");

// Several weekly/monthly periods using one NAV remain distinct subscriptions.
const weekly = { ...base, 定投频率: "周", 定投日期: "周一" };
const weeklyBatch = refresh(weekly, points("2026-08-17"));
assert.equal(weeklyBatch.定投记录.length, 3);
assert.equal(weeklyBatch.持仓总成本, 400);
assert.equal(weeklyBatch.最近定投份额, 300, "sum all acquisitions on the last NAV date");
assert.deepEqual(refresh(weeklyBatch, points("2026-08-17")), weeklyBatch);
assert.equal(dailyHoldingProfit({ ...weeklyBatch, 净值日期: "2026-08-17", 最新净值: 1, 昨日净值: 0.9 }).toFixed(2), "10.00");
const monthly = refresh({ ...base, 定投频率: "月", 定投日期: 3, 定投开始日期: "2026-06-03", 最后定投日期: "" }, points("2026-08-17"));
assert.equal(monthly.定投记录.length, 3);

// Amount/fee changes preserve unsettled periods, even when their NAV arrives later.
const changed = { ...base };
saveDcaPlanChange(changed, { 定投金额: 200, 手续费率: 1 }, "2026-08-04");
const settled = refresh(changed, history);
assert.deepEqual(readDcaState(settled).records.map((row) => row.amount), [100, 100, 200]);
assert.deepEqual(readDcaState(settled).records.map((row) => row.shares), [100, 100, 198.02]);
const delayedWeekly = { ...weekly };
saveDcaPlanChange(delayedWeekly, { 定投金额: 200 }, "2026-08-04");
const delayed = refresh(delayedWeekly, points("2026-08-05", "2026-08-10"));
assert.deepEqual(readDcaState(delayed).records.map((row) => [row.dueDate, row.amount]), [["2026-08-03", 100], ["2026-08-10", 200]]);
saveDcaPlanChange(changed, { 定投金额: 300 }, "2026-08-04");
assert.equal(readDcaState(changed).plans.length, 2, "same-day edits replace only tomorrow's version");
assert.equal(readDcaState(changed).plans[0].amount, 100);
assert.equal(readDcaState(changed).plans[1].amount, 300);

// Pausing stops future periods, but does not cancel an older unsettled period.
const paused = { ...weekly };
saveDcaPlanChange(paused, { 定投启用: false }, "2026-08-04");
const pauseSettled = refresh(paused, points("2026-08-05", "2026-08-10"));
assert.deepEqual(readDcaState(pauseSettled).records.map((row) => row.dueDate), ["2026-08-03"]);
saveDcaPlanChange(pauseSettled, { 定投启用: true }, "2026-08-11");
assert.deepEqual(readDcaState(refresh(pauseSettled, points("2026-08-05", "2026-08-10", "2026-08-17"))).records
  .map((row) => row.dueDate), ["2026-08-03", "2026-08-17"]);
const frequencyChange = { ...base };
saveDcaPlanChange(frequencyChange, { 定投频率: "周", 定投日期: "周一" }, "2026-08-04");
assert.deepEqual(readDcaState(refresh(frequencyChange, [...history, ...points("2026-08-10")])).records
  .map((row) => row.dueDate), ["2026-08-03", "2026-08-04", "2026-08-10"]);

// Calibration establishes a new inclusive NAV boundary without deleting audit history.
const calibrated = { ...refresh(base, history.slice(0, 1)) };
calibrateDca(calibrated, "2026-08-04", today);
Object.assign(calibrated, { 持仓份额: 900, 持仓总成本: 900 });
const afterCalibration = refresh(calibrated, history);
assert.equal(afterCalibration.持仓份额, 1000);
assert.equal(afterCalibration.定投记录.length, 2);
assert.deepEqual(refresh(afterCalibration, history), afterCalibration);
assert.throws(() => calibrateDca(afterCalibration, "2026-08-04", today), /不能早于/);
assert.equal(dailyHoldingProfit({ ...calibrated, 净值日期: "2026-08-04", 最新净值: 1, 昨日净值: 0.9 }), null);
assert.equal(dailyHoldingProfit({ ...afterCalibration, 净值日期: "2026-08-05", 最新净值: 1, 昨日净值: 0.9 }).toFixed(2), "90.00");

// Never silently discard broken records and buy those periods again.
assert.throws(() => prepareDca({ ...batch, 定投记录: ["broken"] }, history, today), /无法解析/);
assert.throws(() => prepareDca({ ...batch, 定投记录: [...batch.定投记录, batch.定投记录[0]] }, history, today), /重复期次/);
assert.throws(() => prepareDca({ ...batch, 定投记录版本: undefined }, history, today), /版本缺失/);
assert.throws(() => prepareDca({ ...base, 定投频率: "周", 定投日期: 1.5 }, history, today), /执行日期无效/);
assert.throws(() => prepareDca({ ...base, 定投频率: "月", 定投日期: 2.5 }, history, today), /执行日期无效/);
assert.throws(() => prepareDca({ ...base, 定投金额: Infinity }, history, today), /金额/);
assert.throws(() => prepareDca(base, [{ date: "2026-08-03", nav: 0 }], today), /净值/);
assert.throws(() => prepareDca(base, points("2026-09-01"), today), /净值/);
assert.deepEqual(refresh(batch, history.map((row) => ({ ...row, nav: 2 }))), batch, "do not silently recalculate settled subscriptions");

async function integrationTests() {
  let fm = { ...base };
  const file = { basename: "demo" };
  let duringFetch = () => {};
  let failWrite = false;
  const plugin = {
    app: {
      vault: { getMarkdownFiles: () => [file] },
      metadataCache: { getFileCache: () => ({ frontmatter: structuredClone(fm) }) },
      fileManager: { processFrontMatter: async (_, callback) => {
        const draft = structuredClone(fm);
        callback(draft);
        if (failWrite) throw new Error("simulated disk failure");
        fm = draft;
      } },
    },
    isFundFile: () => true,
    navHistory: async () => { duringFetch(); return history; },
    prepareFund: Plugin.prototype.prepareFund, buildChanges: Plugin.prototype.buildChanges,
    hasChanges: Plugin.prototype.hasChanges, updateLogDate: async () => {},
  };
  // A real snapshot arriving during the HTTP request must be the computation input.
  duringFetch = () => {
    calibrateDca(fm, "2026-08-04", today);
    fm.持仓份额 = 900;
    fm.持仓总成本 = 900;
  };
  let result = await Plugin.prototype.refreshAll.call(plugin);
  assert.equal(result.failures.length, 0);
  assert.equal(fm.持仓份额, 1000);
  assert.equal(fm.定投记录.length, 1);
  duringFetch = () => {};
  result = await Plugin.prototype.refreshAll.call(plugin);
  assert.equal(result.updated, 0);
  assert.equal(fm.持仓份额, 1000);

  fm = { ...base };
  duringFetch = () => { saveDcaPlanChange(fm, { 定投金额: 200 }, "2026-08-04"); };
  await Plugin.prototype.refreshAll.call(plugin);
  assert.equal(fm.持仓总成本, 500, "latest settings and plan history survive network waits");

  fm = { ...base };
  duringFetch = () => {};
  failWrite = true;
  const originalError = console.error;
  console.error = () => {};
  try {
    result = await Plugin.prototype.refreshAll.call(plugin);
    assert.equal(result.failures.length, 1);
    assert.deepEqual(fm, base, "failed write commits neither shares nor records");
    failWrite = false;
    result = await Plugin.prototype.refreshAll.call(plugin);
    assert.equal(result.failures.length, 0);
    assert.equal(fm.持仓份额, 400);
    assert.equal(fm.定投记录.length, 3);
    const beforeStale = structuredClone(fm);
    fm.持仓校准日期 = "2026-08-06";
    result = await Plugin.prototype.refreshAll.call(plugin);
    assert.match(result.failures[0], /校准日期/);
    assert.deepEqual(fm, { ...beforeStale, 持仓校准日期: "2026-08-06" });
    delete fm.持仓校准日期;
    duringFetch = () => { fm.基金编号 = "000002"; };
    result = await Plugin.prototype.refreshAll.call(plugin);
    assert.match(result.failures[0], /基金编号已变更/);
  } finally { console.error = originalError; }
}

integrationTests().then(() => console.log("DCA regression tests passed")).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
