// The ledger and position are committed in the same processFrontMatter callback.
// Dates are calendar dates in China; plan intervals are [startDate, endDate).
const dcaDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
};
const dcaToday = () => new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
const dcaNextDate = (value) => new Date(dcaDate(value).getTime() + 86400000).toISOString().slice(0, 10);
const dcaRound = (value, places = 12) => Number(value.toFixed(places));
const dcaWeekdays = { 周一: 1, 周二: 2, 周三: 3, 周四: 4, 周五: 5 };

function validDcaSchedule(frequency, schedule) {
  return frequency === "daily" || (Number.isInteger(schedule)
    && ((frequency === "weekly" && schedule >= 1 && schedule <= 5)
      || (frequency === "monthly" && schedule >= 1 && schedule <= 28)));
}

function dcaConfig(fm) {
  const frequency = ({ 日: "daily", 周: "weekly", 月: "monthly" })[fm["定投频率"]] || fm["定投频率"] || "daily";
  const schedule = frequency === "weekly" ? dcaWeekdays[fm["定投日期"]] || Number(fm["定投日期"])
    : frequency === "monthly" ? Number(fm["定投日期"]) : 0;
  const config = { enabled: fm["定投启用"] === true, amount: Number(fm["定投金额"] || 0),
    feeRate: Number(fm["手续费率"] || 0), frequency, schedule };
  if (config.enabled && (!Number.isFinite(config.amount) || config.amount < 0.01
    || !Number.isFinite(config.feeRate) || config.feeRate < 0 || config.feeRate > 10
    || !validDcaSchedule(frequency, schedule))) throw new Error("定投金额、费率或执行日期无效");
  return config.enabled ? config : { enabled: false, amount: 0, feeRate: 0, frequency: "daily", schedule: 0 };
}

function dcaSignature(plan) {
  return JSON.stringify([plan.enabled, plan.amount, plan.feeRate, plan.frequency, plan.schedule]);
}

function readDcaState(fm, today = dcaToday()) {
  if (fm["定投记录版本"] === undefined) {
    if (fm["定投记录"] !== undefined || fm["定投计划历史"] !== undefined) throw new Error("定投记录版本缺失，已停止补算");
    const config = dcaConfig(fm);
    const startDate = config.enabled ? String(fm["定投开始日期"] || "") : today;
    const baseline = String(fm["最后定投日期"] || "");
    if (!dcaDate(startDate) || (baseline && !dcaDate(baseline))) throw new Error("定投开始日期或最后定投日期无效");
    return { baseline, plans: [{ ...config, id: `p@${startDate}`, startDate, endDate: "" }], records: [] };
  }
  if (fm["定投记录版本"] !== 1 || !Array.isArray(fm["定投记录"]) || !Array.isArray(fm["定投计划历史"])) {
    throw new Error("定投记录格式异常，已停止补算");
  }
  let plans, records;
  try {
    plans = fm["定投计划历史"].map((row) => JSON.parse(row));
    records = fm["定投记录"].map((row) => JSON.parse(row));
  } catch { throw new Error("定投记录无法解析，已停止补算"); }
  const baseline = fm["定投补算基准日期"];
  if (typeof baseline !== "string" || (baseline && !dcaDate(baseline)) || !plans.length) throw new Error("定投补算基准异常");
  const ids = new Set();
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (!plan || typeof plan.enabled !== "boolean" || !dcaDate(plan.startDate)
      || plan.id !== `p@${plan.startDate}` || ids.has(plan.id)
      || (plan.endDate !== "" && (!dcaDate(plan.endDate) || plan.endDate <= plan.startDate))
      || (i > 0 && plans[i - 1].endDate !== plan.startDate)
      || (i === plans.length - 1 && plan.endDate !== "")
      || !Number.isFinite(plan.amount) || !Number.isFinite(plan.feeRate)
      || (plan.enabled && (plan.amount < 0.01 || plan.feeRate < 0 || plan.feeRate > 10
        || !validDcaSchedule(plan.frequency, plan.schedule)))) throw new Error("定投计划历史异常，已停止补算");
    ids.add(plan.id);
  }
  const recordIds = new Set();
  for (const row of records) {
    const plan = row && plans.find((item) => item.id === row.planId);
    if (!plan || !plan.enabled || !dcaDate(row.dueDate) || !dcaDate(row.navDate) || row.navDate < row.dueDate
      || row.dueDate < plan.startDate || (plan.endDate && row.dueDate >= plan.endDate)
      || row.id !== `${row.planId}/${row.dueDate}` || recordIds.has(row.id)
      || !Number.isFinite(row.amount) || row.amount !== plan.amount
      || !Number.isFinite(row.feeRate) || row.feeRate !== plan.feeRate
      || !Number.isFinite(row.nav) || row.nav <= 0 || !Number.isFinite(row.shares) || row.shares < 0) {
      throw new Error("定投明细异常或存在重复期次，已停止补算");
    }
    recordIds.add(row.id);
  }
  return { baseline, plans, records };
}

function dcaStateChanges(state) {
  return { "定投记录版本": 1, "定投补算基准日期": state.baseline,
    "定投计划历史": state.plans.map((row) => JSON.stringify(row)),
    "定投记录": state.records.map((row) => JSON.stringify(row)) };
}

