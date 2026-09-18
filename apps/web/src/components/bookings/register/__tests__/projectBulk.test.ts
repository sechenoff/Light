import { it, expect } from "vitest";
import { BULK_ACTION_ORDER, isActionApplicable } from "../../bulkActions";
it("keeps long-project lifecycle in its operation workflow", () => {
  for (const status of [
    "DRAFT",
    "PENDING_APPROVAL",
    "CONFIRMED",
    "ISSUED",
    "RETURNED",
  ] as const)
    for (const action of BULK_ACTION_ORDER)
      expect(
        isActionApplicable(
          action,
          { id: "p", mode: "PROJECT", status, amountPaid: "0" },
          { isSuperAdmin: true, approvalMode: "auto" },
        ),
      ).toBe(false);
});
