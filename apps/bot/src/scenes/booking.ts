import { Scenes, Markup } from "telegraf";
import type { BotContext, BookingDraft, MatchedItem } from "../types";
import { parseDates, matchEquipment, parseCatalogIntent } from "../services/llm";
import type { MatchResult } from "../services/llm";
import { getAvailability, createBooking } from "../services/api";
import type { GafferReviewItem, GafferMatchCandidate } from "../services/api";
import { logError, logWarn } from "../services/logger";
import { mainMenuKeyboard } from "../keyboards";

const DISCOUNT = 0.5; // 50% скидка

/** Шаги 1–3/4: назад по шагам + отмена в главное меню */
const bookingStepNavKeyboard = Markup.keyboard([
  ["⬅️ Назад", "❌ Отмена бронирования"],
]).resize();

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmtItem(i: MatchedItem, idx?: number): string {
  const prefix = idx !== undefined ? `${idx + 1}. ` : "• ";
  return `${prefix}${i.name} × ${i.quantity} шт — ${Number(i.rentalRatePerShift).toLocaleString("ru-RU")} ₽/смена`;
}

function fmtList(items: MatchedItem[], numbered = false): string {
  return items.map((i, idx) => fmtItem(i, numbered ? idx : undefined)).join("\n");
}

function totalCost(items: MatchedItem[], start: string, end: string): number {
  const days = Math.max(
    1,
    Math.ceil((new Date(end).getTime() - new Date(start).getTime()) / 86_400_000),
  );
  return items.reduce(
    (sum, i) => sum + Number(i.rentalRatePerShift) * i.quantity * days,
    0,
  );
}

/** Строка с полной ценой и ценой со скидкой */
function fmtPrice(full: number): string {
  const discounted = Math.round(full * (1 - DISCOUNT));
  return (
    `💰 Полная стоимость: ~${full.toLocaleString("ru-RU")} ₽~\n` +
    `🏷 Со скидкой 50%: *${discounted.toLocaleString("ru-RU")} ₽*`
  );
}

/**
 * Клавиатура хаба — явный reply_markup для Telegram.
 * По одной кнопке в ряд — на узких экранах всё видно.
 */
function hubKeyboardMarkup() {
  return {
    keyboard: [
      [{ text: "➕ Добавить текстом (AI)" }],
      [{ text: "📋 Добавить из каталога" }],
      [{ text: "🗑 Удалить позицию" }],
      [{ text: "✅ Готово" }, { text: "❌ Отмена бронирования" }],
    ],
    resize_keyboard: true,
  };
}

function getState(ctx: BotContext): Partial<BookingDraft> {
  return ctx.scene.state as Partial<BookingDraft>;
}
function setState(ctx: BotContext, patch: Partial<BookingDraft>): void {
  Object.assign(ctx.scene.state, patch);
}

/** Строим MatchedItem[] из результата matchEquipment (данные каталога уже в resolved) */
function buildItems(
  resolved: Array<{ equipmentId: string; quantity: number; catalogName: string; category: string; availableQuantity: number; rentalRatePerShift: string }>,
): MatchedItem[] {
  return resolved
    .filter((i) => i.quantity > 0)
    .map((i) => ({
      equipmentId: i.equipmentId,
      name: i.catalogName,
      category: i.category,
      quantity: Math.min(i.quantity, i.availableQuantity),
      rentalRatePerShift: i.rentalRatePerShift,
      availableQuantity: i.availableQuantity,
    }));
}

/** Объединяет два списка: если equipmentId совпадает — суммирует qty */
function mergeItems(existing: MatchedItem[], incoming: MatchedItem[]): MatchedItem[] {
  const map = new Map<string, MatchedItem>(existing.map((i) => [i.equipmentId, { ...i }]));
  for (const item of incoming) {
    if (map.has(item.equipmentId)) {
      const cur = map.get(item.equipmentId)!;
      cur.quantity = Math.min(cur.quantity + item.quantity, item.availableQuantity);
    } else {
      map.set(item.equipmentId, { ...item });
    }
  }
  return Array.from(map.values());
}

/** Клавиатура подтверждения */
const confirmKeyboard = Markup.keyboard([
  ["✅ Подтвердить"],
  ["✏️ Редактировать список", "✏️ Изменить даты"],
  ["❌ Отмена бронирования"],
]).resize();

// ─── Каталог: вспомогательные функции ─────────────────────────────────────

