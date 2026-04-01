import "dotenv/config";
import { Telegraf, Scenes, session } from "telegraf";
import type { BotContext } from "./types";
import { bookingScene } from "./scenes/booking";
import { crewCalcScene } from "./scenes/crewCalc";
import { photoAnalysisScene } from "./scenes/photoAnalysis";
import { BTN_AI_LIGHTING_ANALYSIS, mainMenuKeyboard } from "./keyboards";
import { logError, logInfo, LOG_FILE } from "./services/logger";
import { upsertUser } from "./services/api";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const bot = new Telegraf<BotContext>(token, {
  handlerTimeout: 180_000, // 3 min — Gemini 2.5 Flash может занять до 40s
});

// ── Session + Stage ───────────────────────────────────────────────────────────
const stage = new Scenes.Stage<BotContext>([bookingScene, crewCalcScene, photoAnalysisScene]);
bot.use(session());
bot.use(stage.middleware());

// ── Постоянное меню (кнопка Menu в интерфейсе Telegram) ──────────────────────
bot.telegram.setMyCommands([
  { command: "start", description: "🏠 Главное меню" },
  { command: "rental", description: "🎬 Аренда оборудования" },
  { command: "crewcalc", description: "💡 Калькулятор осветителей" },
  {
    command: "frame",
    description: "✨ AI анализ освещений — бюджет по референсу",
  },
  { command: "cancel", description: "❌ Отменить / в главное меню" },
]);

function sendMainMenu(ctx: BotContext, text: string) {
  return ctx.reply(text, { parse_mode: "Markdown", ...mainMenuKeyboard });
}

// ── Команды ───────────────────────────────────────────────────────────────────
const mainMenuIntroText =
  `👋 Добро пожаловать в *Light Rental*!\n\n` +
  `*🎬 Аренда оборудования* — заявка на бронь\n` +
  `*💡 Калькулятор осветителей* — расчёт ставок бригады\n` +
  `*✨ AI анализ освещений* — по референсу (кадру) оценить бюджет на свет: разбор освещения и смета по каталогу\n\n` +
  `Кнопки ниже или /rental, /crewcalc, /frame`;

const helpMenuText =
  `*Справка*\n\n` +
  `*🎬 Аренда оборудования* — заявка на бронь\n` +
  `*💡 Калькулятор осветителей* — расчёт ставок\n` +
  `*✨ AI анализ освещений* — инструмент, который по референсу помогает оценить бюджет на свет\n\n` +
  `/rental, /crewcalc, /frame, /cancel`;

bot.start(async (ctx) => {
  if (ctx.from) {
    upsertUser({
      telegramId: ctx.from.id,
      username: ctx.from.username ?? null,
      firstName: ctx.from.first_name ?? null,
    }).catch(() => {}); // фоновый upsert — не блокирует ответ
  }
  await sendMainMenu(ctx, mainMenuIntroText);
});

bot.help(async (ctx) => {
  await sendMainMenu(ctx, helpMenuText);
});

async function enterBooking(ctx: BotContext) {
  await ctx.scene.enter("booking");
}

async function enterCrewCalc(ctx: BotContext) {
  await ctx.scene.enter("crewCalc");
}

async function enterPhotoAnalysis(ctx: BotContext) {
  await ctx.reply(
    "📸 Пришлите *референс* (кадр, стоп‑кадр) — AI разберёт освещение и соберёт смету по нашему каталогу, чтобы было проще оценить бюджет на свет.",
    { parse_mode: "Markdown" },
  );
}

bot.command("rental", enterBooking);
bot.command("crewcalc", enterCrewCalc);
bot.command("frame", enterPhotoAnalysis);

bot.hears("🎬 Аренда оборудования", enterBooking);
bot.hears("💡 Калькулятор осветителей", enterCrewCalc);
bot.hears(BTN_AI_LIGHTING_ANALYSIS, enterPhotoAnalysis);

/** Фото вне сцены — запускаем анализ освещения */
bot.on("photo", async (ctx) => {
  if (ctx.session?.__scenes?.current) return; // уже в сцене — сцена сама обработает
  await ctx.scene.enter("photoAnalysis");
});

/** /cancel вне сцен — главное меню (в сценах отмену обрабатывает сама сцена) */
bot.command("cancel", async (ctx) => {
  if (ctx.session?.__scenes?.current) return;
  await sendMainMenu(ctx, "🏠 *Главное меню*");
});

// ── Обработка ошибок ──────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  const isTimeout = err instanceof Error && err.name === "TimeoutError";
  const context = `update:${ctx.updateType}`;
  const message = isTimeout
    ? "Telegraf handler timeout (>90s) — вероятно зависание OpenAI"
    : "Unhandled bot error";
  logError(context, message, err);

  ctx
    .reply(
      isTimeout
        ? "⏱ Запрос занял слишком много времени. Попробуйте написать короче или /cancel."
        : "⚠️ Произошла ошибка. Попробуйте ещё раз или /cancel.",
      mainMenuKeyboard,
    )
    .catch(() => {});
});

// ── Запуск ────────────────────────────────────────────────────────────────────
const WEBHOOK_DOMAIN = process.env.WEBHOOK_DOMAIN;
const WEBHOOK_PORT = Number(process.env.WEBHOOK_PORT ?? 3001);
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET ?? "";

if (WEBHOOK_DOMAIN) {
  // Webhook-режим: Telegram шлёт POST на WEBHOOK_DOMAIN/telegram
  const webhookPath = "/telegram";

  bot.launch({
    webhook: {
      domain: WEBHOOK_DOMAIN,
      path: webhookPath,
      port: WEBHOOK_PORT,
      secretToken: WEBHOOK_SECRET || undefined,
    },
  }).then(() => {
    logInfo("startup", `Bot started in WEBHOOK mode on port ${WEBHOOK_PORT}${webhookPath}. Error log: ${LOG_FILE}`);
  });
} else {
  // Polling-режим (локальная разработка по умолчанию)
  bot.launch().then(() => {
    logInfo("startup", `Bot started in POLLING mode. Error log: ${LOG_FILE}`);
  });
}

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
