// Синхронизировано с apps/web/src/lib/crewRates.ts

export type RoleId = "GAFFER" | "KEY_GRIP" | "BEST_BOY" | "PROGRAMMER" | "GRIP";

export type OvertimeTiers = {
  tier1: number;
  tier2: number;
  tier3: number;
};

export type RoleConfig = {
  id: RoleId;
  label: string;
  shiftRate: number;
  overtime: OvertimeTiers;
};

export const BASE_SHIFT_HOURS = 10;
export const OT_TIER1_MAX = 8;
export const OT_TIER2_MAX = 14;

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

export const ROLES_BY_ID: Readonly<Record<RoleId, RoleConfig>> = Object.fromEntries(
  ROLES.map((r) => [r.id, r]),
) as Record<RoleId, RoleConfig>;
