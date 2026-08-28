const GRID_LOOKBACK_DAYS = 40;
const GRID_TRIM_RATE = 0.1;
const GRID_MIN_RUNNING_DAYS = 30;
const GRID_BASE_REVIEW_RATE = 0.1;
const GRID_SPACING_OPTIONS = [2, 3, 4, 5, 6, 8, 10];
const GRID_VISIBLE_LEVELS = 5;

const gridNumber = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const gridDecimal = (value, digits = 4) => gridNumber(value).toLocaleString("zh-CN", {
  maximumFractionDigits: digits,
});
const gridDecimalPlaces = (value, maxDigits = 4) => {
  const normalized = gridNumber(value).toFixed(maxDigits).replace(/0+$/, "").replace(/\.$/, "");
  return normalized.includes(".") ? normalized.split(".")[1].length : 0;
};
const gridFixedDecimal = (value, digits = 0) => gridNumber(value).toLocaleString("zh-CN", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits,
});

function gridDateTickIndexes(pointCount, maxTicks = 5) {
  const count = Math.max(0, Math.floor(Number(pointCount) || 0));
  const limit = Math.max(1, Math.floor(Number(maxTicks) || 1));
  if (!count) return [];
  const tickCount = Math.min(count, limit);
  if (tickCount === 1) return [0];
  return [...new Set(Array.from({ length: tickCount }, (_, index) => (
    Math.round(index * (count - 1) / (tickCount - 1))
  )))];
}

function gridMarkerTooltipText({ date, state, action, position, price }) {
  return `${date}\n${state} · ${action} · ${position}\n收盘价 ${gridDecimal(price)}`;
}

function gridMarketSymbol(code) {
  const normalized = String(code || "").trim();
  if (!/^\d{6}$/.test(normalized)) throw new RangeError("参考ETF代码必须是6位数字");
  return `${/^[569]/.test(normalized) ? "sh" : "sz"}${normalized}`;
}

function parseGridKlinePayload(payload, symbol) {
  let parsed = payload;
  if (typeof payload === "string") {
    try {
      parsed = JSON.parse(payload);
    } catch {
      throw new Error("ETF历史行情格式异常");
    }
  }
  const market = parsed?.data?.[symbol];
  const source = market?.day || market?.qfqday || [];
  const unique = new Map();
  for (const row of source) {
    const date = String(row?.[0] || "");
    const close = Number(row?.[2]);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(close) && close > 0) {
      unique.set(date, { date, close });
    }
  }
  const rows = [...unique.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (rows.length < GRID_LOOKBACK_DAYS) throw new Error(`ETF历史行情不足${GRID_LOOKBACK_DAYS}个交易日`);
  return rows;
}

function parseGridQuoteText(source, expectedCode = "") {
  const match = String(source || "").match(/="([^"]*)"/);
  if (!match) throw new Error("ETF实时报价格式异常");
  const fields = match[1].split("~");
  const name = String(fields[1] || "").trim();
  const code = String(fields[2] || "").trim();
  const current = Number(fields[3]);
  const timestamp = fields.find((value) => /^\d{14}$/.test(value)) || "";
  if (!name || name.includes("\uFFFD") || !/^\d{6}$/.test(code) || !Number.isFinite(current) || current <= 0 || !timestamp) {
    throw new Error("没有获取到有效的场内ETF行情");
  }
  if (expectedCode && code !== String(expectedCode)) throw new Error("ETF行情代码不匹配");
  return {
    name,
    code,
    current,
    date: `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}`,
    time: `${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}`,
  };
}

function gridQuoteIsOfficialClose(time) {
  const normalized = String(time || "");
  return /^\d{2}:\d{2}$/.test(normalized) && normalized >= "15:00";
}

