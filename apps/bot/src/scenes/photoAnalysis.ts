import { Scenes } from "telegraf";
import type { BotContext, PhotoAnalysisResult, MatchedItem, EstimateResult } from "../types";
import { analyzePhoto, upsertUser, createPendingAnalysis } from "../services/api";
import {
  photoAnalysisResultKeyboard,
  photoAnalysisEstimateKeyboard,
  mainMenuKeyboard,
} from "../keyboards";

export const photoAnalysisScene = new Scenes.BaseScene<BotContext>("photoAnalysis");

// ── Вход в сцену ──────────────────────────────────────────────────────────────
photoAnalysisScene.enter(async (ctx) => {
  const msg = ctx.message;
  if (!msg || !("photo" in msg) || !msg.photo?.length) {
    await ctx.reply("Пожалуйста, отправьте изображение.", mainMenuKeyboard);
    return ctx.scene.leave();
  }
  await handlePhoto(ctx);
});

photoAnalysisScene.on("photo", async (ctx) => {
  await handlePhoto(ctx);
});

// ── Кнопка: Рассчитать смету ──────────────────────────────────────────────────
photoAnalysisScene.action("photo_analysis:estimate", async (ctx) => {
  await ctx.answerCbQuery();

  const draft = getDraft(ctx);
  const estimate = draft?.estimate;

  if (!estimate || estimate.lines.length === 0) {
    await ctx.answerCbQuery("Смета недоступна", { show_alert: true });
    return;
  }

  await ctx.reply(buildEstimateText(estimate), {
    parse_mode: "Markdown",
    ...photoAnalysisEstimateKeyboard,
  });
});

// ── Кнопка: Сделать дешевле ───────────────────────────────────────────────────
photoAnalysisScene.action("photo_analysis:cheaper", async (ctx) => {
  await ctx.answerCbQuery();

  const draft = getDraft(ctx);
  const estimate = draft?.estimate;
  const analogCount = estimate?.lines.filter((l) => l.isAnalog).length ?? 0;

  if (!estimate || estimate.lines.length === 0) {
    await ctx.reply(
      "💸 *Бюджетный вариант*\n\n" +
        "Не удалось подобрать альтернативы — совпадений с каталогом не найдено.\n\n" +
        "Оставьте заявку, и менеджер подберёт доступное оборудование вручную.",
      { parse_mode: "Markdown", ...photoAnalysisEstimateKeyboard },
    );
    return;
  }

  const analog =
    analogCount > 0
      ? `\nℹ️ ${analogCount} позиц. уже подобраны как аналоги (отмечены звёздочкой).`
      : "";

  await ctx.reply(
    "💸 *Бюджетный вариант*\n\n" +
      "Менеджер подберёт наиболее доступное сочетание оборудования под ваш кадр — " +
      "расскажите о бюджете в комментарии к заявке." +
      analog,
    { parse_mode: "Markdown", ...photoAnalysisEstimateKeyboard },
  );
});

// ── Кнопка: Премиум версия ────────────────────────────────────────────────────
photoAnalysisScene.action("photo_analysis:premium", async (ctx) => {
  await ctx.answerCbQuery();

  const draft = getDraft(ctx);
  const estimate = draft?.estimate;

  const grand = estimate
    ? `\n\nОриентировочная смета стандартного набора: *${Number(estimate.grandTotal).toLocaleString("ru-RU")} ₽ / смена*.`
    : "";

  await ctx.reply(
    "⭐️ *Премиум версия*\n\n" +
      "Мы подберём топовые источники света, флагманские рефлекторы и аксессуары уровня кино-производства. " +
      "Оставьте заявку — менеджер рассчитает премиум-комплект под ваш проект." +
      grand,
    { parse_mode: "Markdown", ...photoAnalysisEstimateKeyboard },
  );
});

// ── Кнопка: Оставить заявку ───────────────────────────────────────────────────
photoAnalysisScene.action("photo_analysis:book", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup(undefined);

  const draft = getDraft(ctx);
  const items: MatchedItem[] = draft?.items ?? [];

  if (items.length === 0) {
    await ctx.reply(
      "Совпадений с каталогом не найдено. Создайте заявку вручную через 🎬 Аренда оборудования.",
      mainMenuKeyboard,
    );
    return ctx.scene.leave();
  }

  await ctx.scene.enter("booking", { prefilledItems: items });
});

