const hasFiniteValue = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

function dailyHoldingProfit(frontmatter) {
  const rawShares = frontmatter["持仓份额"];
  const rawLatestNav = frontmatter["最新净值"];
  const rawPreviousNav = frontmatter["昨日净值"];
  if (!hasFiniteValue(rawShares) || !hasFiniteValue(rawLatestNav) || !hasFiniteValue(rawPreviousNav)) return null;
  const shares = Number(rawShares);
  const latestNav = Number(rawLatestNav);
  const previousNav = Number(rawPreviousNav);
  if (!(shares >= 0) || !(latestNav > 0) || !(previousNav > 0)) return null;

  let profitShares = shares;
  if (String(frontmatter["最后定投日期"] || "") === String(frontmatter["净值日期"] || "")) {
    const recordedShares = Number(frontmatter["最近定投份额"]);
    if (hasFiniteValue(frontmatter["最近定投份额"]) && recordedShares >= 0) {
      profitShares = Math.max(0, shares - recordedShares);
    } else {
      const amount = Number(frontmatter["定投金额"]);
      const feeRate = Number(frontmatter["手续费率"] || 0);
      if (amount > 0 && feeRate >= 0 && feeRate <= 10) {
        const netAmount = amount / (1 + feeRate / 100);
        profitShares = Math.max(0, shares - netAmount / latestNav);
      }
    }
  }
  return profitShares * (latestNav - previousNav);
}

function totalHoldingCost(frontmatter) {
  const rawTotalCost = frontmatter["持仓总成本"];
  const totalCost = Number(rawTotalCost);
  if (hasFiniteValue(rawTotalCost) && totalCost >= 0) return totalCost;

  const rawShares = frontmatter["持仓份额"];
  const rawCostPrice = frontmatter["持仓成本价"];
  const shares = Number(rawShares);
  const costPrice = Number(rawCostPrice);
  if (hasFiniteValue(rawShares) && shares >= 0 && hasFiniteValue(rawCostPrice) && costPrice >= 0) {
    return shares * costPrice;
  }
  const rawLegacyTotalCost = frontmatter["持仓成本"];
  const legacyTotalCost = Number(rawLegacyTotalCost);
  return hasFiniteValue(rawLegacyTotalCost) && legacyTotalCost >= 0 ? legacyTotalCost : NaN;
}

module.exports = { dailyHoldingProfit, totalHoldingCost };