function buildCatalogCategoriesKeyboard(categories: string[]) {
  const rows: string[][] = [["⬅️ Назад"]];
  for (let i = 0; i < categories.length; i += 2) {
    rows.push(categories.slice(i, i + 2));
  }
  rows.push(["✅ Завершить выбор"]);
  rows.push(["❌ Отмена бронирования"]);
  return Markup.keyboard(rows).resize();
}

function buildCatalogItemsKeyboard() {
  return Markup.keyboard([
    ["⬅️ Назад"],
    ["⬅️ К категориям"],
    ["✅ Завершить выбор"],
    ["❌ Отмена бронирования"],
  ]).resize();
}

async function showCatalogCategories(ctx: BotContext) {
  const s = getState(ctx);
  const categories = s.catalogCategories ?? [];
  const items = s.items ?? [];

  const currentListStr = items.length > 0
    ? `\n\n📦 *Уже выбрано:* ${items.length} позиций`
    : "";

  await ctx.reply(
    `Выберите категорию оборудования:${currentListStr}`,
    { parse_mode: "Markdown", ...buildCatalogCategoriesKeyboard(categories) },
  );
}

function formatCatalogItems(items: import("../types").EquipmentItem[]): string {
  return items
    .map((e, i) => {
      const price = Number(e.rentalRatePerShift).toLocaleString("ru-RU");
      const avail = e.availableQuantity > 0 ? `${e.availableQuantity} шт` : "нет";
      return `${i + 1}. ${e.name}${e.model ? ` ${e.model}` : ""} — *${avail}* — ${price} ₽/смена`;
    })
    .join("\n");
}

async function showCatalogCategoryItems(
  ctx: BotContext,
  category: string,
  catalog: import("../types").EquipmentItem[],
) {
  const s = getState(ctx);
  const available = catalog.filter((e) => e.category === category && e.availableQuantity > 0);
  const unavailable = catalog.filter((e) => e.category === category && e.availableQuantity === 0);

  if (available.length === 0) {
    await ctx.reply(
      `😔 В категории *${category}* нет доступного оборудования на эти даты.`,
      { parse_mode: "Markdown", ...buildCatalogCategoriesKeyboard(s.catalogCategories ?? []) },
    );
    return;
  }

  let msg = `📦 *${category}*\n\n${formatCatalogItems(available)}`;
  if (unavailable.length > 0) {
    msg += `\n\n_Недоступно: ${unavailable.map((e) => e.name).join(", ")}_`;
  }

  const cartItems = s.items ?? [];
  if (cartItems.length > 0) {
    msg += `\n\n🛒 *В списке (${cartItems.length} поз.):*\n`;
    msg += cartItems.map((i, n) => `${n + 1}. ${i.name} × ${i.quantity} шт`).join("\n");
  }

  msg += `\n\nПишите что нужно — именем, номером или произвольно.\n`;
  msg += `_Примеры: «апчур 2 штуки», «1 и 3», «два прибора», «удали нанлайт»_`;

  await ctx.reply(msg, { parse_mode: "Markdown", ...buildCatalogItemsKeyboard() });
}


export const bookingScene = new Scenes.BaseScene<BotContext>("booking");

// ── Вход в сцену ──────────────────────────────────────────────────────────────
bookingScene.enter(async (ctx) => {
  setState(ctx, { step: "client" });
  await ctx.reply(
    "📋 *Новая бронь*\n\nШаг 1/4 — Как зовут клиента?",
    { parse_mode: "Markdown", ...bookingStepNavKeyboard },
  );
});

// ── Отмена ────────────────────────────────────────────────────────────────────
bookingScene.hears("🏠 Главное меню", async (ctx) => {
  await ctx.reply("🏠 Главное меню.", { parse_mode: "Markdown", ...mainMenuKeyboard });
  await ctx.scene.leave();
});

bookingScene.command("cancel", async (ctx) => {
  await ctx.reply("❌ Создание брони отменено. Главное меню:", mainMenuKeyboard);
  await ctx.scene.leave();
});