// ── Основная логика анализа ───────────────────────────────────────────────────
async function handlePhoto(ctx: BotContext): Promise<void> {
  const msg = ctx.message;
  if (!msg || !("photo" in msg) || !msg.photo?.length) return;

  const waitMsg = await ctx.reply("⏳ Анализирую освещение…");
  await ctx.sendChatAction("upload_photo");

  // Периодически обновляем индикатор "печатает" пока Gemini думает (каждые 4 сек)
  const chatActionInterval = setInterval(() => {
    ctx.sendChatAction("upload_photo").catch(() => {});
  }, 4000);

  try {
    // 1. Upsert пользователя
    const from = ctx.from!;
    const user = await upsertUser({
      telegramId: from.id,
      username: from.username ?? null,
      firstName: from.first_name ?? null,
    });

    // 2. file_id наибольшей версии фото
    const largest = msg.photo[msg.photo.length - 1];
    const fileLink = await ctx.telegram.getFileLink(largest.file_id);
    const mimeType = detectMimeType(fileLink.toString());

    // 3. Создать запись Analysis со статусом PENDING
    const pending = await createPendingAnalysis({
      userId: user.id,
      telegramFileId: largest.file_id,
      telegramMimeType: mimeType,
    });

    setDraft(ctx, { analysisId: pending.id, userId: user.id });

    // 4. Скачать файл с Telegram
    const res = await fetch(fileLink.toString(), { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error("Не удалось скачать файл с Telegram");
    const imageBuffer = Buffer.from(await res.arrayBuffer());

    // 5. AI-анализ (один вызов Gemini; analysisId передаётся чтобы сервер сохранил результат в БД)
    const analysis = await analyzePhoto(imageBuffer, mimeType, pending.id);

    clearInterval(chatActionInterval);
    mergeDraft(ctx, { items: analysis.matchedEquipment, estimate: analysis.estimate });

    await ctx.telegram.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => {});

    const resultText = buildResultText(analysis);

    if (analysis.diagramBase64) {
      // Отправляем диаграмму без caption (caption ограничен 1024 символами)
      await ctx.replyWithPhoto({ source: Buffer.from(analysis.diagramBase64, "base64") });
      // Полный текст + кнопки отдельным сообщением
      await ctx.reply(resultText, { parse_mode: "Markdown", ...photoAnalysisResultKeyboard });
    } else {
      await ctx.reply(resultText, { parse_mode: "Markdown", ...photoAnalysisResultKeyboard });
    }
  } catch (err) {
    clearInterval(chatActionInterval);
    await ctx.telegram.deleteMessage(ctx.chat!.id, waitMsg.message_id).catch(() => {});
    console.error("[handlePhoto] error:", err);
    const message = err instanceof Error ? err.message : "Неизвестная ошибка";

    let userText: string;
    if (message === "AI_QUOTA_EXCEEDED" || message.includes("429") || message.includes("quota")) {
      userText =
        "⏳ AI-сервис сейчас перегружен — слишком много запросов. " +
        "Подождите 30–60 секунд и попробуйте снова.";
    } else if (message.includes("Не удалось скачать")) {
      userText = "❌ Не удалось загрузить фото из Telegram. Попробуйте ещё раз.";
    } else {
      userText =
        "⚠️ Не удалось проанализировать фото. " +
        "Убедитесь что это кинематографический кадр и попробуйте снова или /cancel.";
    }

    await ctx.reply(userText);
    await ctx.scene.leave();
  }
}

// ── Форматирование текста ─────────────────────────────────────────────────────

/**
 * Начальное сообщение под диаграммой.
 * Содержит: анализ сцены → список оборудования → дисклеймер.
 * Цены намеренно скрыты — раскрываются кнопкой «Рассчитать смету».
 */
function buildResultText(analysis: PhotoAnalysisResult): string {
  const { description, estimate, unmatchedNames } = analysis;

  const parts: string[] = [];

  // Блок 1: Анализ сцены
  parts.push(`🎬 *Вероятная реконструкция освещения*\n\n${description}`);

  // Блок 2: Список оборудования
  if (estimate.lines.length > 0) {
    const equipmentLines = estimate.lines.map((line) => {
      const analog = line.isAnalog ? " \\*" : "";
      return `• ${line.name}${analog} × ${line.quantity} шт`;
    });

    parts.push("*Оборудование из каталога:*\n" + equipmentLines.join("\n"));

    if (estimate.lines.some((l) => l.isAnalog)) {
      parts.push("_\\* — подобран аналог из каталога_");
    }
  } else {
    parts.push("_Совпадений с каталогом не найдено._");
  }

  if (unmatchedNames.length > 0) {
    parts.push(`_Не найдено в каталоге:_ ${unmatchedNames.join(", ")}`);
  }

  // Блок 3: Дисклеймер
  parts.push(
    "⚠️ _Инструмент помогает по референсу ориентировочно оценить бюджет на свет; " +
      "это вероятная реконструкция, а не точное описание съёмки. " +
      "Точный состав и стоимость уточняет менеджер._",
  );

  const full = parts.join("\n\n");
  // Telegram text limit is 4096 chars — truncate if needed
  if (full.length > 4000) {
    return full.slice(0, 3950) + "\n\n…_[сокращено]_";
  }
  return full;
}

/**
 * Детализация сметы — показывается по кнопке «Рассчитать смету».
 */
function buildEstimateText(estimate: EstimateResult): string {
  const parts: string[] = ["💰 *Ориентировочная смета за 1 смену*\n"];

  for (const line of estimate.lines) {
    const analog = line.isAnalog ? " _(аналог)_" : "";
    const rate = Number(line.ratePerShift).toLocaleString("ru-RU");
    const total = Number(line.lineTotal).toLocaleString("ru-RU");
    parts.push(`• ${line.name}${analog}\n  ${line.quantity} шт × ${rate} ₽ = *${total} ₽*`);
  }

  const grand = Number(estimate.grandTotal).toLocaleString("ru-RU");
  parts.push(`\n*Итого: ${grand} ₽ / смена*`);
  parts.push(`_${estimate.disclaimer}_`);

  return parts.join("\n");
}

// ── Хелперы сессии ────────────────────────────────────────────────────────────

type Draft = { analysisId?: string; userId?: string; storagePath?: string; items?: MatchedItem[]; estimate?: EstimateResult };

function getDraft(ctx: BotContext): Draft | undefined {
  return (ctx.scene.session as Record<string, unknown>).photoAnalysis as Draft | undefined;
}

function setDraft(ctx: BotContext, value: Draft): void {
  (ctx.scene.session as Record<string, unknown>).photoAnalysis = value;
}

function mergeDraft(ctx: BotContext, patch: Partial<Draft>): void {
  const prev = getDraft(ctx) ?? {};
  setDraft(ctx, { ...prev, ...patch });
}

function detectMimeType(url: string): string {
  if (url.endsWith(".png")) return "image/png";
  if (url.endsWith(".webp")) return "image/webp";
  if (url.endsWith(".gif")) return "image/gif";
  return "image/jpeg";
}
