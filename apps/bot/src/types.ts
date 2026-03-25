import type { Scenes } from "telegraf";

export type EquipmentItem = {
  equipmentId: string;
  category: string;
  name: string;
  brand: string | null;
  model: string | null;
  stockTrackingMode: "COUNT" | "UNIT";
  totalQuantity: number;
  availableQuantity: number;
  rentalRatePerShift: string;
};

export type MatchedItem = {
  equipmentId: string;
  name: string;
  category: string;
  quantity: number;
  rentalRatePerShift: string;
  availableQuantity: number;
};

/** Промежуточное состояние сессии при создании брони */
export type BookingDraft = {
  step:
    | "client"
    | "project"
    | "dates"
    | "equipment"
    | "confirm";
  clientName?: string;
  projectName?: string;
  /** Строка, введённая пользователем (для уточнений) */
  rawDates?: string;
  startDate?: string; // ISO
  endDate?: string;   // ISO
  /** Исходный текст запроса оборудования */
  rawEquipment?: string;
  items?: MatchedItem[];
  comment?: string;
};

export type BotContext = Scenes.SceneContext;
