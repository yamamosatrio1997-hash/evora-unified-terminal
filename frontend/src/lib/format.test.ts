import { describe, expect, it } from "vitest";
import { age, num, pct, ts } from "./format";

describe("format", () => {
  it("never renders fabricated values for missing data", () => {
    expect(num(null)).toBe("—");
    expect(num(undefined)).toBe("—");
    expect(num("not-a-number")).toBe("—");
    expect(pct(null)).toBe("—");
    expect(ts(null)).toBe("—");
    expect(age(undefined)).toBe("—");
  });
  it("formats numbers and percentages", () => {
    expect(num("1234.5")).toBe("1,234.50");
    expect(pct(0.0312)).toBe("3.12%");
    expect(pct("0.5", 0)).toBe("50%");
    expect(ts("2026-01-02T03:04:05Z")).toBe("2026-01-02 03:04 UTC");
    expect(age(30)).toBe("30s");
    expect(age(7200)).toBe("2h");
  });
});
