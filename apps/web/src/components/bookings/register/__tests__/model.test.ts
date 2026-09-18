import { describe, it, expect } from "vitest";
import {
  registerParams,
  requestParams,
  parseSavedViews,
  registerDate,
} from "../model";
describe("Register navigation", () => {
  it("retains supported equipment issue filters in URLs and saved views", () => {
    for (const issue of ["open", "missing", "damage", "waiting", "overdue", "history"]) {
      const p = registerParams(new URLSearchParams(`scope=all&issue=${issue}`));
      expect(requestParams(p).get("issue")).toBe(issue);
      const [saved] = parseSavedViews(JSON.stringify([{id:"qa",name:"Проблемы",query:p.toString()}]));
      expect(registerParams(new URLSearchParams(saved.query)).get("issue")).toBe(issue);
    }
    expect(registerParams(new URLSearchParams("issue=invalid")).has("issue")).toBe(false);
  });
  it("preserves legacy finance and status links without hiding completed payments", () => {
    const p = registerParams(
      new URLSearchParams("paid=PAID&status=RETURNED&from=2026-01-01"),
    );
    expect(p.get("payment")).toBe("paid");
    expect(p.get("scope")).toBe("all");
    expect(p.get("status")).toBe("RETURNED");
  });
  it("discards unsupported values and client-only settings from API requests", () => {
    const p = registerParams(
      new URLSearchParams(
        "scope=bad&sort=bad&mode=no&columns=expanded&view=board&status=BAD,ISSUED",
      ),
    );
    expect(p.get("scope")).toBe("all");
    expect(p.get("sort")).toBe("startDate");
    expect(p.get("status")).toBe("ISSUED");
    const q = requestParams(p);
    expect(q.has("view")).toBe(false);
    expect(q.has("columns")).toBe(false);
    expect(q.get("limit")).toBe("200");
  });
  it("tolerates corrupt browser storage and bounds personal views", () => {
    expect(parseSavedViews("{bad")).toEqual([]);
    expect(parseSavedViews('[{"name":3}]')).toEqual([]);
    expect(
      parseSavedViews(
        JSON.stringify(
          Array.from({ length: 20 }, (_, i) => ({
            id: String(i),
            name: "View",
            query: "scope=unpaid",
          })),
        ),
      ),
    ).toHaveLength(12);
  });
  it("always formats calendar dates and hours in Moscow", () => {
    expect(registerDate("2026-09-17T23:30:00Z", true)).toMatch(/18.*02:30/);
    expect(registerDate("2026-09-17")).toMatch(/17/);
  });
});
