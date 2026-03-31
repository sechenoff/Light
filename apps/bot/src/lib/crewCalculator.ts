// Синхронизировано с apps/web/src/lib/crewCalculator.ts

import {
  type RoleId,
  type RoleConfig,
  BASE_SHIFT_HOURS,
  OT_TIER1_MAX,
  OT_TIER2_MAX,
  ROLES,
} from "./crewRates";

export type CrewInput = Partial<Record<RoleId, number>>;

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
  totalOvertimeCostPerPerson: number;
  totalPerPerson: number;
  totalForRole: number;
};

export type CalculationResult = {
  lines: RoleBreakdown[];
  grandTotal: number;
};

export function splitHours(totalHours: number): {
  shiftHours: number;
  ot1Hours: number;
  ot2Hours: number;
  ot3Hours: number;
} {
  if (totalHours < 0) totalHours = 0;
  const shiftHours = Math.min(totalHours, BASE_SHIFT_HOURS);
  const otHours = Math.max(0, totalHours - BASE_SHIFT_HOURS);
  const ot1Hours = Math.min(otHours, OT_TIER1_MAX);
  const ot2Hours = Math.min(Math.max(0, otHours - OT_TIER1_MAX), OT_TIER2_MAX - OT_TIER1_MAX);
  const ot3Hours = Math.max(0, otHours - OT_TIER2_MAX);
  return { shiftHours, ot1Hours, ot2Hours, ot3Hours };
}

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

export function calculateCrewCost(crew: CrewInput, hours: number | null | undefined): CalculationResult {
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

export { ROLES };
