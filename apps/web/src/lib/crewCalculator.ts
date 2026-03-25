import {
  type RoleId,
  type RoleConfig,
  BASE_SHIFT_HOURS,
  OT_TIER1_MAX,
  OT_TIER2_MAX,
  ROLES,
  ROLES_BY_ID,
} from "./crewRates";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Input: how many people per role */
export type CrewInput = Partial<Record<RoleId, number>>;

/** Detailed breakdown for a single role */
export type RoleBreakdown = {
  role: RoleId;
  label: string;
  count: number;
  hoursWorked: number;

  baseShiftCost: number;

  overtimeTier1Hours: number;
  overtimeTier1Cost: number;

  overtimeTier2Hours: number;
  overtimeTier2Cost: number;

  overtimeTier3Hours: number;
  overtimeTier3Cost: number;

  /** Sum of all overtime costs for one person */
  totalOvertimeCostPerPerson: number;

  /** Base + all overtime tiers, for one person */
  totalPerPerson: number;

  /** totalPerPerson × count, rounded to whole rubles */
  totalForRole: number;
};

/** Full calculation result */
export type CalculationResult = {
  lines: RoleBreakdown[];
  /** Sum of all roles, rounded to whole rubles */
  grandTotal: number;
};

// ─── Core helpers ─────────────────────────────────────────────────────────────

/**
 * Splits total worked hours into shift + progressive overtime tiers.
 * Returns overtime hours per tier (not cumulative — hours *within* each tier).
 *
 * Rules:
 *  - Up to BASE_SHIFT_HOURS (10h) → one full shift, no overtime
 *  - OT tier 1 : first OT_TIER1_MAX (8)  overtime hours → tier1 rate
 *  - OT tier 2 : next  (OT_TIER2_MAX - OT_TIER1_MAX) = 6 overtime hours → tier2 rate
 *  - OT tier 3 : everything beyond OT_TIER2_MAX (14) overtime hours → tier3 rate
 */
export function splitHours(totalHours: number): {
  shiftHours: number;
  ot1Hours: number;
  ot2Hours: number;
  ot3Hours: number;
} {
  if (totalHours < 0) totalHours = 0;

  // Everything up to BASE_SHIFT_HOURS is the base shift (minimum billing unit)
  const shiftHours = Math.min(totalHours, BASE_SHIFT_HOURS);
  const otHours = Math.max(0, totalHours - BASE_SHIFT_HOURS);

  const ot1Hours = Math.min(otHours, OT_TIER1_MAX);
  const ot2Hours = Math.min(Math.max(0, otHours - OT_TIER1_MAX), OT_TIER2_MAX - OT_TIER1_MAX);
  const ot3Hours = Math.max(0, otHours - OT_TIER2_MAX);

  return { shiftHours, ot1Hours, ot2Hours, ot3Hours };
}

/**
 * Calculate cost for a single person of given role working hoursWorked hours.
 * Returns the detailed breakdown and totalPerPerson (rounded to whole rubles).
 */
export function calcPersonCost(
  role: RoleConfig,
  hoursWorked: number,
): Pick<
  RoleBreakdown,
  | "baseShiftCost"
  | "overtimeTier1Hours"
  | "overtimeTier1Cost"
  | "overtimeTier2Hours"
  | "overtimeTier2Cost"
  | "overtimeTier3Hours"
  | "overtimeTier3Cost"
  | "totalOvertimeCostPerPerson"
  | "totalPerPerson"
> {
  const { ot1Hours, ot2Hours, ot3Hours } = splitHours(hoursWorked);

  const baseShiftCost = role.shiftRate;
  const overtimeTier1Cost = Math.round(ot1Hours * role.overtime.tier1);
  const overtimeTier2Cost = Math.round(ot2Hours * role.overtime.tier2);
  const overtimeTier3Cost = Math.round(ot3Hours * role.overtime.tier3);
  const totalOvertimeCostPerPerson = overtimeTier1Cost + overtimeTier2Cost + overtimeTier3Cost;
  const totalPerPerson = baseShiftCost + totalOvertimeCostPerPerson;

  return {
    baseShiftCost,
    overtimeTier1Hours: ot1Hours,
    overtimeTier1Cost,
    overtimeTier2Hours: ot2Hours,
    overtimeTier2Cost,
    overtimeTier3Hours: ot3Hours,
    overtimeTier3Cost,
    totalOvertimeCostPerPerson,
    totalPerPerson,
  };
}

// ─── Main calculator ──────────────────────────────────────────────────────────

/**
 * Calculate total crew cost.
 *
 * @param crew   - map of roleId → number of people (0 or absent = skip)
 * @param hours  - total working hours for the whole crew (same for everyone)
 * @returns      - detailed breakdown per role + grand total
 */
export function calculateCrewCost(
  crew: CrewInput,
  hours: number | null | undefined,
): CalculationResult {
  // Guard: no hours → return empty result
  if (hours === null || hours === undefined || !Number.isFinite(hours) || hours < 0) {
    return { lines: [], grandTotal: 0 };
  }

  const lines: RoleBreakdown[] = [];

  for (const roleCfg of ROLES) {
    const count = crew[roleCfg.id] ?? 0;
    if (!Number.isFinite(count) || count <= 0) continue;

    const perPerson = calcPersonCost(roleCfg, hours);
    const totalForRole = Math.round(perPerson.totalPerPerson * count);

    lines.push({
      role: roleCfg.id,
      label: roleCfg.label,
      count,
      hoursWorked: hours,
      ...perPerson,
      totalForRole,
    });
  }

  const grandTotal = lines.reduce((sum, l) => sum + l.totalForRole, 0);

  return { lines, grandTotal };
}

// ─── Convenience re-exports ───────────────────────────────────────────────────

export { ROLES, ROLES_BY_ID };
export type { RoleId, RoleConfig };