// ── Обработчик inline-кнопок pendingReview ───────────────────────────────────
bookingScene.action(/^nr:(.+)/, async (ctx) => {
  const s = getState(ctx);
  const pending = s.pendingReview ?? [];
  const idx = s.pendingReviewIndex ?? 0;

  // Истёкший коллбэк — pendingReview пуст или индекс выходит за границы
  if (pending.length === 0 || idx >= pending.length) {
    await ctx.answerCbQuery("Время истекло");
    return;
  }

  await ctx.answerCbQuery();

  const item = pending[idx]!;
  // Нормализуем match для безопасного доступа к candidates
  const candidates: GafferMatchCandidate[] =
    item.match.kind === "needsReview" ? item.match.candidates : [];

  const data = ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : "";

  if (data === "nr:skipall") {
    setState(ctx, { pendingReview: [], pendingReviewIndex: 0 });
    await ctx.editMessageText("⏭ Пропущено: все оставшиеся");
    await showHub(ctx);
    return;
  }

  if (data === "nr:skip") {
    await ctx.editMessageText(`⏭ Пропущено: «${item.gafferPhrase}»`);
    const nextIdx = idx + 1;
    setState(ctx, { pendingReviewIndex: nextIdx });
    if (nextIdx >= pending.length) {
      setState(ctx, { pendingReview: [], pendingReviewIndex: 0 });
      await showHub(ctx);
    } else {
      await showNextReview(ctx);
    }
    return;
  }

  if (data.startsWith("nr:accept:")) {
    // Формат: nr:accept:{equipmentId}:{quantity}
    const rest = data.slice("nr:accept:".length);
    const lastColon = rest.lastIndexOf(":");
    const equipmentId = rest.slice(0, lastColon);
    const qty = parseInt(rest.slice(lastColon + 1), 10);

    // Безопасность: проверяем, что equipmentId действительно среди кандидатов
    const candidate = candidates.find((c) => c.equipmentId === equipmentId);
    if (!candidate) {
      await ctx.editMessageText("⚠️ Неверный выбор.");
      await showNextReview(ctx);
      return;
    }

    const newItem: MatchedItem = {
      equipmentId: candidate.equipmentId,
      name: candidate.catalogName,
      category: candidate.category,
      quantity: Math.min(qty > 0 ? qty : 1, candidate.availableQuantity),
      rentalRatePerShift: candidate.rentalRatePerShift,
      availableQuantity: candidate.availableQuantity,
    };

    const currentItems = s.items ?? [];
    const merged = mergeItems(currentItems, [newItem]);
    setState(ctx, { items: merged });

    await ctx.editMessageText(`✅ Добавлено: ${newItem.name} × ${newItem.quantity} шт`);

    const nextIdx = idx + 1;
    setState(ctx, { pendingReviewIndex: nextIdx });
    if (nextIdx >= pending.length) {
      setState(ctx, { pendingReview: [], pendingReviewIndex: 0 });
      await showHub(ctx);
    } else {
      await showNextReview(ctx);
    }
    return;
  }
});

