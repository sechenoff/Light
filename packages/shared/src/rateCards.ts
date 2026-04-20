/**
 * Rate cards for Gaffer CRM crew cost calculations.
 *
 * Source: user's PDFs
 *   «Изменение ставок с 1 марта 2024 года» (personal file, NOT committed)
 *   «Изменение ставок с 1 мая 2026 года»   (personal file, NOT committed)
 *
 * Validation:
 *   - `rates_2024` values match `packages/shared/src/crewRates.ts` byte-for-byte
 *     (cross-validated 2026-04-20).
 *   - `rates_2026` values are NEW — introduced in Sprint 2 of gaffer-crm-design-parity.
 *
 * OT formula matches `crewCalculator.splitHours()`:
 *   tier 1 = hours 1–8 of OT
 *   tier 2 = hours 9–14 of OT
 *   tier 3 = hour 15+ of OT
 *
 * Prototype naming convention preserved:
 *   IDs:           rates_2024 | rates_2026 | custom
 *   Position keys: snake_case (gaffer, key_grip, best_boy, programmer, grip)
 */

export type RateCardId = "rates_2024" | "rates_2026" | "custom";

export type RateCardPositionKey =
  | "gaffer"
  | "key_grip"
  | "best_boy"
  | "programmer"
  | "grip";

export type RateCardPositionData = {
  label: string;
  shiftHours: 10;
  shiftRate: number;
  ot1Rate: number;
  ot2Rate: number;
  ot3Rate: number;
};

export type RateCard = {
  id: Exclude<RateCardId, "custom">;
  label: string;
  effectiveFrom: string;
  positions: Record<RateCardPositionKey, RateCardPositionData>;
  breakRate: number;
  loadingFee: number;
  deliveryFee: number;
};

export const RATE_CARDS: Record<Exclude<RateCardId, "custom">, RateCard> = {
  rates_2024: {
    id: "rates_2024",
    label: "Тариф 2024",
    effectiveFrom: "2024-03-01",
    positions: {
      gaffer: {
        label: "Gaffer",
        shiftHours: 10,
        shiftRate: 20000,
        ot1Rate: 4000,
        ot2Rate: 8000,
        ot3Rate: 16000,
      },
      key_grip: {
        label: "Key Grip",
        shiftHours: 10,
        shiftRate: 14000,
        ot1Rate: 3200,
        ot2Rate: 6400,
        ot3Rate: 12800,
      },
      best_boy: {
        label: "Best Boy",
        shiftHours: 10,
        shiftRate: 14000,
        ot1Rate: 3200,
        ot2Rate: 6400,
        ot3Rate: 12800,
      },
      programmer: {
        label: "Programmer",
        shiftHours: 10,
        shiftRate: 15500,
        ot1Rate: 3200,
        ot2Rate: 6400,
        ot3Rate: 12800,
      },
      grip: {
        label: "Grip / Осветитель",
        shiftHours: 10,
        shiftRate: 12000,
        ot1Rate: 2600,
        ot2Rate: 5200,
        ot3Rate: 10400,
      },
    },
    breakRate: 3500,
    loadingFee: 14000,
    deliveryFee: 26000,
  },

  rates_2026: {
    id: "rates_2026",
    label: "Тариф 2026",
    effectiveFrom: "2026-05-01",
    positions: {
      gaffer: {
        label: "Gaffer",
        shiftHours: 10,
        shiftRate: 24000,
        ot1Rate: 4800,
        ot2Rate: 9600,
        ot3Rate: 19200,
      },
      key_grip: {
        label: "Key Grip",
        shiftHours: 10,
        shiftRate: 16800,
        ot1Rate: 3800,
        ot2Rate: 7600,
        ot3Rate: 15200,
      },
      best_boy: {
        label: "Best Boy",
        shiftHours: 10,
        shiftRate: 16800,
        ot1Rate: 3800,
        ot2Rate: 7600,
        ot3Rate: 15200,
      },
      programmer: {
        label: "Programmer",
        shiftHours: 10,
        shiftRate: 18600,
        ot1Rate: 3800,
        ot2Rate: 7600,
        ot3Rate: 15200,
      },
      grip: {
        label: "Grip / Осветитель",
        shiftHours: 10,
        shiftRate: 14400,
        ot1Rate: 3200,
        ot2Rate: 6400,
        ot3Rate: 12800,
      },
    },
    breakRate: 5000,
    loadingFee: 16800,
    deliveryFee: 32000,
  },
};

export function getRateCard(id: RateCardId): RateCard | null {
  if (id === "custom") return null;
  return RATE_CARDS[id as Exclude<RateCardId, "custom">] ?? null;
}

export function listPositions(
  card: RateCard,
): Array<{ key: RateCardPositionKey; label: string; data: RateCardPositionData }> {
  const order: RateCardPositionKey[] = [
    "gaffer",
    "key_grip",
    "best_boy",
    "programmer",
    "grip",
  ];
  return order.map((key) => ({
    key,
    label: card.positions[key].label,
    data: card.positions[key],
  }));
}

/**
 * Progressive overtime cost — spec-locked formula.
 *
 *  base = shifts * data.shiftRate
 *  ot   = min(totalOvertimeHours, 8)          * ot1Rate
 *       + clamp(totalOvertimeHours - 8, 0, 6) * ot2Rate
 *       + max(totalOvertimeHours - 14, 0)     * ot3Rate
 *
 * `totalOvertimeHours` is OVERTIME hours only (hours BEYOND the 10-h shift),
 * matching existing `splitHours()` behavior in `crewCalculator.ts`.
 * Clamp negative inputs to 0 before arithmetic.
 * Returns integer-rounded rubles (Math.round on ot portion; base is already integer).
 */
export function progressiveOtCost(
  card: RateCard,
  positionKey: RateCardPositionKey,
  totalOvertimeHours: number,
  shifts: number,
): { base: number; ot: number; total: number } {
  const data = card.positions[positionKey];
  const safeShifts = Math.max(0, shifts);
  const safeOt = Math.max(0, totalOvertimeHours);

  const base = safeShifts * data.shiftRate;

  const tier1 = Math.min(safeOt, 8) * data.ot1Rate;
  const tier2 = Math.min(Math.max(safeOt - 8, 0), 6) * data.ot2Rate;
  const tier3 = Math.max(safeOt - 14, 0) * data.ot3Rate;

  const ot = Math.round(tier1 + tier2 + tier3);

  return { base, ot, total: base + ot };
}