function gridOfficialRows(rows, quote) {
  const history = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row?.date || "");
    const close = Number(row?.close);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && close > 0) history.set(date, { date, close });
  }
  const quoteDate = String(quote?.date || "");
  const quotePrice = Number(quote?.current);
  const official = gridQuoteIsOfficialClose(quote?.time);
  if (/^\d{4}-\d{2}-\d{2}$/.test(quoteDate)) {
    if (official && quotePrice > 0) history.set(quoteDate, { date: quoteDate, close: quotePrice });
    else history.delete(quoteDate);
  }
  return [...history.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function gridMarketIsProvisional(rows, marketDate, marketTime) {
  const date = String(marketDate || "");
  const time = String(marketTime || "");
  const latestCloseDate = Array.isArray(rows) ? String(rows.at(-1)?.date || "") : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return date > latestCloseDate
    || (date === latestCloseDate && /^\d{2}:\d{2}$/.test(time) && !gridQuoteIsOfficialClose(time));
}

function trimmedGridMean(rows, lookback = GRID_LOOKBACK_DAYS, trimRate = GRID_TRIM_RATE) {
  const values = rows.slice(-lookback).map((row) => Number(row.close)).filter((value) => Number.isFinite(value) && value > 0);
  if (values.length < lookback) return NaN;
  values.sort((left, right) => left - right);
  const trimCount = Math.floor(values.length * trimRate);
  const kept = values.slice(trimCount, values.length - trimCount);
  return kept.length ? kept.reduce((sum, value) => sum + value, 0) / kept.length : NaN;
}

function calculateSuggestedAxis(rows, lookback = GRID_LOOKBACK_DAYS, digits = 3) {
  const mean = trimmedGridMean(rows, lookback);
  if (!Number.isFinite(mean) || mean <= 0) throw new Error(`至少需要${lookback}个交易日行情计算中轴`);
  return Number(mean.toFixed(digits));
}

function calculateSuggestedSpacing(rows, lookback = GRID_LOOKBACK_DAYS) {
  const values = rows.slice(-lookback).map((row) => Number(row.close));
  if (values.length < lookback || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error(`至少需要${lookback}个交易日行情计算建议间距`);
  }
  const returns = values.slice(1).map((value, index) => Math.log(value / values[index]));
  const ranked = returns.map((value) => ({ value, magnitude: Math.abs(value) }))
    .sort((left, right) => left.magnitude - right.magnitude);
  const trimCount = Math.floor(ranked.length * GRID_TRIM_RATE);
  const kept = ranked.slice(trimCount, ranked.length - trimCount).map((item) => item.value);
  const dailyVolatility = Math.sqrt(kept.reduce((sum, value) => sum + value * value, 0) / kept.length);
  const weeklyMovePercent = dailyVolatility * Math.sqrt(5) * 100;
  return GRID_SPACING_OPTIONS.reduce((closest, option) => (
    Math.abs(option - weeklyMovePercent) < Math.abs(closest - weeklyMovePercent) ? option : closest
  ), GRID_SPACING_OPTIONS[0]);
}

function gridLevelPrice(executionAxis, spacingPercent, side, level) {
  const axis = Number(executionAxis);
  const spacing = Number(spacingPercent);
  const step = Number(level);
  if (!Number.isFinite(axis) || axis <= 0) throw new RangeError("网格执行中轴必须大于 0");
  if (!Number.isFinite(spacing) || spacing <= 0 || spacing >= 20) {
    throw new RangeError("五档网格间距必须大于 0 且小于 20%");
  }
  if (!Number.isInteger(step) || step < 1 || step > GRID_VISIBLE_LEVELS) {
    throw new RangeError(`网格档位必须是1到${GRID_VISIBLE_LEVELS}的整数`);
  }
  if (side !== "buy" && side !== "sell") throw new RangeError("网格方向无效");
  return axis * (1 + (side === "sell" ? 1 : -1) * spacing / 100 * step);
}

function gridCycleId(referenceCode, axisDate, executionAxis, spacingPercent) {
  const code = String(referenceCode || "").trim();
  const date = String(axisDate || "").trim();
  const axis = Number(executionAxis);
  const spacing = Number(spacingPercent);
  if (!/^\d{6}$/.test(code) || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || !(axis > 0) || !(spacing > 0) || spacing >= 20) return "";
  const compact = (value, digits) => Number(value.toFixed(digits)).toString();
  return `${code}@${date}@${compact(axis, 6)}@${compact(spacing, 4)}`;
}

function calculateGridBand(executionAxis, spacingPercent, currentPrice, visibleLevels = GRID_VISIBLE_LEVELS) {
  const axis = Number(executionAxis);
  const spacing = Number(spacingPercent);
  const current = Number(currentPrice);
  if (!Number.isFinite(axis) || axis <= 0 || !Number.isFinite(current) || current <= 0) return null;
  if (!Number.isFinite(spacing) || spacing <= 0 || spacing >= 20) return null;
  if (!Number.isInteger(visibleLevels) || visibleLevels < 1) return null;
  const gap = axis * spacing / 100;
  const rawPosition = (current - axis) / gap;
  const clampedPosition = Math.min(visibleLevels, Math.max(-visibleLevels, rawPosition));
  return {
    rawPosition,
    percent: (clampedPosition + visibleLevels) / (visibleLevels * 2) * 100,
    range: rawPosition < -visibleLevels ? "below" : rawPosition > visibleLevels ? "above" : "inside",
    reachedBuy: Math.min(visibleLevels, Math.floor(Math.max(0, -rawPosition) + 1e-10)),
    reachedSell: Math.min(visibleLevels, Math.floor(Math.max(0, rawPosition) + 1e-10)),
  };
}

function gridPositionLabel(band) {
  if (!band) return "参考行情或网格配置不完整";
  const magnitude = Math.abs(band.rawPosition);
  const direction = band.rawPosition < 0 ? "买入" : "卖出";
  if (band.range !== "inside") {
    const outside = magnitude - GRID_VISIBLE_LEVELS;
    const signedPosition = `${band.rawPosition > 0 ? "+" : ""}${gridDecimal(band.rawPosition, 2)}`;
    return `已超出网格范围 · ${direction}第5格外 ${gridDecimal(outside, 2)} 格（当前位置 ${signedPosition} 格）`;
  }
  const reached = Math.floor(magnitude + 1e-10);
  const signedPosition = `${band.rawPosition > 0 ? "+" : ""}${gridDecimal(band.rawPosition, 2)}`;
  if (reached < 1) return `当前位于中轴区间 · ${signedPosition} 格`;
  return `已达到${direction}第${reached}格 · 当前位置 ${signedPosition} 格`;
}

function gridPendingAction(band, executedLevels = [], marketDate = "", today = "") {
  if (!band || Math.abs(band.rawPosition) < 1e-10) return null;
  const side = band.rawPosition < 0 ? "buy" : "sell";
  const reached = side === "buy" ? band.reachedBuy : band.reachedSell;
  const executed = new Set(executedLevels.map((item) => String(item)));
  const levels = Array.from({ length: reached }, (_, index) => index + 1)
    .filter((level) => !executed.has(`${side}-${level}`));
  if (!levels.length) return null;
  const action = side === "buy" ? "买入" : "卖出";
  const consecutive = levels.every((level, index) => index === 0 || level === levels[index - 1] + 1);
  const levelLabel = levels.length === 1
    ? `第${levels[0]}格`
    : consecutive
      ? `第${levels[0]}至第${levels.at(-1)}格`
      : `第${levels[0]}格等${levels.length}格`;
  return {
    side,
    levels,
    label: marketDate && marketDate === today ? `今日${action}` : `待确认${action}`,
    detail: `${levelLabel}待确认`,
  };
}

function gridPendingCloseAction(band, executedLevels = [], marketDate = "", today = "") {
  if (!band) return null;
  const states = new Set(Array.isArray(executedLevels) ? executedLevels.map(String) : []);
  const openBuys = Array.from({ length: GRID_VISIBLE_LEVELS }, (_, index) => GRID_VISIBLE_LEVELS - index)
    .filter((level) => states.has(`buy-${level}`) && band.rawPosition >= -(level - 1) - 1e-10);
  const openSells = Array.from({ length: GRID_VISIBLE_LEVELS }, (_, index) => GRID_VISIBLE_LEVELS - index)
    .filter((level) => states.has(`sell-${level}`) && band.rawPosition <= level - 1 + 1e-10);
  const closingSide = band.rawPosition < 0
    ? openSells.length ? "sell" : openBuys.length ? "buy" : ""
    : openBuys.length ? "buy" : openSells.length ? "sell" : "";
  const openLevel = closingSide === "buy" ? openBuys[0] : closingSide === "sell" ? openSells[0] : null;
  if (!openLevel) return null;
  const side = closingSide === "buy" ? "sell" : "buy";
  const triggerLevel = openLevel - 1;
  const isAxis = triggerLevel === 0;
  return {
    mode: "close",
    side,
    openSide: closingSide,
    openLevel,
    triggerSide: isAxis ? "axis" : closingSide,
    triggerLevel,
    isAxis,
    label: marketDate && marketDate === today ? `今日${side === "buy" ? "买入" : "卖出"}` : `待确认${side === "buy" ? "买入" : "卖出"}`,
    detail: `${isAxis ? "中轴" : `${closingSide === "buy" ? "买" : "卖"}${triggerLevel}格`}待确认`,
  };
}

function buildGridChartModel(rows, executionAxis, spacingPercent, currentPrice, currentDate, visibleLevels = GRID_VISIBLE_LEVELS) {
  const axis = Number(executionAxis);
  const spacing = Number(spacingPercent);
  if (!(axis > 0) || !(spacing > 0) || spacing >= 20) return null;
  const history = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row?.date || "");
    const close = Number(row?.close);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && close > 0) history.set(date, close);
  }
  const latestPrice = Number(currentPrice);
  const latestDate = String(currentDate || "");
  if (/^\d{4}-\d{2}-\d{2}$/.test(latestDate) && latestPrice > 0) history.set(latestDate, latestPrice);
  const points = [...history.entries()].sort(([left], [right]) => left.localeCompare(right))
    .slice(-GRID_LOOKBACK_DAYS).map(([date, close]) => ({ date, close }));
  const levels = [];
  for (let position = -visibleLevels; position <= visibleLevels; position += 1) {
    levels.push({
      position,
      side: position < 0 ? "buy" : position > 0 ? "sell" : "axis",
      level: Math.abs(position),
      price: axis * (1 + position * spacing / 100),
      label: position < 0 ? `买${Math.abs(position)}` : position > 0 ? `卖${position}` : "中轴",
    });
  }
  const values = [...levels.map((level) => level.price), ...points.map((point) => point.close)];
  if (!values.length) return null;
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const padding = Math.max((rawMax - rawMin) * 0.05, axis * 0.005);
  const min = rawMin - padding;
  const max = rawMax + padding;
  return {
    min,
    max,
    levels,
    points,
    yRatio: (value) => (max - Number(value)) / (max - min),
  };
}

