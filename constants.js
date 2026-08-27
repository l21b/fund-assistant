const FUND_GROUPS = [
  { name: "国债", color: "#df5c59", target: 100 / 3 },
  { name: "标普500", color: "#45a97b", target: 50 / 3 },
  { name: "纳斯达克100", color: "#4f86e8", target: 50 / 3 },
  { name: "黄金", color: "#d5a936", target: 100 / 3 },
];

const GROUP_COLORS = Object.fromEntries(FUND_GROUPS.map((group) => [group.name, group.color]));
GROUP_COLORS["未分类"] = "#87909f";
const AUTO_GROUP_COLORS = [
  "#8b6fd6", "#36a2ae", "#e4874b", "#b9678f", "#6f9e45", "#5877c9",
  "#c26b5a", "#4f9a82", "#a8793d", "#7b78ba", "#3f91b8", "#b66f39",
];

function groupColor(name) {
  const normalized = String(name || "未分类").trim() || "未分类";
  if (GROUP_COLORS[normalized]) return GROUP_COLORS[normalized];
  let hash = 2166136261;
  for (const character of normalized) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return AUTO_GROUP_COLORS[(hash >>> 0) % AUTO_GROUP_COLORS.length];
}

module.exports = { FUND_GROUPS, GROUP_COLORS, groupColor };
