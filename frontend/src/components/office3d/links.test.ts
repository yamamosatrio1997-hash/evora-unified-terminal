import { describe, expect, it } from "vitest";
import { linkTarget } from "./links";

describe("linkTarget", () => {
  it("uses the explicit recipient when it is a known agent", () => {
    expect(linkTarget("challenge", "flow")).toBe("flow");
  });
  it("ignores unknown recipients", () => {
    expect(linkTarget("evidence", "somebody")).toBe("table");
  });
  it("routes gate outputs to the fund manager", () => {
    for (const k of ["veto", "risk_review", "quant_validation"]) expect(linkTarget(k, null)).toBe("fund_manager");
  });
  it("sends replies without a recipient to the critic", () => {
    expect(linkTarget("reply", undefined)).toBe("critic");
  });
});
