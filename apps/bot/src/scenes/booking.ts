import { Scenes, Markup } from "telegraf";
import type { BotContext, BookingDraft, MatchedItem } from "../types";
import { parseDates, matchEquipment, parseCatalogIntent } from "../services/llm";
import { getAvailability, createBooking, getPricelistMeta, fetchPricelistBuffer } from "../services/api";
import { logError, logWarn } from "../services/logger";
import { mainMenuKeyboard } from "../keyboards";

const DISCOUNT = 0.5; // 50% скидка

/** Шаги 1–3/5: назад по шагам + отмена в главное меню */
const bookingStepNavKeyboard = Markup.keyboard([
  ["⬅️ Назад", "❌ Отмена бронирования"],
]).resize();

/** Свободный ввод списка оборудования (AI) */
const equipmentFreeNavKeyboard = Markup.keyboard([
  ["⬅️ Назад", "❌ Отмена бронирования"],
]).resize();

const BTN_ADD_POSITION_AI = "➕ Добавить позицию (AI)";

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

/** Клавиатура шага clarify: пропустить непонятое + каталог + прайслист */
function buildClarifyKeyboard(_items: MatchedItem[], hasPricelist = false) {
  const rows: string[][] = [
    ["⬅️ Назад", "❌ Отмена бронирования"],
    ["📋 Добавить из каталога"],
    ["➡️ Пропустить непонятое"],
  ];
  if (hasPricelist) rows.push(["📄 Получить прайслист"]);
  return Markup.keyboard(rows).resize();
}

/**
 * Клавиатура М4А.2 — явный reply_markup для Telegram (без spread Extra из Markup,
 * чтобы клавиатура не «обрезалась» из‑за конфликта опций).
 * По одной кнопке в ряд — на узких экранах всё видно.
 */