// ── Главный обработчик текста ─────────────────────────────────────────────────
bookingScene.on("text", async (ctx) => {
  const s = getState(ctx);
  if (!s.step) { await ctx.scene.leave(); return; }

  const text = ctx.message.text.trim();

  // ─── Шаг 1: имя клиента ───────────────────────────────────────────────────
  if (s.step === "client") {
    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }
    if (text === "⬅️ Назад") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }
    if (text.length < 2) {
      await ctx.reply("Введите имя клиента (минимум 2 символа).", bookingStepNavKeyboard);
      return;
    }
    setState(ctx, { clientName: text, step: "project" });
    await ctx.reply(
      "Шаг 2/4 — Название проекта или съёмки?\n_(или отправьте «-» чтобы пропустить)_",
      { parse_mode: "Markdown", ...bookingStepNavKeyboard },
    );
    return;
  }

  // ─── Шаг 2: название проекта ──────────────────────────────────────────────
  if (s.step === "project") {
    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }
    if (text === "⬅️ Назад") {
      setState(ctx, { step: "client", clientName: undefined });
      await ctx.reply(
        "Шаг 1/4 — Как зовут клиента?",
        { parse_mode: "Markdown", ...bookingStepNavKeyboard },
      );
      return;
    }
    setState(ctx, { projectName: text === "-" ? "" : text, step: "dates" });
    await ctx.reply(
      "Шаг 3/4 — На какой период нужно оборудование?\n\n_Примеры:_\n• «с 10 апреля по 12 апреля»\n• «14-16 мая»\n• «20 июня, один день»",
      { parse_mode: "Markdown", ...bookingStepNavKeyboard },
    );
    return;
  }

  // ─── Шаг 3: даты ──────────────────────────────────────────────────────────
  if (s.step === "dates") {
    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }
    if (text === "⬅️ Назад") {
      setState(ctx, { step: "project" });
      await ctx.reply(
        "Шаг 2/4 — Название проекта или съёмки?\n_(или отправьте «-» чтобы пропустить)_",
        { parse_mode: "Markdown", ...bookingStepNavKeyboard },
      );
      return;
    }
    const thinking = await ctx.reply("⏳ Определяю даты…");
    const result = await parseDates(text, today());

    if ("error" in result) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        `❓ Не удалось разобрать даты: ${result.error}\n\nПопробуйте ещё раз. Например:\n«с 10 по 12 апреля»`,
      );
      await ctx.reply("Выберите действие или введите период снова.", bookingStepNavKeyboard);
      return;
    }

    setState(ctx, {
      rawDates: text,
      startDate: result.startDate,
      endDate: result.endDate,
      step: "hub",
      items: s.items ?? [],
    });

    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      `✅ Период: *${result.startDate}* — *${result.endDate}*`,
      { parse_mode: "Markdown" },
    );
    await showHub(ctx);
    return;
  }

  // ─── Шаг 4: хаб ───────────────────────────────────────────────────────────
  if (s.step === "hub") {
    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }

    // Кнопка «➕ Добавить текстом (AI)» — показываем подсказку, остаёмся на хабе
    if (text === "➕ Добавить текстом (AI)") {
      await ctx.reply(
        "Напишите что нужно — AI подберёт из каталога",
        { reply_markup: hubKeyboardMarkup() },
      );
      return;
    }

    // Кнопка «📋 Добавить из каталога»
    if (text === "📋 Добавить из каталога") {
      const thinking = await ctx.reply("⏳ Загружаю каталог…");
      try {
        const catalog = await getAvailability(s.startDate!, s.endDate!);
        const categories = Array.from(new Set(catalog.map((e) => e.category))).sort();
        setState(ctx, {
          step: "catalog",
          catalogItems: catalog,
          catalogCategories: categories,
          catalogCategory: null,
        });
        await ctx.telegram.deleteMessage(ctx.chat!.id, thinking.message_id);
        await showCatalogCategories(ctx);
      } catch (e) {
        logError("hub:catalog", "Failed to load catalog", e);
        await ctx.telegram.editMessageText(
          ctx.chat!.id, thinking.message_id, undefined,
          "⚠️ Не удалось загрузить каталог. Попробуйте позже.",
        );
      }
      return;
    }

    // Кнопка «🗑 Удалить позицию»
    if (text === "🗑 Удалить позицию") {
      const items = s.items ?? [];
      if (items.length === 0) {
        await ctx.reply("⚠️ Список пуст — нечего удалять.", { reply_markup: hubKeyboardMarkup() });
        return;
      }
      const numbered = items.map((i, n) => `${n + 1}. ${i.name} × ${i.quantity} шт`).join("\n");
      await ctx.reply(
        `Напишите номер или название позиции для удаления:\n\n${numbered}`,
        { parse_mode: "Markdown", reply_markup: hubKeyboardMarkup() },
      );
      return;
    }

    // Кнопка «✅ Готово»
    if (text === "✅ Готово") {
      const items = s.items ?? [];
      if (items.length === 0) {
        await ctx.reply(
          "⚠️ Список пуст. Добавьте хотя бы одну позицию.",
          { reply_markup: hubKeyboardMarkup() },
        );
        return;
      }
      await showConfirm(ctx);
      return;
    }

    const items = s.items ?? [];

    // Проверяем tryDeleteItems первым (до pendingReview)
    const deleteResult = tryDeleteItems(items, text);
    if (deleteResult) {
      setState(ctx, { items: deleteResult.remaining });
      const removedNames = deleteResult.removed.map((r) => `• ${r.name}`).join("\n");
      await ctx.reply(
        `🗑 Удалено:\n${removedNames}`,
        { parse_mode: "Markdown" },
      );
      await showHub(ctx);
      return;
    }

    // Явное намерение удалить, но ничего не нашли в списке
    if (DELETE_PREFIXES_RE.test(text)) {
      const query = text.replace(DELETE_STRIP_RE, "").trim();
      await ctx.reply(
        `❓ Не нашёл «${query}» в списке.\n_Напишите номер позиции или другую часть названия._`,
        { parse_mode: "Markdown", reply_markup: hubKeyboardMarkup() },
      );
      return;
    }

    // Если активен pendingReview и это не удаление — отклоняем
    if (s.pendingReview && s.pendingReview.length > 0 && (s.pendingReviewIndex ?? 0) < s.pendingReview.length) {
      await ctx.reply(
        "Ответьте на вопрос выше или нажмите кнопку.",
        { reply_markup: hubKeyboardMarkup() },
      );
      return;
    }

    // Свободный ввод — AI матчинг
    const thinking = await ctx.reply("⏳ Ищу в каталоге…");

    let matchResult: MatchResult | { error: string };
    try {
      matchResult = await matchEquipment(text);
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === "TimeoutError";
      logError("hub:matchEquipment", `LLM error for: "${text.slice(0, 120)}"`, e);
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        isTimeout
          ? "⏱ Запрос слишком долгий. Попробуйте написать короче."
          : "⚠️ Ошибка при подборе оборудования. Попробуйте позже.",
      );
      return;
    }

    if ("error" in matchResult) {
      logWarn("hub:matchEquipment", `LLM returned error: ${matchResult.error}`);
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        `❓ ${matchResult.error}\n\nПопробуйте описать оборудование иначе.`,
      );
      return;
    }

    const newItems = buildItems(matchResult.resolved);
    const merged = mergeItems(items, newItems);

    const unmatchedText = matchResult.unmatched.length > 0
      ? matchResult.unmatched.join(", ")
      : undefined;

    setState(ctx, {
      items: merged,
      pendingReview: matchResult.needsReview,
      pendingReviewIndex: 0,
    });

    // Обновляем «думающее» сообщение
    if (newItems.length > 0) {
      const added = newItems.map((i) => `• ${i.name} × ${i.quantity} шт`).join("\n");
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        `✅ Добавлено:\n${added}`,
        { parse_mode: "Markdown" },
      );
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        "❓ Ничего не удалось найти в каталоге. Попробуйте описать иначе.",
      );
    }

    await showHub(ctx, unmatchedText);
    if (matchResult.needsReview.length > 0) {
      await showNextReview(ctx);
    }
    return;
  }

  // ─── Шаг «catalog»: пошаговый выбор по каталогу ──────────────────────────
  if (s.step === "catalog") {
    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }

    if (text === "⬅️ Назад") {
      if (s.catalogCategory) {
        setState(ctx, { catalogCategory: null });
        await showCatalogCategories(ctx);
      } else {
        setState(ctx, {
          step: "hub",
          catalogItems: undefined,
          catalogCategories: undefined,
          catalogCategory: null,
        });
        await showHub(ctx);
      }
      return;
    }

    if (text === "✅ Завершить выбор") {
      const items = s.items ?? [];
      if (items.length === 0) {
        await ctx.reply("⚠️ Список пуст. Выберите хотя бы одну позицию или отмените бронь.",
          buildCatalogCategoriesKeyboard(s.catalogCategories ?? []));
        return;
      }
      setState(ctx, { step: "hub", catalogItems: undefined, catalogCategories: undefined, catalogCategory: null });
      await showHub(ctx);
      return;
    }

    if (text === "⬅️ К категориям") {
      setState(ctx, { catalogCategory: null });
      await showCatalogCategories(ctx);
      return;
    }

    const catalog = s.catalogItems ?? [];
    const categories = s.catalogCategories ?? [];

    // Если нет текущей категории — ожидаем нажатие на одну из них
    if (!s.catalogCategory) {
      if (categories.includes(text)) {
        setState(ctx, { catalogCategory: text });
        await showCatalogCategoryItems(ctx, text, catalog);
      } else {
        await showCatalogCategories(ctx);
      }
      return;
    }

    // Иначе — внутри категории, обрабатываем текст через LLM
    const availableInCategory = catalog.filter(
      (e) => e.category === s.catalogCategory && e.availableQuantity > 0,
    );
    const llmCatalogItems = availableInCategory.map((e, i) => ({
      idx: i + 1,
      name: e.name,
      model: e.model,
    }));

    const cartItems = s.items ?? [];

    // Удаление работает и в каталоге
    const deleteResult = tryDeleteItems(cartItems, text);
    if (deleteResult) {
      setState(ctx, { items: deleteResult.remaining });
      const removedNames = deleteResult.removed.map((r) => `• ${r.name}`).join("\n");
      await ctx.reply(`🗑 Удалено:\n${removedNames}`, { parse_mode: "Markdown" });
      await showCatalogCategoryItems(ctx, s.catalogCategory!, catalog);
      return;
    }

    const thinking = await ctx.reply("⏳ Обрабатываю…");
    const del = () => ctx.telegram.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});

    let intent: Awaited<ReturnType<typeof parseCatalogIntent>>;
    try {
      intent = await parseCatalogIntent(text, llmCatalogItems, cartItems);
    } catch (e) {
      logError("catalog:parseCatalogIntent", `LLM error for user input: "${text.slice(0, 100)}"`, e);
      await del();
      const isTimeout = e instanceof Error && e.name === "TimeoutError";
      await ctx.reply(
        isTimeout
          ? "⏱ Слишком долго. Попробуйте написать короче или выбрать категорию повторно."
          : "⚠️ Ошибка обработки. Попробуйте ещё раз.",
        buildCatalogItemsKeyboard(),
      );
      return;
    }
    await del();

    // Добавление
    const newItems: MatchedItem[] = [];
    const warnings: string[] = [];
    for (const { idx, qty } of intent.add) {
      const eq = availableInCategory[idx - 1];
      if (!eq) { warnings.push(`Позиция ${idx} не найдена в каталоге`); continue; }
      const capped = Math.min(Math.max(1, qty), eq.availableQuantity);
      if (capped < qty) warnings.push(`${eq.name}: доступно только ${eq.availableQuantity} шт`);
      newItems.push({
        equipmentId: eq.equipmentId,
        name: eq.name,
        category: eq.category,
        quantity: capped,
        rentalRatePerShift: eq.rentalRatePerShift,
        availableQuantity: eq.availableQuantity,
      });
    }

    // Удаление
    let remaining = mergeItems(cartItems, newItems);
    const removedNames: string[] = [];
    for (const { name: removeName } of intent.remove) {
      const lower = removeName.toLowerCase();
      const before = remaining.length;
      remaining = remaining.filter((item) => {
        const match =
          item.name.toLowerCase().includes(lower) ||
          lower.includes(item.name.toLowerCase().slice(0, 5));
        if (match) removedNames.push(item.name);
        return !match;
      });
      if (remaining.length === before) {
        warnings.push(`Не найдено в списке: «${removeName}»`);
      }
    }

    setState(ctx, { items: remaining });

    // Формируем ответ
    const parts: string[] = [];
    if (newItems.length > 0) {
      parts.push(`✅ *Добавлено:*\n${newItems.map((i) => `• ${i.name} × ${i.quantity} шт`).join("\n")}`);
    }
    if (removedNames.length > 0) {
      parts.push(`🗑 *Удалено:*\n${[...new Set(removedNames)].map((n) => `• ${n}`).join("\n")}`);
    }
    if (intent.unclear.length > 0) {
      parts.push(`❓ Не понял: _«${intent.unclear.join("», «")}»_`);
    }
    if (warnings.length > 0) {
      parts.push(`⚠️ ${warnings.join("\n")}`);
    }
    if (newItems.length === 0 && removedNames.length === 0) {
      parts.push("❓ Не удалось ничего добавить или удалить. Напишите иначе.");
    }

    if (remaining.length > 0) {
      parts.push(
        `\n🛒 *Список (${remaining.length} поз.):*\n` +
        remaining.map((i, n) => `${n + 1}. ${i.name} × ${i.quantity} шт`).join("\n"),
      );
    } else {
      parts.push("\n📋 Список пуст");
    }

    await ctx.reply(parts.join("\n\n"), { parse_mode: "Markdown", ...buildCatalogItemsKeyboard() });
    return;
  }

  // ─── Шаг 4/4: подтверждение ───────────────────────────────────────────────
  if (s.step === "confirm") {
    if (text === "✅ Подтвердить") {
      const thinking = await ctx.reply("⏳ Создаю бронь…", Markup.removeKeyboard());

      /** Удаляем «⏳» сообщение, не бросая ошибок */
      const deleteThinking = () =>
        ctx.telegram.deleteMessage(ctx.chat!.id, thinking.message_id).catch(() => {});

      try {
        const booking = await createBooking({
          clientName: s.clientName!,
          projectName: s.projectName ?? "",
          startDate: s.startDate!,
          endDate: s.endDate!,
          items: s.items!,
        });

        await deleteThinking();

        await ctx.reply(
          `✅ *Бронь создана!*\n\n` +
          `👤 Клиент: ${s.clientName}\n` +
          `🎬 Проект: ${s.projectName || "—"}\n` +
          `📅 ${s.startDate} — ${s.endDate}\n\n` +
          `📦 Оборудование:\n${fmtList(s.items!)}\n\n` +
          `_Управление бронью — в системе Light Rental._`,
          { parse_mode: "Markdown" },
        );

        const adminIds = (process.env.ADMIN_CHAT_IDS ?? "")
          .split(",").map((x) => x.trim()).filter(Boolean);
        const adminMsg =
          `🔔 *Новая бронь: ${booking.displayName}*\n` +
          `👤 ${s.clientName}\n` +
          `🎬 ${s.projectName || "—"}\n` +
          `📅 ${s.startDate} — ${s.endDate}\n` +
          `📦 ${s.items!.length} позиций\n` +
          `💰 ${totalCost(s.items!, s.startDate!, s.endDate!).toLocaleString("ru-RU")} ₽\n` +
          `_Источник: Telegram_`;
        await Promise.allSettled(
          adminIds.map((id) => ctx.telegram.sendMessage(id, adminMsg, { parse_mode: "Markdown" })),
        );

        await ctx.reply("Нажмите *🎬 Аренда оборудования* чтобы создать ещё одну.", {
          parse_mode: "Markdown",
          ...mainMenuKeyboard,
        });
        await ctx.scene.leave();
      } catch (e) {
        await deleteThinking();
        const msg = e instanceof Error ? e.message : "Неизвестная ошибка";
        await ctx.reply(
          `❌ Не удалось создать бронь: ${msg}\n\nПопробуйте ещё раз или обратитесь к администратору.`,
          confirmKeyboard,
        );
      }
      return;
    }

    if (text === "✏️ Редактировать список") {
      setState(ctx, { step: "hub", pendingReview: [], pendingReviewIndex: 0 });
      await showHub(ctx);
      return;
    }

    if (text === "✏️ Изменить даты") {
      setState(ctx, { step: "dates", startDate: undefined, endDate: undefined });
      await ctx.reply(
        "Введите период заново:\n_Например: «с 10 по 12 апреля»_",
        { parse_mode: "Markdown", ...bookingStepNavKeyboard },
      );
      return;
    }

    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }

    await ctx.reply("Используйте кнопки ниже.", confirmKeyboard);
  }
});

