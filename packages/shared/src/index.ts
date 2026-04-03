// ─── crewRates ────────────────────────────────────────────────────────────────
export {
  BASE_SHIFT_HOURS,
  OT_TIER1_MAX,
  OT_TIER2_MAX,
  ROLES,
  ROLES_BY_ID,
} from "./crewRates";
export type { RoleId, RoleConfig, OvertimeTiers } from "./crewRates";

// ─── crewCalculator ───────────────────────────────────────────────────────────
export {
  splitHours,
  calcPersonCost,
  calculateCrewCost,
} from "./crewCalculator";
export type { CrewInput, RoleBreakdown, CalculationResult } from "./crewCalculator";