function editListKeyboardMarkup() {
  return {
    keyboard: [
      [{ text: BTN_ADD_POSITION_AI }],
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

/** Строим MatchedItem[] из результата matchEquipment + каталога */
function buildItems(
  rawMatched: Array<{ equipmentId: string; quantity: number }>,
  catalog: Array<{ equipmentId: string; name: string; category: string; availableQuantity: number; rentalRatePerShift: string }>,
): MatchedItem[] {
  const catalogMap = new Map(catalog.map((e) => [e.equipmentId, e]));
  return rawMatched
    .filter((i) => catalogMap.has(i.equipmentId) && i.quantity > 0)
    .map((i) => {
      const eq = catalogMap.get(i.equipmentId)!;
      return {
        equipmentId: i.equipmentId,
        name: eq.name,
        category: eq.category,
        quantity: Math.min(i.quantity, eq.availableQuantity),
        rentalRatePerShift: eq.rentalRatePerShift,
        availableQuantity: eq.availableQuantity,
      };
    });
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

/** Клавиатура выбора режима ввода оборудования */
const equipmentModeKeyboard = Markup.keyboard([
  ["⬅️ Назад"],
  ["✍️ Внесение списка (AI)"],
  ["📋 По категориям"],
  ["❌ Отмена бронирования"],
]).resize();

/** Клавиатура подтверждения */
const confirmKeyboard = Markup.keyboard([
  ["✅ Подтвердить"],
  ["✏️ Редактировать список", "✏️ Изменить даты"],
  ["❌ Отмена бронирования"],
]).resize();

/** Клавиатура ввода нового оборудования в режиме редактора */
const addEquipmentKeyboard = Markup.keyboard([
  ["📋 Добавить из каталога"],
  ["⬅️ Назад к списку"],
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
    "📋 *Новая бронь*\n\nШаг 1/5 — Как зовут клиента?",
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
      "Шаг 2/5 — Название проекта или съёмки?\n_(или отправьте «-» чтобы пропустить)_",
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
        "Шаг 1/5 — Как зовут клиента?",
        { parse_mode: "Markdown", ...bookingStepNavKeyboard },
      );
      return;
    }
    setState(ctx, { projectName: text === "-" ? "" : text, step: "dates" });
    await ctx.reply(
      "Шаг 3/5 — На какой период нужно оборудование?\n\n_Примеры:_\n• «с 10 апреля по 12 апреля»\n• «14-16 мая»\n• «20 июня, один день»",
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
        "Шаг 2/5 — Название проекта или съёмки?\n_(или отправьте «-» чтобы пропустить)_",
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
      step: "equipment_mode",
    });

    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      `✅ Период: *${result.startDate}* — *${result.endDate}*\n\nШаг 4/5 — Как выбрать оборудование?`,
      { parse_mode: "Markdown" },
    );
    await ctx.reply(
      `*✍️ Внесение списка (AI)* — напишите всё что нужно одним сообщением\n\n` +
      `*📋 По категориям* — мы покажем каталог по разделам, вы выберете нужное`,
      { parse_mode: "Markdown", ...equipmentModeKeyboard },
    );
    return;
  }

  // ─── Шаг 4: выбор режима ввода оборудования ───────────────────────────────
  if (s.step === "equipment_mode") {
    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }
    if (text === "⬅️ Назад") {
      setState(ctx, { step: "dates", startDate: undefined, endDate: undefined, rawDates: undefined });
      await ctx.reply(
        "Шаг 3/5 — На какой период нужно оборудование?\n\n_Примеры:_\n• «с 10 апреля по 12 апреля»\n• «14-16 мая»\n• «20 июня, один день»",
        { parse_mode: "Markdown", ...bookingStepNavKeyboard },
      );
      return;
    }
    if (text === "✍️ Внесение списка (AI)") {
      setState(ctx, { step: "equipment" });
      await ctx.reply(
        "Напишите что нужно произвольно:\n\n_Например: «Aputure 1200x 2 шт, astera kit, Nova 2  4шт»_",
        { parse_mode: "Markdown", ...equipmentFreeNavKeyboard },
      );
      return;
    }
    if (text === "📋 По категориям") {
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
      } catch {
        await ctx.telegram.editMessageText(
          ctx.chat!.id, thinking.message_id, undefined,
          "⚠️ Не удалось загрузить каталог. Попробуйте ещё раз или выберите свободный список.",
        );
      }
      return;
    }
    await ctx.reply("Выберите способ через кнопки.", equipmentModeKeyboard);
    return;
  }

  // ─── Шаг 4а: свободный ввод оборудования ──────────────────────────────────
  if (s.step === "equipment") {
    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }
    if (text === "⬅️ Назад") {
      setState(ctx, { step: "equipment_mode" });
      await ctx.reply(
        `Шаг 4/5 — Как выбрать оборудование?\n\n` +
        `*✍️ Внесение списка (AI)* — напишите всё одним сообщением\n` +
        `*📋 По категориям* — каталог по разделам`,
        { parse_mode: "Markdown", ...equipmentModeKeyboard },
      );
      return;
    }
    await handleEquipmentInput(ctx, text, [], false);
    return;
  }

  // ─── Шаг 4б: пошаговый выбор по каталогу ─────────────────────────────────
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
          step: "equipment_mode",
          catalogItems: undefined,
          catalogCategories: undefined,
          catalogCategory: null,
        });
        await ctx.reply(
          `Шаг 4/5 — Как выбрать оборудование?`,
          { parse_mode: "Markdown", ...equipmentModeKeyboard },
        );
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
      setState(ctx, { step: "edit_list", catalogItems: undefined, catalogCategories: undefined, catalogCategory: null });
      await ctx.reply(
        buildEditListMessage(items, s.startDate!, s.endDate!),
        { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
      );
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

  // ─── Шаг 4в: уточнение ненайденных позиций ────────────────────────────────
  if (s.step === "clarify") {
    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }
    if (text === "⬅️ Назад") {
      setState(ctx, {
        step: "equipment_mode",
        unmatchedText: undefined,
        clarifyAttempts: 0,
      });
      await ctx.reply(
        `Шаг 4/5 — Как выбрать оборудование?`,
        { parse_mode: "Markdown", ...equipmentModeKeyboard },
      );
      return;
    }
    if (text === "➡️ Пропустить непонятое") {
      setState(ctx, { unmatchedText: undefined, clarifyAttempts: 0 });
      await showConfirm(ctx);
      return;
    }

    const items = s.items ?? [];

    // Кнопка "📋 Добавить из каталога"
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
          unmatchedText: undefined,
          clarifyAttempts: 0,
        });
        await ctx.telegram.deleteMessage(ctx.chat!.id, thinking.message_id);
        await showCatalogCategories(ctx);
      } catch (e) {
        logError("clarify:catalog", "Failed to load catalog", e);
        await ctx.telegram.editMessageText(
          ctx.chat!.id, thinking.message_id, undefined,
          "⚠️ Не удалось загрузить каталог. Попробуйте позже.",
        );
      }
      return;
    }

    // Отправить прайслист
    if (text === "📄 Получить прайслист") {
      const file = await fetchPricelistBuffer();
      if (!file) {
        await ctx.reply("⚠️ Прайслист пока не загружен. Обратитесь к менеджеру.");
        return;
      }
      await ctx.replyWithDocument(
        { source: file.buffer, filename: file.filename },
        { caption: "📄 Прайслист оборудования" },
      );
      return;
    }

    // Удаление по номеру или названию (включая «удали/убери/убрать»)
    const deleteResult = tryDeleteItems(items, text);
    if (deleteResult) {
      setState(ctx, { items: deleteResult.remaining });
      const removedNames = deleteResult.removed.map((r) => `• ${r.name}`).join("\n");
      const plMeta = await getPricelistMeta();
      await ctx.reply(
        `🗑 Удалено:\n${removedNames}\n\n` +
        (deleteResult.remaining.length > 0
          ? buildClarifyMessage(deleteResult.remaining, s.unmatchedText!)
          : "Список пуст."),
        { parse_mode: "Markdown", ...buildClarifyKeyboard(deleteResult.remaining, plMeta?.exists === true) },
      );
      return;
    }

    // Явное намерение удалить, но нет совпадений
    if (DELETE_PREFIXES_RE.test(text)) {
      const query = text.replace(DELETE_STRIP_RE, "").trim();
      const plMeta = await getPricelistMeta();
      await ctx.reply(
        `❓ Не нашёл «${query}» в списке.\n_Напишите номер позиции или другую часть названия._`,
        { parse_mode: "Markdown", ...buildClarifyKeyboard(items, plMeta?.exists === true) },
      );
      return;
    }

    // Иначе — попытка добавить уточнённые позиции через LLM
    await handleEquipmentInput(ctx, text, items, true);
    return;
  }

  // ─── Шаг 4в: редактирование списка ────────────────────────────────────────
  if (s.step === "edit_list") {
    if (text === "✅ Готово") {
      await showConfirm(ctx);
      return;
    }

    if (text === "❌ Отмена бронирования") {
      await ctx.reply("❌ Создание брони отменено.", mainMenuKeyboard);
      await ctx.scene.leave();
      return;
    }

    const items = s.items ?? [];

    // Кнопка "📋 Добавить из каталога"
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
        logError("edit_list:catalog", "Failed to load catalog", e);
        await ctx.telegram.editMessageText(
          ctx.chat!.id, thinking.message_id, undefined,
          "⚠️ Не удалось загрузить каталог. Попробуйте позже.",
        );
      }
      return;
    }

    // Кнопка «Добавить позицию (AI)»
    if (text === BTN_ADD_POSITION_AI) {
      setState(ctx, { step: "edit_add" });
      await ctx.reply(
        "Напишите что добавить или убрать — бот поймёт:\n\n" +
        "_Добавить: «aputure 2шт», «Nova 300 1 штука»_\n" +
        "_Убрать: «убери nova», «удали 2 b7c»_",
        { parse_mode: "Markdown", ...addEquipmentKeyboard },
      );
      return;
    }

    // Кнопка "🗑 Удалить позицию"
    if (text === "🗑 Удалить позицию") {
      if (items.length === 0) {
        await ctx.reply("⚠️ Список пуст — нечего удалять.", { reply_markup: editListKeyboardMarkup() });
        return;
      }
      const numbered = items.map((i, n) => `${n + 1}. ${i.name} × ${i.quantity} шт`).join("\n");
      await ctx.reply(
        `Напишите номер или название позиции для удаления:\n\n${numbered}`,
        { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
      );
      return;
    }

    // Удаление по номеру или названию
    const deleteResult = tryDeleteItems(items, text);
    if (deleteResult) {
      setState(ctx, { items: deleteResult.remaining });
      const removedNames = deleteResult.removed.map((r) => `• ${r.name}`).join("\n");
      if (deleteResult.remaining.length === 0) {
        await ctx.reply(
          `🗑 Удалено:\n${removedNames}\n\n⚠️ Список пуст. Добавьте оборудование или отмените бронь.`,
          { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
        );
      } else {
        await ctx.reply(
          `🗑 Удалено:\n${removedNames}\n\n${buildEditListMessage(deleteResult.remaining, s.startDate!, s.endDate!)}`,
          { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
        );
      }
      return;
    }

    // Явное намерение удалить, но ничего не нашли в списке
    if (DELETE_PREFIXES_RE.test(text)) {
      const query = text.replace(DELETE_STRIP_RE, "").trim();
      await ctx.reply(
        `❓ Не нашёл «${query}» в списке.\n_Напишите номер позиции или другую часть названия._`,
        { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
      );
      return;
    }

    // Свободный ввод — пытаемся добавить через LLM
    const thinking = await ctx.reply("⏳ Ищу в каталоге…");
    let catalog;
    try {
      catalog = await getAvailability(s.startDate!, s.endDate!);
    } catch (e) {
      logError("edit_list:getAvailability", "Failed to load catalog", e);
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        "⚠️ Не удалось получить каталог. Попробуйте позже.",
      );
      return;
    }

    let matchResult;
    try {
      matchResult = await matchEquipment(text, catalog);
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === "TimeoutError";
      logError("edit_list:matchEquipment", `LLM error for: "${text.slice(0, 120)}"`, e);
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        isTimeout ? "⏱ Запрос слишком долгий. Попробуйте написать короче." : "⚠️ Ошибка. Попробуйте позже.",
      );
      return;
    }

    if ("error" in matchResult || matchResult.items.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        `❓ Не нашёл «${text}» в каталоге.\n\nПопробуйте описать иначе или используйте «📋 Добавить из каталога».`,
      );
      return;
    }

    const newItems = buildItems(matchResult.items, catalog);
    const merged = mergeItems(items, newItems);
    setState(ctx, { items: merged });

    const added = newItems.map((i) => `• ${i.name} × ${i.quantity} шт`).join("\n");
    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      `✅ Добавлено:\n${added}`,
      { parse_mode: "Markdown" },
    );
    await ctx.reply(
      buildEditListMessage(merged, s.startDate!, s.endDate!),
      { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
    );
    return;
  }

  // ─── Шаг 4г: добавление/удаление позиции в режиме редактора ──────────────
  if (s.step === "edit_add") {
    if (text === "⬅️ Назад к списку") {
      setState(ctx, { step: "edit_list" });
      const items = s.items ?? [];
      await ctx.reply(
        buildEditListMessage(items, s.startDate!, s.endDate!),
        { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
      );
      return;
    }

    // Кнопка "📋 Добавить из каталога"
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
        logError("edit_add:catalog", "Failed to load catalog", e);
        await ctx.telegram.editMessageText(
          ctx.chat!.id, thinking.message_id, undefined,
          "⚠️ Не удалось загрузить каталог. Попробуйте позже.",
        );
      }
      return;
    }

    const items = s.items ?? [];

    // Удаление по номеру или названию (включая «удали/убери/убрать»)
    const deleteResult = tryDeleteItems(items, text);
    if (deleteResult) {
      setState(ctx, { items: deleteResult.remaining, step: "edit_list" });
      const removedNames = deleteResult.removed.map((r) => `• ${r.name}`).join("\n");
      if (deleteResult.remaining.length === 0) {
        await ctx.reply(
          `🗑 Удалено:\n${removedNames}\n\n⚠️ Список пуст. Добавьте оборудование или отмените бронь.`,
          { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
        );
      } else {
        await ctx.reply(
          `🗑 Удалено:\n${removedNames}\n\n${buildEditListMessage(deleteResult.remaining, s.startDate!, s.endDate!)}`,
          { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
        );
      }
      return;
    }

    // Явное намерение удалить, но нет совпадений
    if (DELETE_PREFIXES_RE.test(text)) {
      const query = text.replace(DELETE_STRIP_RE, "").trim();
      await ctx.reply(
        `❓ Не нашёл «${query}» в списке.\n_Напишите номер позиции или другую часть названия._`,
        { parse_mode: "Markdown", ...addEquipmentKeyboard },
      );
      return;
    }

    // Свободный ввод — добавляем через LLM
    const thinking = await ctx.reply("⏳ Ищу в каталоге…");
    let catalog;
    try {
      catalog = await getAvailability(s.startDate!, s.endDate!);
    } catch (e) {
      logError("edit_add:getAvailability", "Failed to load catalog", e);
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        "⚠️ Не удалось получить каталог. Попробуйте позже.",
      );
      return;
    }

    let matchResult;
    try {
      matchResult = await matchEquipment(text, catalog);
    } catch (e) {
      const isTimeout = e instanceof Error && e.name === "TimeoutError";
      logError("edit_add:matchEquipment", `LLM error for: "${text.slice(0, 120)}"`, e);
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        isTimeout ? "⏱ Запрос слишком долгий. Попробуйте написать короче." : "⚠️ Ошибка. Попробуйте позже.",
      );
      return;
    }
    if ("error" in matchResult || matchResult.items.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        `❓ Не нашёл «${text}» в каталоге.\n\nПопробуйте описать иначе или используйте «📋 Добавить из каталога».`,
      );
      return;
    }

    const newItems = buildItems(matchResult.items, catalog);
    const merged = mergeItems(items, newItems);
    setState(ctx, { items: merged, step: "edit_list" });

    const added = newItems.map((i) => `• ${i.name} × ${i.quantity} шт`).join("\n");
    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      `✅ Добавлено:\n${added}`,
      { parse_mode: "Markdown" },
    );
    await ctx.reply(
      buildEditListMessage(merged, s.startDate!, s.endDate!),
      { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
    );
    return;
  }

  // ─── Шаг 5: подтверждение ─────────────────────────────────────────────────
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
      setState(ctx, { step: "edit_list" });
      const items = s.items ?? [];
      await ctx.reply(
        buildEditListMessage(items, s.startDate!, s.endDate!),
        { parse_mode: "Markdown", reply_markup: editListKeyboardMarkup() },
      );
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