// ── Вспомогательные функции ───────────────────────────────────────────────────

/**
 * Показывает хаб: корзину (или сообщение о пустом списке) + клавиатуру хаба.
 * @param unmatchedText — опциональный текст для предупреждения о ненайденных позициях
 */
async function showHub(ctx: BotContext, unmatchedText?: string): Promise<void> {
  const s = getState(ctx);
  const items = s.items ?? [];

  let msg: string;

  if (items.length === 0) {
    msg =
      "📋 Список пуст\n\n" +
      "Добавьте оборудование любым способом:\n" +
      "• Напишите список текстом — AI подберёт из каталога\n" +
      "• Или выберите из каталога по категориям";
  } else {
    const full = totalCost(items, s.startDate!, s.endDate!);
    const MAX_DISPLAY = 15;
    const displayItems = items.slice(0, MAX_DISPLAY);
    const hiddenCount = items.length - MAX_DISPLAY;
    let listStr = fmtList(displayItems, true);
    if (hiddenCount > 0) {
      listStr += `\n... и ещё ${hiddenCount} позиций`;
    }
    msg =
      `📋 *Список оборудования (${items.length} поз.):*\n` +
      `${listStr}\n\n` +
      `${fmtPrice(full)}\n\n` +
      `Напишите что добавить или убрать — бот поймёт.`;
  }

  if (unmatchedText) {
    msg = `⚠️ Не найдено в каталоге: ${unmatchedText}\n\n${msg}`;
  }

  await ctx.reply(msg, { parse_mode: "Markdown", reply_markup: hubKeyboardMarkup() });
}

