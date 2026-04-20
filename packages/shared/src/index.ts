// ─── crewRates ────────────────────────────────────────────────────────────────
export {
  BASE_SHIFT_HOURS,
  OT_TIER1_MAX,
  OT_TIER2_MAX,
  ROLES,
  ROLES_BY_ID,
} from "./crewRates";
export type { RoleId, RoleConfig, OvertimeTiers } from "./crewRates";

// ─── rateCards ────────────────────────────────────────────────────────────────
export {
  RATE_CARDS,
  getRateCard,
  listPositions,
  progressiveOtCost,
} from "./rateCards";
export type {
  RateCardId,
  RateCardPositionKey,
  RateCardPositionData,
  RateCard,
} from "./rateCards";

// ─── crewCalculator ───────────────────────────────────────────────────────────
export {
  splitHours,
  calcPersonCost,
  calculateCrewCost,
} from "./crewCalculator";
export type { CrewInput, RoleBreakdown, CalculationResult } from "./crewCalculator";
