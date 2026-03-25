import { Scenes, Markup } from "telegraf";
import type { BotContext, BookingDraft, MatchedItem } from "../types";
import { parseDates, matchEquipment, validateBookingSummary } from "../services/llm";
import { getAvailability, createBooking } from "../services/api";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function fmt(items: MatchedItem[]): string {
  return items
    .map((i) => `• ${i.name} × ${i.quantity} шт — ${Number(i.rentalRatePerShift).toLocaleString("ru-RU")} ₽/смена`)
    .join("\n");
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

/** Вспомогательные функции для доступа к состоянию сцены */
function getState(ctx: BotContext): Partial<BookingDraft> {
  return ctx.scene.state as Partial<BookingDraft>;
}
function setState(ctx: BotContext, patch: Partial<BookingDraft>): void {
  Object.assign(ctx.scene.state, patch);
}

export const bookingScene = new Scenes.BaseScene<BotContext>("booking");

// ── Вход в сцену ──────────────────────────────────────────────────────────────
bookingScene.enter(async (ctx) => {
  setState(ctx, { step: "client" });
  await ctx.reply(
    "📋 *Новая бронь*\n\nШаг 1/5 — Как зовут клиента?",
    { parse_mode: "Markdown" },
  );
});

// ── Отмена в любой момент ─────────────────────────────────────────────────────
bookingScene.command("cancel", async (ctx) => {
  await ctx.reply("❌ Создание брони отменено.", Markup.removeKeyboard());
  await ctx.scene.leave();
});

// ── Главный обработчик текста ─────────────────────────────────────────────────
bookingScene.on("text", async (ctx) => {
  const s = getState(ctx);
  if (!s.step) { await ctx.scene.leave(); return; }

  const text = ctx.message.text.trim();

  // ─── Шаг 1: имя клиента ───────────────────────────────────────────────────
  if (s.step === "client") {
    if (text.length < 2) {
      await ctx.reply("Введите имя клиента (минимум 2 символа).");
      return;
    }
    setState(ctx, { clientName: text, step: "project" });
    await ctx.reply("Шаг 2/5 — Название проекта или съёмки?\n_(или отправьте «-» чтобы пропустить)_", {
      parse_mode: "Markdown",
    });
    return;
  }

  // ─── Шаг 2: название проекта ──────────────────────────────────────────────
  if (s.step === "project") {
    setState(ctx, { projectName: text === "-" ? "" : text, step: "dates" });
    await ctx.reply(
      "Шаг 3/5 — На какой период нужно оборудование?\n\n_Примеры:_\n• «с 10 апреля по 12 апреля»\n• «14-16 мая»\n• «20 июня, один день»",
      { parse_mode: "Markdown" },
    );
    return;
  }

  // ─── Шаг 3: даты ──────────────────────────────────────────────────────────
  if (s.step === "dates") {
    const thinking = await ctx.reply("⏳ Определяю даты…");
    const result = await parseDates(text, today());

    if ("error" in result) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        `❓ Не удалось разобрать даты: ${result.error}\n\nПопробуйте ещё раз. Например:\n«с 10 по 12 апреля 2025»`,
      );
      return;
    }

    setState(ctx, {
      rawDates: text,
      startDate: result.startDate,
      endDate: result.endDate,
      step: "equipment",
    });

    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      `✅ Период: *${result.startDate}* — *${result.endDate}*\n\nШаг 4/5 — Какое оборудование нужно?\n\n_Пишите произвольно, например:_\n«2 прибора Aputure, 1 генератор, 3 рефлектора»`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  // ─── Шаг 4: оборудование ──────────────────────────────────────────────────
  if (s.step === "equipment") {
    const thinking = await ctx.reply("⏳ Подбираю оборудование по каталогу…");

    let catalog;
    try {
      catalog = await getAvailability(s.startDate!, s.endDate!);
    } catch {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        "⚠️ Не удалось получить список оборудования. Попробуйте позже.",
      );
      return;
    }

    const matchResult = await matchEquipment(text, catalog);

    if ("error" in matchResult) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        `❓ ${matchResult.error}\n\nОпишите оборудование ещё раз.`,
      );
      return;
    }

    if (matchResult.items.length === 0) {
      await ctx.telegram.editMessageText(
        ctx.chat!.id, thinking.message_id, undefined,
        "❓ Не найдено совпадений в каталоге. Попробуйте описать иначе.",
      );
      return;
    }

    const catalogMap = new Map(catalog.map((e) => [e.equipmentId, e]));
    const items: MatchedItem[] = matchResult.items
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

    setState(ctx, { rawEquipment: text, items, step: "confirm" });

    const cost = totalCost(items, s.startDate!, s.endDate!);
    let msg =
      `📦 *Найденное оборудование:*\n${fmt(items)}\n\n` +
      `💰 Ориентировочная стоимость: *${cost.toLocaleString("ru-RU")} ₽*\n`;

    if (matchResult.unmatchedText) {
      msg += `\n⚠️ Не найдено в каталоге: _${matchResult.unmatchedText}_\n`;
    }

    await ctx.telegram.editMessageText(
      ctx.chat!.id, thinking.message_id, undefined,
      msg, { parse_mode: "Markdown" },
    );

    const summary =
      `\n*Итоговая заявка:*\n` +
      `👤 Клиент: ${s.clientName}\n` +
      `🎬 Проект: ${s.projectName || "—"}\n` +
      `📅 Период: ${s.startDate} — ${s.endDate}\n\n` +
      `Шаг 5/5 — Всё верно? Создаём бронь?`;

    await ctx.reply(summary, {
      parse_mode: "Markdown",
      ...Markup.keyboard([
        ["✅ Подтвердить"],
        ["✏️ Изменить оборудование", "✏️ Изменить даты"],
        ["❌ Отменить"],
      ]).resize(),
    });
    return;
  }

  // ─── Шаг 5: подтверждение ─────────────────────────────────────────────────
  if (s.step === "confirm") {
    if (text === "✅ Подтвердить") {
      const thinking = await ctx.reply("⏳ Проверяю заявку и создаю бронь…", Markup.removeKeyboard());

      const validation = await validateBookingSummary({
        clientName: s.clientName!,
        projectName: s.projectName ?? "",
        startDate: s.startDate!,
        endDate: s.endDate!,
        items: s.items!,
      });

      if (!validation.ok) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id, thinking.message_id, undefined,
          `⚠️ Обнаружены проблемы:\n${validation.issues}\n\nИсправьте и попробуйте снова.`,
        );
        setState(ctx, { step: "equipment" });
        await ctx.reply("Опишите оборудование заново:");
        return;
      }

      try {
        const booking = await createBooking({
          clientName: s.clientName!,
          projectName: s.projectName ?? "",
          startDate: s.startDate!,
          endDate: s.endDate!,
          items: s.items!,
        });

        await ctx.telegram.editMessageText(
          ctx.chat!.id, thinking.message_id, undefined,
          `✅ *Бронь создана!*\n\n` +
          `🆔 Номер брони: *#${booking.humanId}*\n` +
          `👤 Клиент: ${s.clientName}\n` +
          `🎬 Проект: ${s.projectName || "—"}\n` +
          `📅 ${s.startDate} — ${s.endDate}\n\n` +
          `📦 Оборудование:\n${fmt(s.items!)}\n\n` +
          `_Управление бронью — в системе Light Rental._`,
          { parse_mode: "Markdown" },
        );

        const adminIds = (process.env.ADMIN_CHAT_IDS ?? "")
          .split(",").map((x) => x.trim()).filter(Boolean);

        const adminMsg =
          `🔔 *Новая бронь #${booking.humanId}*\n` +
          `👤 ${s.clientName}\n` +
          `🎬 ${s.projectName || "—"}\n` +
          `📅 ${s.startDate} — ${s.endDate}\n` +
          `📦 ${s.items!.length} позиций\n` +
          `💰 ${totalCost(s.items!, s.startDate!, s.endDate!).toLocaleString("ru-RU")} ₽\n` +
          `_Источник: Telegram_`;

        await Promise.allSettled(
          adminIds.map((id) =>
            ctx.telegram.sendMessage(id, adminMsg, { parse_mode: "Markdown" }),
          ),
        );

        await ctx.scene.leave();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Неизвестная ошибка";
        await ctx.telegram.editMessageText(
          ctx.chat!.id, thinking.message_id, undefined,
          `❌ Ошибка при создании брони: ${msg}\n\nОбратитесь к администратору.`,
        );
      }
      return;
    }

    if (text === "✏️ Изменить оборудование") {
      setState(ctx, { step: "equipment", items: undefined });
      await ctx.reply("Опишите оборудование заново:", Markup.removeKeyboard());
      return;
    }

    if (text === "✏️ Изменить даты") {
      setState(ctx, { step: "dates", startDate: undefined, endDate: undefined });
      await ctx.reply(
        "Введите период заново:\n_Например: «с 10 по 12 апреля»_",
        { parse_mode: "Markdown", ...Markup.removeKeyboard() },
      );
      return;
    }

    if (text === "❌ Отменить") {
      await ctx.reply("❌ Создание брони отменено.", Markup.removeKeyboard());
      await ctx.scene.leave();
      return;
    }

    await ctx.reply("Используйте кнопки ниже для подтверждения или изменения.");
  }
});