// Also catches direct property edits after migration; old parameters remain intact.
function syncDcaPlan(state, fm, today = dcaToday()) {
  const config = dcaConfig(fm);
  const last = state.plans.at(-1);
  if (dcaSignature(last) === dcaSignature(config)) return;
  const effective = dcaNextDate(today);
  if (last.startDate > effective) throw new Error("存在更晚生效的定投计划，请检查系统日期");
  const replacement = { ...config, id: `p@${effective}`, startDate: effective, endDate: "" };
  if (last.startDate === effective) state.plans[state.plans.length - 1] = replacement;
  else {
    last.endDate = effective;
    state.plans.push(replacement);
  }
}

function saveDcaPlanChange(fm, nextProperties, today = dcaToday()) {
  const state = readDcaState(fm, today);
  const next = { ...fm, ...nextProperties };
  syncDcaPlan(state, next, today);
  Object.assign(fm, nextProperties, dcaStateChanges(state));
  if (next["定投启用"] === true) fm["定投开始日期"] = state.plans.at(-1).startDate;
}

function dcaDueDates(plan, points) {
  const end = points.at(-1)?.date;
  if (!end || !validDcaSchedule(plan.frequency, plan.schedule)) return [];
  const within = (date) => date >= plan.startDate && (!plan.endDate || date < plan.endDate);
  if (plan.frequency === "daily") return points.filter((point) => {
    const day = dcaDate(point.date).getUTCDay();
    return within(point.date) && day >= 1 && day <= 5;
  }).map((point) => point.date);
  const dates = [];
  const cursor = dcaDate(plan.startDate);
  if (plan.frequency === "weekly") {
    cursor.setUTCDate(cursor.getUTCDate() + (plan.schedule - cursor.getUTCDay() + 7) % 7);
    while (cursor.toISOString().slice(0, 10) <= end) {
      const date = cursor.toISOString().slice(0, 10);
      if (plan.endDate && date >= plan.endDate) break;
      dates.push(date);
      cursor.setUTCDate(cursor.getUTCDate() + 7);
    }
  } else {
    cursor.setUTCDate(plan.schedule);
    while (cursor.toISOString().slice(0, 10) <= end) {
      const date = cursor.toISOString().slice(0, 10);
      if (plan.endDate && date >= plan.endDate) break;
      if (within(date)) dates.push(date);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }
  return dates;
}

function prepareDca(fm, history, today = dcaToday()) {
  const state = readDcaState(fm, today);
  syncDcaPlan(state, fm, today);
  const unique = new Map();
  for (const point of history) {
    if (!dcaDate(point.date) || !Number.isFinite(point.nav) || point.nav <= 0 || point.date > today) {
      throw new Error("历史净值日期或数值异常，已停止补算");
    }
    unique.set(point.date, point);
  }
  const points = [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
  const seen = new Set(state.records.map((row) => row.id));
  const added = [];
  for (const plan of state.plans) {
    if (!plan.enabled) continue;
    for (const dueDate of dcaDueDates(plan, points)) {
      const id = `${plan.id}/${dueDate}`;
      if (seen.has(id)) continue;
      const point = points.find((row) => row.date >= dueDate);
      if (!point || point.date <= state.baseline) continue;
      const rawShares = plan.amount / (1 + plan.feeRate / 100) / point.nav;
      const shares = Math.round((rawShares + Number.EPSILON * Math.abs(rawShares)) * 100) / 100;
      if (!Number.isFinite(shares)) throw new Error("定投份额超出有效范围");
      added.push({ id, planId: plan.id, dueDate, navDate: point.date, amount: plan.amount,
        feeRate: plan.feeRate, nav: point.nav, shares });
      seen.add(id);
    }
  }
  state.records.push(...added);
  state.records.sort((a, b) => a.navDate.localeCompare(b.navDate) || a.id.localeCompare(b.id));
  const changes = dcaStateChanges(state);
  const last = state.records.at(-1);
  if (last && last.navDate > state.baseline) {
    changes["最后定投日期"] = last.navDate;
    changes["最近定投份额"] = dcaRound(state.records.filter((row) => row.navDate === last.navDate)
      .reduce((sum, row) => sum + row.shares, 0));
  }
  return { changes, added };
}

function calibrateDca(fm, throughDate, today = dcaToday()) {
  if (!dcaDate(throughDate) || throughDate > today) throw new Error("请填写有效的持仓截止净值日期");
  const state = readDcaState(fm, today);
  const latestRecorded = state.records.reduce((date, row) => row.navDate > date ? row.navDate : date, state.baseline);
  if (throughDate < latestRecorded) throw new Error(`截止日期不能早于已入账日期 ${latestRecorded}`);
  state.baseline = throughDate;
  Object.assign(fm, dcaStateChanges(state));
  // The real snapshot may contain different subscriptions; do not reuse stale daily shares.
  fm["最近定投份额"] = 0;
  fm["持仓校准日期"] = throughDate;
}

module.exports = { validDcaSchedule, dcaToday, dcaNextDate, dcaDueDates, readDcaState, dcaStateChanges,
  syncDcaPlan, saveDcaPlanChange, prepareDca, calibrateDca };