/**
 * Показывает текущий элемент pendingReview как инлайн-клавиатуру.
 * Если кандидатов 0 — автоматически пропускает и переходит к следующему.
 */
async function showNextReview(ctx: BotContext): Promise<void> {
  const s = getState(ctx);
  const pending = s.pendingReview ?? [];
  let idx = s.pendingReviewIndex ?? 0;

  // Пропускаем позиции без кандидатов (цикл вместо рекурсии)
  while (idx < pending.length) {
    const cur = pending[idx];
    if (cur && cur.match.kind === "needsReview" && cur.match.candidates.length > 0) break;
    idx++;
  }
  setState(ctx, { pendingReviewIndex: idx });

  // Все обработаны
  if (idx >= pending.length) {
    setState(ctx, { pendingReview: [], pendingReviewIndex: 0 });
    await showHub(ctx);
    return;
  }

  const item = pending[idx]!;
  const candidates = item.match.kind === "needsReview" ? item.match.candidates : [];

  const progress = `(${idx + 1}/${pending.length}) `;

  if (candidates.length === 1) {
    const c = candidates[0]!;
    const pct = Math.round(c.confidence * 100);
    await ctx.reply(
      `❓ ${progress}«${item.gafferPhrase}» — это ${c.catalogName}?`,
      {
        ...Markup.inlineKeyboard([
          [
            Markup.button.callback(`✅ Да (${pct}%)`, `nr:accept:${c.equipmentId}:${item.quantity}`),
            Markup.button.callback("❌ Нет", "nr:skip"),
            Markup.button.callback("⏭ Пропустить все", "nr:skipall"),
          ],
        ]),
      },
    );
  } else {
    const rows = candidates.map((c) => {
      const pct = Math.round(c.confidence * 100);
      return [Markup.button.callback(`${c.catalogName} (${pct}%)`, `nr:accept:${c.equipmentId}:${item.quantity}`)];
    });
    rows.push([Markup.button.callback("❌ Нет, пропустить", "nr:skip")]);
    rows.push([Markup.button.callback("⏭ Пропустить все оставшиеся", "nr:skipall")]);

    await ctx.reply(
      `❓ ${progress}«${item.gafferPhrase}» — вы имели в виду:`,
      {
        ...Markup.inlineKeyboard(rows),
      },
    );
  }
}