function buildGridTriggerPoints(points, executionAxis, spacingPercent, visibleLevels = GRID_VISIBLE_LEVELS) {
  const axis = Number(executionAxis);
  const spacing = Number(spacingPercent);
  if (!(axis > 0) || !(spacing > 0) || spacing >= 20
    || !Number.isInteger(visibleLevels) || visibleLevels < 1) return [];
  const history = new Map();
  for (const point of Array.isArray(points) ? points : []) {
    const date = String(point?.date || "");
    const close = Number(point?.close);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date) && close > 0) history.set(date, close);
  }
  const rows = [...history.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([date, close]) => ({ date, close }));
  const levels = Array.from({ length: visibleLevels * 2 + 1 }, (_, index) => {
    const position = index - visibleLevels;
    return {
      position,
      price: axis * (1 + position * spacing / 100),
    };
  });
  const triggers = [];
  const openLevels = new Set();
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const movingDown = current.close < previous.close;
    const crossed = levels.filter((level) => movingDown
      ? previous.close > level.price && current.close <= level.price
      : previous.close < level.price && current.close >= level.price)
      .sort((left, right) => movingDown ? right.position - left.position : left.position - right.position);
    for (const level of crossed) {
      const position = level.position;
      if (movingDown) {
        if (position >= 0) {
          const closingLevel = position + 1;
          const closingKey = `sell-${closingLevel}`;
          if (closingLevel <= visibleLevels && openLevels.has(closingKey)) {
            triggers.push({ date: current.date, side: "buy", position, price: current.close, levelPrice: level.price });
            openLevels.delete(closingKey);
          }
        } else {
          const openingKey = `buy-${Math.abs(position)}`;
          if (!openLevels.has(openingKey)) {
            triggers.push({ date: current.date, side: "buy", position, price: current.close, levelPrice: level.price });
            openLevels.add(openingKey);
          }
        }
      } else if (position <= 0) {
        const closingLevel = Math.abs(position) + 1;
        const closingKey = `buy-${closingLevel}`;
        if (closingLevel <= visibleLevels && openLevels.has(closingKey)) {
          triggers.push({ date: current.date, side: "sell", position, price: current.close, levelPrice: level.price });
          openLevels.delete(closingKey);
        }
      } else {
        const openingKey = `sell-${position}`;
        if (!openLevels.has(openingKey)) {
          triggers.push({ date: current.date, side: "sell", position, price: current.close, levelPrice: level.price });
          openLevels.add(openingKey);
        }
      }
    }
  }
  return triggers;
}

