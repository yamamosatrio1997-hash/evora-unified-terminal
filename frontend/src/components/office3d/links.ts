const ROLES = new Set(["macro", "fundamental", "onchain", "flow", "technical", "quant", "risk", "critic", "fund_manager"]);

/** Where a debate message travels in the 3D office when it has no explicit recipient. */
export function linkTarget(kind: string, to: unknown): string {
  if (typeof to === "string" && ROLES.has(to)) return to;
  if (kind === "veto" || kind === "risk_review" || kind === "quant_validation") return "fund_manager";
  if (kind === "reply") return "critic";
  return "table";
}
