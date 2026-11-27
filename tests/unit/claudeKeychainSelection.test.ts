import { describe, expect, it } from "vitest";
import { pickFreshestClaudeCredential } from "../../src/main/platform/claudeKeychainSelection";

const now = Date.parse("2026-11-27T12:00:00.000Z");

describe("Claude 키체인 자격 증명 선택", () => {
  it("만료된 항목이 먼저 나와도 아직 유효한 토큰을 고른다", () => {
    expect(pickFreshestClaudeCredential([
      { value: "stale", expiresAt: Date.parse("2026-07-19T08:10:38.000Z") },
      { value: "fresh", expiresAt: Date.parse("2026-11-27T20:28:44.000Z") }
    ], now)).toBe("fresh");
  });

  it("유효한 토큰이 여럿이면 가장 늦게 만료되는 것을 고른다", () => {
    expect(pickFreshestClaudeCredential([
      { value: "sooner", expiresAt: now + 60_000 },
      { value: "later", expiresAt: String(now + 120_000) },
      { value: "iso", expiresAt: new Date(now + 90_000).toISOString() }
    ], now)).toBe("later");
  });

  it("만료 시각을 모르는 항목은 유효한 항목보다 뒤, 만료된 항목보다 앞에 둔다", () => {
    expect(pickFreshestClaudeCredential([{ value: "unknown" }, { value: "valid", expiresAt: now + 1 }], now)).toBe("valid");
    expect(pickFreshestClaudeCredential([{ value: "expired", expiresAt: now - 1 }, { value: "unknown" }], now)).toBe("unknown");
  });

  it("우열이 없으면 기존 순서를 유지하고, 후보가 없으면 null을 돌려준다", () => {
    expect(pickFreshestClaudeCredential([{ value: "first" }, { value: "second" }], now)).toBe("first");
    expect(pickFreshestClaudeCredential([], now)).toBeNull();
  });
});