function evaluateGridAxisReview({
  rows,
  executionAxis,
  suggestedAxis,
  spacingPercent,
  axisStartDate,
  currentPrice,
  executedLevels = [],
}) {
  const axis = Number(executionAxis);
  const suggested = Number(suggestedAxis);
  const spacingRate = Number(spacingPercent) / 100;
  if (!Number.isFinite(axis) || axis <= 0 || !Number.isFinite(suggested) || suggested <= 0
    || !Number.isFinite(spacingRate) || spacingRate <= 0) {
    return { status: "数据不足", deviationRate: null, thresholdRate: null, runningDays: 0, persistentDays: 0 };
  }

  const deviationRate = Math.abs(suggested - axis) / axis;
  const thresholdRate = Math.max(GRID_BASE_REVIEW_RATE, 1.5 * spacingRate);
  const runningDays = axisStartDate
    ? rows.filter((row) => row.date >= axisStartDate).length
    : 0;
  const recentSeven = rows.slice(-7);
  const firstRecentIndex = rows.length - recentSeven.length;
  const persistentDays = recentSeven.filter((_, index) => {
    const candidateRows = rows.slice(0, firstRecentIndex + index + 1);
    const candidate = trimmedGridMean(candidateRows);
    return Number.isFinite(candidate) && Math.abs(candidate - axis) / axis >= thresholdRate;
  }).length;

  const executed = new Set((Array.isArray(executedLevels) ? executedLevels : [])
    .map((item) => typeof item === "string" ? item : `${item?.side || ""}-${item?.level || ""}`)
    .filter((item) => /^(buy|sell)-[1-5]$/.test(item)));
  const buyDoneRatio = Array.from({ length: GRID_VISIBLE_LEVELS }, (_, index) => `buy-${index + 1}`)
    .filter((key) => executed.has(key)).length / GRID_VISIBLE_LEVELS;
  const sellDoneRatio = Array.from({ length: GRID_VISIBLE_LEVELS }, (_, index) => `sell-${index + 1}`)
    .filter((key) => executed.has(key)).length / GRID_VISIBLE_LEVELS;
  const maxDoneRatio = Math.max(buyDoneRatio, sellDoneRatio);

  const gap = axis * spacingRate;
  const lower = axis - gap * GRID_VISIBLE_LEVELS;
  const upper = axis + gap * GRID_VISIBLE_LEVELS;
  const lastThree = rows.slice(-3);
  const outsideBoundary = lastThree.length === 3
    && (lastThree.every((row) => row.close < lower) || lastThree.every((row) => row.close > upper));

  let status = "正常";
  if (runningDays >= GRID_MIN_RUNNING_DAYS && deviationRate >= thresholdRate && persistentDays >= 5) {
    if (suggested < axis) {
      const recentFiveStart = Math.max(0, rows.length - 5);
      const madeNewLow = rows.slice(recentFiveStart).some((row, index) => {
        const absoluteIndex = recentFiveStart + index;
        const previous = rows.slice(Math.max(0, absoluteIndex - 20), absoluteIndex);
        return previous.length > 0 && row.close <= Math.min(...previous.map((item) => item.close));
      });
      const ma5Now = rows.slice(-5).reduce((sum, row) => sum + row.close, 0) / Math.min(5, rows.length);
      const previousFive = rows.slice(-10, -5);
      const ma5Past = previousFive.length
        ? previousFive.reduce((sum, row) => sum + row.close, 0) / previousFive.length
        : ma5Now;
      const threeValues = lastThree.map((row) => row.close);
      const threeMean = threeValues.reduce((sum, value) => sum + value, 0) / Math.max(1, threeValues.length);
      const sideways = threeValues.length === 3 && (Math.max(...threeValues) - Math.min(...threeValues)) / threeMean <= 0.02;
      const latest = rows.at(-1)?.close || Number(currentPrice);
      status = madeNewLow || ma5Now < ma5Past || (latest < ma5Now && !sideways) ? "暂缓换轴" : "建议换轴";
    } else if (suggested > axis && Math.abs(Number(currentPrice) - suggested) / suggested > spacingRate) {
      status = "暂缓换轴";
    } else {
      status = "建议换轴";
    }
  } else if (deviationRate >= thresholdRate * 0.75 || maxDoneRatio >= 0.75 || outsideBoundary) {
    status = "关注";
  }

  return {
    status,
    deviationRate,
    thresholdRate,
    runningDays,
    persistentDays,
    maxDoneRatio,
    minRunningDays: GRID_MIN_RUNNING_DAYS,
  };
}