/** Обрабатывает текст с оборудованием. existingItems — уже накопленный список. isClarify — режим уточнения */
async function handleEquipmentInput(
  ctx: BotContext,
  text: string,
  existingItems: MatchedItem[],
  isClarify: boolean,
): Promise<void> {
  const s = getState(ctx);
  const thinking = await ctx.reply("⏳ Подбираю оборудование по каталогу…");

  let catalog;
  try {
    catalog = await getAvailability(s.startDate!, s.endDate!);
  } catch (e) {
    logError("handleEquipmentInput:getAvailability", "Failed to load catalog", e);
    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      "⚠️ Не удалось получить список оборудования. Попробуйте позже.",
    );
    return;
  }

  let matchResult;
  try {
    matchResult = await matchEquipment(text, catalog);
  } catch (e) {
    const isTimeout = e instanceof Error && e.name === "TimeoutError";
    logError("handleEquipmentInput:matchEquipment", `LLM error (timeout=${isTimeout}) for: "${text.slice(0, 120)}"`, e);
    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      isTimeout
        ? "⏱ Запрос слишком большой — сервер не успел обработать за 30 сек.\n\nПопробуйте разбить на несколько частей."
        : "⚠️ Ошибка при подборе оборудования. Попробуйте позже.",
    );
    return;
  }

  if ("error" in matchResult) {
    logWarn("handleEquipmentInput:matchEquipment", `LLM returned error: ${matchResult.error}`);
    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      `❓ ${matchResult.error}\n\nПопробуйте описать оборудование иначе.`,
    );
    return;
  }

  const newItems = buildItems(matchResult.items, catalog);
  const merged = mergeItems(existingItems, newItems);
  const unmatched = matchResult.unmatchedText?.trim() || undefined;

  if (merged.length === 0 && !unmatched) {
    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      "❓ Ничего не удалось найти в каталоге. Попробуйте описать иначе.",
    );
    return;
  }

  if (unmatched) {
    // Есть непонятые позиции — показываем объединённое сообщение и ждём уточнения
    setState(ctx, {
      items: merged,
      unmatchedText: unmatched,
      clarifyAttempts: (s.clarifyAttempts ?? 0) + (isClarify ? 1 : 0),
      step: "clarify",
    });

    // Редактируем «думающее» сообщение → итоговый результат
    const headerLabel = isClarify ? "✅ *Добавлено, обновлённый список:*" : "📦 *Вот что удалось найти:*";
    const resultMsg = merged.length > 0
      ? `${headerLabel}\n${fmtList(merged, true)}\n\n${fmtPrice(totalCost(merged, s.startDate!, s.endDate!))}`
      : "_(ничего не добавлено)_";

    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      resultMsg,
      { parse_mode: "Markdown" },
    );

    // Проверяем наличие прайслиста для кнопки
    const plMeta = await getPricelistMeta();
    const hasPricelist = plMeta?.exists === true;

    // Отдельным сообщением — запрос на уточнение
    await ctx.reply(
      buildClarifyMessage(merged, unmatched, hasPricelist),
      { parse_mode: "Markdown", ...buildClarifyKeyboard(merged, hasPricelist) },
    );
  } else {
    // Всё нашлось — сохраняем и идём к подтверждению
    setState(ctx, { items: merged, unmatchedText: undefined, clarifyAttempts: 0 });

    const label = isClarify ? "✅ *Добавлено, обновлённый список:*" : "📦 *Вот что удалось найти:*";
    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      `${label}\n${fmtList(merged, true)}\n\n${fmtPrice(totalCost(merged, s.startDate!, s.endDate!))}`,
      { parse_mode: "Markdown" },
    );

    await showConfirm(ctx);
  }
}