/**
 * Пытается удалить позиции из списка по тексту пользователя.
 * Распознаёт: "2", "удалить 2", "1, 3", "Aputure", "удалить генератор".
 * Возвращает null если текст не похож на команду удаления.
 */
const DELETE_PREFIXES_RE = /^(удалить|удали|убери|убрать)\s+/i;
const DELETE_STRIP_RE = /^(удалить|удали|убери|убрать)\s*/i;

function tryDeleteItems(
  items: MatchedItem[],
  text: string,
): { removed: MatchedItem[]; remaining: MatchedItem[] } | null {
  const clean = text.replace(DELETE_STRIP_RE, "").trim();

  // Набор номеров: "1", "1, 3", "2 4"
  const numbersOnly = /^[\d\s,;]+$/.test(clean);
  if (numbersOnly) {
    const indices = clean
      .split(/[\s,;]+/)
      .map((n) => parseInt(n, 10) - 1)
      .filter((i) => i >= 0 && i < items.length);
    if (indices.length === 0) return null;
    const indexSet = new Set(indices);
    return {
      removed: items.filter((_, i) => indexSet.has(i)),
      remaining: items.filter((_, i) => !indexSet.has(i)),
    };
  }

  // Поиск по подстроке названия (нечёткий, case-insensitive)
  const query = clean.toLowerCase();
  const matched = items.filter((item) =>
    item.name.toLowerCase().includes(query) ||
    item.category.toLowerCase().includes(query),
  );
  if (matched.length === 0) return null;

  // Удаляем только если явно написано «удали/убери/убрать ...» или найдена одна точная позиция
  const isExplicitDelete = DELETE_PREFIXES_RE.test(text);
  if (!isExplicitDelete && matched.length > 1) return null; // неоднозначно — не удаляем

  const matchedIds = new Set(matched.map((m) => m.equipmentId));
  return {
    removed: matched,
    remaining: items.filter((i) => !matchedIds.has(i.equipmentId)),
  };
}

/** Показывает экран подтверждения */
async function showConfirm(ctx: BotContext): Promise<void> {
  const s = getState(ctx);
  const items = s.items ?? [];
  setState(ctx, { step: "confirm", pendingReview: [], pendingReviewIndex: 0 });

  const full = totalCost(items, s.startDate!, s.endDate!);

  const msg =
    `📦 *Список оборудования (${items.length} поз.):*\n${fmtList(items)}\n\n` +
    `${fmtPrice(full)}\n\n` +
    `*Итоговая заявка:*\n` +
    `👤 Клиент: ${s.clientName}\n` +
    `🎬 Проект: ${s.projectName || "—"}\n` +
    `📅 Период: ${s.startDate} — ${s.endDate}\n\n` +
    `Шаг 4/4 — Всё верно?`;

  await ctx.reply(msg, { parse_mode: "Markdown", ...confirmKeyboard });
}