function renderGridOverview(plugin, element) {
  const strategies = plugin.getFundRecords().filter((fund) => fund.gridEnabled).map((fund) => {
    const executionAxis = gridNumber(fund.gridExecutionAxis);
    const spacing = gridNumber(fund.gridSpacing);
    const currentPrice = gridNumber(fund.gridCurrentPrice);
    const rows = typeof plugin.getGridHistory === "function" ? plugin.getGridHistory(fund.gridReferenceCode) : [];
    return {
      fund,
      executionAxis,
      suggestedAxis: gridNumber(fund.gridSuggestedAxis),
      suggestedSpacing: gridNumber(fund.gridSuggestedSpacing),
      spacing,
      currentPrice,
      cycleId: gridCycleId(fund.gridReferenceCode, fund.gridAxisDate, executionAxis, spacing),
      rows,
      provisional: gridMarketIsProvisional(rows, fund.gridMarketDate, fund.gridMarketTime),
      band: calculateGridBand(executionAxis, spacing, currentPrice),
      executions: typeof plugin.getGridExecutionsFor === "function" ? plugin.getGridExecutionsFor(fund) : [],
      trades: typeof plugin.getGridTradeRecordsFor === "function" ? plugin.getGridTradeRecordsFor(fund) : [],
    };
  }).sort((left, right) => left.fund.name.localeCompare(right.fund.name, "zh-CN"));

  const root = element.createDiv({ cls: "fund-grid-overview" });
  const header = root.createDiv({ cls: "fund-grid-head" });
  const heading = header.createDiv();
  heading.createEl("h1", { text: "网格策略" });
  const latestMarketDate = strategies.map((strategy) => strategy.fund.gridMarketDate)
    .filter(Boolean)
    .sort()
    .at(-1);
  heading.createEl("span", { text: latestMarketDate ? `更新于 ${latestMarketDate}` : "尚未更新" });
  const actions = header.createDiv({ cls: "fund-grid-actions" });
  const addButton = actions.createEl("button", { text: "添加策略" });
  addButton.addEventListener("click", () => plugin.openGridStrategyModal());
  const refreshButton = actions.createEl("button", { cls: "mod-cta", text: "更新行情" });
  refreshButton.addEventListener("click", async () => {
    refreshButton.disabled = true;
    refreshButton.setText("正在更新…");
    try {
      await plugin.refreshGridStrategies(true);
    } finally {
      refreshButton.disabled = false;
      refreshButton.setText("更新行情");
    }
  });

  if (!strategies.length) {
    const empty = root.createDiv({ cls: "fund-grid-empty" });
    empty.createEl("strong", { text: "还没有网格策略" });
    empty.createEl("span", { text: "选择一只已有基金，并填写用于实时判断的参考ETF代码。" });
    const emptyButton = empty.createEl("button", { text: "添加第一个策略" });
    emptyButton.addEventListener("click", () => plugin.openGridStrategyModal());
    return;
  }

  const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  for (const strategy of strategies) {
    const executedKeys = strategy.executions.map((record) => `${record.side}-${record.level}`);
    const pendingClose = gridPendingCloseAction(
      strategy.band,
      executedKeys,
      strategy.fund.gridMarketDate,
      today,
    );
    strategy.action = pendingClose || gridPendingAction(
      strategy.band,
      executedKeys,
      strategy.fund.gridMarketDate,
      today,
    );
  }

  const selectedCode = String(plugin.settings?.selectedGridFundCode || "");
  const selectedStrategy = strategies.find((strategy) => strategy.fund.code === selectedCode) || strategies[0];
  const tabs = root.createDiv({ cls: "fund-grid-tabs", attr: { role: "tablist", "aria-label": "选择网格基金" } });
  for (const strategy of strategies) {
    const actionSide = strategy.action?.side || "";
    const actionPrefix = strategy.provisional ? "临时" : "今日";
    const active = strategy.fund.code === selectedStrategy.fund.code;
    const tab = tabs.createEl("button", {
      cls: `fund-grid-tab${active ? " is-active" : ""}${actionSide ? ` has-action is-${actionSide}` : ""}`,
      attr: {
        type: "button",
        role: "tab",
        "aria-selected": String(active),
        "aria-label": `${strategy.fund.name}${actionSide ? `，${actionPrefix}${actionSide === "buy" ? "买入" : "卖出"}` : ""}`,
      },
    });
    tab.style.setProperty("--grid-tab-color", plugin.getGroupDefinition(strategy.fund.group).color);
    tab.createSpan({ text: strategy.fund.name });
    if (actionSide) tab.createSpan({ cls: "fund-grid-tab-status", attr: { "aria-hidden": "true" } });
    tab.addEventListener("click", () => {
      if (!active && typeof plugin.selectGridFund === "function") plugin.selectGridFund(strategy.fund.code);
    });
  }

  {
    const strategy = selectedStrategy;
    const card = root.createDiv({ cls: "fund-grid-card is-enabled" });
    card.style.setProperty("--grid-group-color", plugin.getGroupDefinition(strategy.fund.group).color);
    const cardHead = card.createDiv({ cls: "fund-grid-card-head" });
    const identity = cardHead.createDiv({ cls: "fund-grid-identity" });
    identity.createEl("strong", { text: strategy.fund.name });
    const meta = identity.createDiv({ cls: "fund-grid-identity-meta" });
    meta.createSpan({ text: strategy.fund.code });
    meta.createSpan({ cls: "fund-grid-group", text: strategy.fund.group });
    const reference = identity.createDiv({ cls: "fund-grid-reference" });
    reference.createSpan({ text: strategy.fund.gridReferenceCode
      ? `参考 ${strategy.fund.gridReferenceName || "场内ETF"} · ${strategy.fund.gridReferenceCode}`
      : "需要设置参考ETF代码" });
    const cardActions = cardHead.createDiv({ cls: "fund-grid-card-actions" });
    if (strategy.fund.gridAxisStatus) {
      const statusClass = strategy.fund.gridAxisStatus === "建议换轴"
        ? "replace"
        : strategy.fund.gridAxisStatus === "暂缓换轴"
          ? "paused"
          : strategy.fund.gridAxisStatus === "关注"
            ? "watch"
            : strategy.fund.gridAxisStatus === "正常"
              ? "normal"
              : "unavailable";
      cardActions.createSpan({
        cls: `fund-grid-axis-status is-${statusClass}`,
        text: `中轴 · ${strategy.fund.gridAxisStatus}`,
        attr: { "aria-label": `中轴状态：${strategy.fund.gridAxisStatus}` },
      });
    }
    const settingsButton = cardActions.createEl("button", { text: "设置", attr: { "aria-label": "设置网格策略" } });
    settingsButton.addEventListener("click", () => plugin.openGridStrategyModal(strategy.fund.file));

    const action = strategy.action;
    const actionSide = action?.side || "";
    const actionLevel = action?.mode === "close" ? action.triggerLevel : action?.levels?.[0] || null;
    const actionPrice = action && strategy.currentPrice > 0 ? strategy.currentPrice : null;
    const actionPosition = action?.mode === "close"
      ? action.isAxis ? 0 : (action.triggerSide === "buy" ? -1 : 1) * Number(action.triggerLevel)
      : actionSide && actionLevel ? (actionSide === "buy" ? -1 : 1) * Number(actionLevel) : null;
    const summary = card.createDiv({ cls: "fund-grid-summary" });
    const addSummary = (label, value, tone = "") => {
      const item = summary.createDiv({ cls: "fund-grid-summary-item is-centered" });
      item.createSpan({ text: label });
      item.createEl("b", { cls: tone, text: value });
    };
    const addPairedSummary = (leftLabel, leftValue, rightLabel, rightValue) => {
      const item = summary.createDiv({ cls: "fund-grid-summary-item is-paired" });
      const addMetric = (label, value) => {
        const metric = item.createDiv({ cls: "fund-grid-summary-metric" });
        metric.createSpan({ text: label });
        metric.createEl("b", { text: value });
      };
      addMetric(leftLabel, leftValue);
      addMetric(rightLabel, rightValue);
    };
    addSummary(
      "建议",
      action ? `${strategy.provisional ? "临时" : "今日"}${actionSide === "buy" ? "买入" : "卖出"}` : "无需操作",
      action ? actionSide === "buy" ? "negative" : "positive" : "",
    );
    addSummary("参考现价", strategy.currentPrice > 0 ? gridDecimal(strategy.currentPrice) : "--");
    const axisDigits = Math.max(
      gridDecimalPlaces(strategy.executionAxis, 4),
      gridDecimalPlaces(strategy.suggestedAxis, 4),
    );
    addPairedSummary(
      "执行中轴",
      strategy.executionAxis > 0 ? gridFixedDecimal(strategy.executionAxis, axisDigits) : "--",
      "建议中轴",
      strategy.suggestedAxis > 0 ? gridFixedDecimal(strategy.suggestedAxis, axisDigits) : "--",
    );
    const spacingDigits = Math.max(
      gridDecimalPlaces(strategy.spacing, 2),
      gridDecimalPlaces(strategy.suggestedSpacing, 2),
    );
    addPairedSummary(
      "网格间距",
      strategy.spacing > 0 ? `${gridFixedDecimal(strategy.spacing, spacingDigits)}%` : "--",
      "建议网格",
      strategy.suggestedSpacing > 0 ? `${gridFixedDecimal(strategy.suggestedSpacing, spacingDigits)}%` : "--",
    );

    const chart = card.createDiv({ cls: "fund-grid-chart" });
    const chartHead = chart.createDiv({ cls: "fund-grid-chart-head" });
    chartHead.createEl("strong", { text: "行情网格" });
    chartHead.createSpan({ text: `近${GRID_LOOKBACK_DAYS}个交易日` });
    const model = buildGridChartModel(
      strategy.rows,
      strategy.executionAxis,
      strategy.spacing,
      0,
      "",
    );
    if (!model) {
      chart.createDiv({ cls: "fund-grid-chart-empty", text: "更新行情后显示网格图" });
      return;
    }
    const svgNamespace = "http://www.w3.org/2000/svg";
    const width = 1000;
    const height = 540;
    const margin = { top: 24, right: 92, bottom: 54, left: 72 };
    const plotWidth = width - margin.left - margin.right;
    const plotHeight = height - margin.top - margin.bottom;
    const xOf = (index) => margin.left + (model.points.length <= 1 ? plotWidth : index / (model.points.length - 1) * plotWidth);
    const yOf = (value) => margin.top + model.yRatio(value) * plotHeight;
    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${strategy.fund.name}真实行情网格图`);
    const appendSvg = (tag, attributes = {}, text = "") => {
      const node = document.createElementNS(svgNamespace, tag);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      if (text) node.textContent = text;
      svg.appendChild(node);
      return node;
    };
    const markerTooltip = chart.createDiv({ cls: "fund-grid-chart-tooltip" });
    const positionMarkerTooltip = (clientX, clientY) => {
      const bounds = chart.getBoundingClientRect();
      const offset = 14;
      const visibleLeft = chart.scrollLeft + 8;
      const visibleTop = chart.scrollTop + 8;
      const visibleRight = chart.scrollLeft + chart.clientWidth - markerTooltip.offsetWidth - 8;
      const visibleBottom = chart.scrollTop + chart.clientHeight - markerTooltip.offsetHeight - 8;
      let left = clientX - bounds.left + chart.scrollLeft + offset;
      let top = clientY - bounds.top + chart.scrollTop + offset;
      if (left > visibleRight) left = clientX - bounds.left + chart.scrollLeft - markerTooltip.offsetWidth - offset;
      if (top > visibleBottom) top = clientY - bounds.top + chart.scrollTop - markerTooltip.offsetHeight - offset;
      markerTooltip.style.left = `${Math.max(visibleLeft, left)}px`;
      markerTooltip.style.top = `${Math.max(visibleTop, top)}px`;
    };
    const showMarkerTooltip = (text, clientX, clientY) => {
      markerTooltip.setText(text);
      markerTooltip.addClass("is-visible");
      positionMarkerTooltip(clientX, clientY);
    };
    const hideMarkerTooltip = () => markerTooltip.removeClass("is-visible");
    for (const level of [...model.levels].reverse()) {
      const y = yOf(level.price);
      appendSvg("line", {
        x1: margin.left,
        x2: width - margin.right,
        y1: y,
        y2: y,
        class: `fund-grid-chart-level is-${level.side}`,
      });
      appendSvg("text", { x: margin.left - 8, y: y + 4, "text-anchor": "end", class: `fund-grid-chart-label is-${level.side}` }, level.label);
      appendSvg("text", { x: width - margin.right + 8, y: y + 4, class: "fund-grid-chart-price-label" }, gridDecimal(level.price));
    }
    if (model.points.length) {
      const tickIndexes = gridDateTickIndexes(model.points.length);
      for (const index of tickIndexes) {
        appendSvg("line", {
          x1: xOf(index),
          x2: xOf(index),
          y1: margin.top,
          y2: height - margin.bottom,
          class: "fund-grid-chart-date-grid",
        });
      }
      const path = model.points.map((point, index) => `${index ? "L" : "M"}${xOf(index).toFixed(2)},${yOf(point.close).toFixed(2)}`).join(" ");
      appendSvg("path", { d: path, class: "fund-grid-chart-line" });
      for (const index of tickIndexes) {
        const point = model.points[index];
        appendSvg("text", { x: xOf(index), y: height - 14, "text-anchor": index === 0 ? "start" : index === model.points.length - 1 ? "end" : "middle", class: "fund-grid-chart-date" }, point.date.slice(5));
      }
      const latest = model.points.at(-1);
      appendSvg("circle", { cx: xOf(model.points.length - 1), cy: yOf(latest.close), r: 5.5, class: "fund-grid-chart-current" });
    }
    const pointIndexByDate = new Map(model.points.map((point, index) => [point.date, index]));
    const markerKey = (cycleId, date, side, position) => `${cycleId}|${date}|${side}|${position}`;
    const markers = new Map();
    for (const trigger of buildGridTriggerPoints(model.points, strategy.executionAxis, strategy.spacing)) {
      const key = markerKey(strategy.cycleId, trigger.date, trigger.side, trigger.position);
      markers.set(key, { ...trigger, cycleId: strategy.cycleId, record: null, recordIndex: -1 });
    }
    if (!strategy.provisional && action && Number.isFinite(actionPrice) && Number.isInteger(actionPosition)) {
      const key = markerKey(strategy.cycleId, strategy.fund.gridMarketDate, actionSide, actionPosition);
      if (!markers.has(key)) {
        markers.set(key, {
          date: strategy.fund.gridMarketDate,
          side: actionSide,
          position: actionPosition,
          price: actionPrice,
          cycleId: strategy.cycleId,
          record: null,
          recordIndex: -1,
        });
      }
    }
    for (const [recordIndex, trade] of strategy.trades.entries()) {
      const key = markerKey(trade.cycleId, trade.date, trade.side, trade.position);
      const marker = markers.get(key) || {
        date: trade.date,
        side: trade.side,
        position: trade.position,
        price: trade.price,
        cycleId: trade.cycleId,
      };
      markers.set(key, { ...marker, price: trade.price, record: trade, recordIndex });
    }
    for (const markerData of markers.values()) {
      const pointIndex = pointIndexByDate.get(markerData.date);
      if (pointIndex === undefined || !(markerData.price > 0)) continue;
      const trade = markerData.record;
      const canceled = Boolean(trade?.canceled);
      const recorded = Boolean(trade?.raw);
      const positionLabel = markerData.position === 0
        ? "中轴"
        : `${markerData.position < 0 ? "买" : "卖"}${Math.abs(markerData.position)}`;
      const actionLabel = markerData.side === "buy" ? "买入" : "卖出";
      const stateLabel = recorded ? canceled ? "已取消" : "已执行" : "已触发";
      const marker = appendSvg("circle", {
        cx: xOf(pointIndex),
        cy: yOf(markerData.price),
        r: 9,
        class: `fund-grid-chart-trade is-${markerData.side}${canceled ? " is-canceled" : recorded ? "" : " is-opportunity"} is-clickable`,
        tabindex: 0,
        role: "button",
        "aria-label": recorded
          ? canceled
            ? `${markerData.date}${actionLabel}${positionLabel}记录已取消，点击恢复`
            : `${markerData.date}已${actionLabel}${positionLabel}，点击取消记录`
          : `${markerData.date}曾触发${actionLabel}${positionLabel}，点击记录`,
      });
      const tooltipText = gridMarkerTooltipText({
        date: markerData.date,
        state: stateLabel,
        action: actionLabel,
        position: positionLabel,
        price: markerData.price,
      });
      marker.addEventListener("pointerenter", (event) => showMarkerTooltip(tooltipText, event.clientX, event.clientY));
      marker.addEventListener("pointermove", (event) => positionMarkerTooltip(event.clientX, event.clientY));
      marker.addEventListener("pointerleave", hideMarkerTooltip);
      marker.addEventListener("focus", () => {
        const bounds = marker.getBoundingClientRect();
        showMarkerTooltip(tooltipText, bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
      });
      marker.addEventListener("blur", hideMarkerTooltip);
      const toggleTrade = () => {
        hideMarkerTooltip();
        plugin.requestGridExecution(recorded ? {
          fund: strategy.fund,
          mode: canceled ? "restore-trade" : "cancel-trade",
          side: markerData.side,
          levelPrice: markerData.price,
          tradeIndex: markerData.recordIndex,
          tradeRaw: trade.raw,
          tradePosition: markerData.position,
          tradeDate: markerData.date,
          tradeCycleId: markerData.cycleId,
        } : {
          fund: strategy.fund,
          mode: "record-trade",
          side: markerData.side,
          levelPrice: markerData.price,
          tradePosition: markerData.position,
          tradeDate: markerData.date,
          tradeCycleId: markerData.cycleId,
        });
      };
      marker.addEventListener("click", toggleTrade);
      marker.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleTrade();
        }
      });
    }
    chart.appendChild(svg);
  }
}

module.exports = {
  GRID_LOOKBACK_DAYS,
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
  gridMarketIsProvisional,
  gridMarkerTooltipText,
  gridMarketSymbol,
  gridLevelPrice,
  gridOfficialRows,
  gridPendingAction,
  gridPendingCloseAction,
  gridPositionLabel,
  parseGridKlinePayload,
  parseGridQuoteText,
  gridQuoteIsOfficialClose,
  renderGridOverview,
  trimmedGridMean,
};