/** Строит сообщение-запрос на уточнение непонятых позиций */
function buildClarifyMessage(
  items: MatchedItem[],
  unmatched: string,
  hasPricelist = false,
): string {
  const unmatchedLines = unmatched
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => `• ${s}`)
    .join("\n");

  let msg = `❓ *Не смог найти в каталоге:*\n${unmatchedLines}\n\n`;
  msg += `Просто напишите что нужно добавить или убрать — бот поймёт.\n`;
  msg += `_Примеры: «добавь апчур 2шт», «убери генератор», «Nova P 1 штука»_`;
  if (hasPricelist) {
    msg += `\n\nИли нажмите *📄 Получить прайслист* чтобы узнать точные названия.`;
  }
  if (items.length > 0) {
    msg += `\n\n_Текущий список: ${items.length} поз. Чтобы удалить — напишите «удали [название]» или номер._`;
  }
  return msg;
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
  setState(ctx, { step: "confirm" });

  const full = totalCost(items, s.startDate!, s.endDate!);

  const msg =
    `📦 *Список оборудования (${items.length} поз.):*\n${fmtList(items)}\n\n` +
    `${fmtPrice(full)}\n\n` +
    `*Итоговая заявка:*\n` +
    `👤 Клиент: ${s.clientName}\n` +
    `🎬 Проект: ${s.projectName || "—"}\n` +
    `📅 Период: ${s.startDate} — ${s.endDate}\n\n` +
    `Шаг 5/5 — Всё верно?`;

  await ctx.reply(msg, { parse_mode: "Markdown", ...confirmKeyboard });
}

/** Строит текст для экрана редактора списка */
function buildEditListMessage(
  items: MatchedItem[],
  startDate: string,
  endDate: string,
): string {
  if (items.length === 0) {
    return "📋 *Список пуст*\n\nНажмите «➕ Добавить позицию (AI)» чтобы добавить оборудование.";
  }
  const full = totalCost(items, startDate, endDate);
  return (
    `📋 *Список (${items.length} поз.):*\n${fmtList(items, true)}\n\n` +
    `${fmtPrice(full)}\n\n` +
    `_Чтобы удалить — напишите «удали [название]» или номер позиции_\n` +
    `_Чтобы добавить — напишите название или используйте «📋 Добавить из каталога»_`
  );
}
