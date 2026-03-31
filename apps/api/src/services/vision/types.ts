import { z } from "zod";

// ── Схемы ─────────────────────────────────────────────────────────────────────

export const ALLOWED_EQUIPMENT_CATEGORIES = [
  "Осветительные приборы",
  "Генераторы",
  "Рассеиватели и отражатели",
  "Штативы и стойки",
  "Кабели и коммутация",
  "Прочее",
] as const;

export const SuggestedEquipmentItemSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().min(1).max(10),
  category: z.string().min(1),
});

/**
 * Структурированный ответ от vision-провайдера.
 * description — вероятная реконструкция (не точные данные).
 * equipment   — предложенный минимальный сет оборудования.
 */
export const LightingAnalysisSchema = z.object({
  description: z
    .string()
    .min(10, "Описание слишком короткое")
    .max(6000, "Описание слишком длинное"),
  equipment: z
    .array(SuggestedEquipmentItemSchema)
    .min(1, "Список оборудования не может быть пустым")
    .max(30, "Слишком много позиций оборудования"),
});

// ── Типы ──────────────────────────────────────────────────────────────────────

export type SuggestedEquipmentItem = z.infer<typeof SuggestedEquipmentItemSchema>;
export type LightingAnalysis = z.infer<typeof LightingAnalysisSchema>;

/** Входные данные для vision-провайдера */
export type VisionInput = {
  imageBuffer: Buffer;
  mimeType: string;
  /** Необязательный список каталога — передаётся в промпт чтобы AI называл
   *  оборудование нашими именами и повышал процент совпадений */
  catalogHint?: { category: string; names: string[] }[];
};

/**
 * Безопасный парсинг ответа провайдера через Zod.
 * Возвращает результат или бросает z.ZodError.
 */
export function parseLightingAnalysis(raw: unknown): LightingAnalysis {
  return LightingAnalysisSchema.parse(raw);
}
