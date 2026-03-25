// ─── Types ────────────────────────────────────────────────────────────────────

export type RoleId = "GAFFER" | "KEY_GRIP" | "BEST_BOY" | "PROGRAMMER" | "GRIP";

export type OvertimeTiers = {
  /** Hours 1–8 of overtime (rate per hour) */
  tier1: number;
  /** Hours 9–14 of overtime (rate per hour) */
  tier2: number;
  /** Hours 15+ of overtime (rate per hour) */
  tier3: number;
};

export type RoleConfig = {
  id: RoleId;
  label: string;
  /** Base shift rate — covers up to 10 hours */
  shiftRate: number;
  overtime: OvertimeTiers;
};

// ─── Config ───────────────────────────────────────────────────────────────────

/** Base shift duration in hours. Everything up to this is billed as one shift. */
export const BASE_SHIFT_HOURS = 10;

/**
 * Overtime tier boundaries (hours of overtime, not total hours).
 *   Tier 1 : OT hours  1 –  8  (up to  8 h of OT)
 *   Tier 2 : OT hours  9 – 14  (next   6 h of OT)
 *   Tier 3 : OT hours 15+      (everything beyond)
 */
export const OT_TIER1_MAX = 8;  // first 8 h of OT
export const OT_TIER2_MAX = 14; // cumulative 14 h of OT

export const ROLES: RoleConfig[] = [
  {
    id: "GAFFER",
    label: "Gaffer",
    shiftRate: 20_000,
    overtime: { tier1: 4_000, tier2: 8_000, tier3: 16_000 },
  },
  {
    id: "KEY_GRIP",
    label: "Key Grip",
    shiftRate: 14_000,
    overtime: { tier1: 3_200, tier2: 6_400, tier3: 12_800 },
  },
  {
    id: "BEST_BOY",
    label: "Best Boy",
    shiftRate: 14_000,
    overtime: { tier1: 3_200, tier2: 6_400, tier3: 12_800 },
  },
  {
    id: "PROGRAMMER",
    label: "Пультовик",
    shiftRate: 15_500,
    overtime: { tier1: 3_200, tier2: 6_400, tier3: 12_800 },
  },
  {
    id: "GRIP",
    label: "Grip / Осветитель",
    shiftRate: 12_000,
    overtime: { tier1: 2_600, tier2: 5_200, tier3: 10_400 },
  },
];

/** Quick lookup map: roleId → config */
export const ROLES_BY_ID: Readonly<Record<RoleId, RoleConfig>> = Object.fromEntries(
  ROLES.map((r) => [r.id, r]),
) as Record<RoleId, RoleConfig>;
