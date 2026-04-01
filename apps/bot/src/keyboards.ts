import { Markup } from "telegraf";

/** Подпись кнопки и `bot.hears` — должны совпадать */
export const BTN_AI_LIGHTING_ANALYSIS = "✨ AI анализ освещений";

/** Главное меню бота */
export const mainMenuKeyboard = Markup.keyboard([
  ["🎬 Аренда оборудования", "💡 Калькулятор осветителей"],
  [BTN_AI_LIGHTING_ANALYSIS],
]).resize();

/** Inline-кнопки под результатом анализа фото */
export const photoAnalysisResultKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("💰 Рассчитать смету", "photo_analysis:estimate")],
  [
    Markup.button.callback("💸 Сделать дешевле", "photo_analysis:cheaper"),
    Markup.button.callback("⭐️ Премиум", "photo_analysis:premium"),
  ],
  [Markup.button.callback("📋 Оставить заявку", "photo_analysis:book")],
]);

/** Inline-кнопка под детализацией сметы / режимами */
export const photoAnalysisEstimateKeyboard = Markup.inlineKeyboard([
  [Markup.button.callback("📋 Оставить заявку", "photo_analysis:book")],
]);
