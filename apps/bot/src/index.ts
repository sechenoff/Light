import "dotenv/config";
import { Telegraf, Scenes, session, Markup } from "telegraf";
import type { BotContext } from "./types";
import { bookingScene } from "./scenes/booking";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set");

const bot = new Telegraf<BotContext>(token);

// ── Session + Stage ───────────────────────────────────────────────────────────
const stage = new Scenes.Stage<BotContext>([bookingScene]);
bot.use(session());
bot.use(stage.middleware());

// ── Команды ───────────────────────────────────────────────────────────────────
bot.start(async (ctx) => {
  await ctx.reply(
    `👋 Добро пожаловать в систему *Light Rental*!\n\n` +
    `Я помогу вам оформить заявку на аренду оборудования.\n\n` +
    `Используйте кнопку ниже или команду /newbooking для создания брони.`,
    {
      parse_mode: "Markdown",
      ...Markup.keyboard([["📋 Новая бронь"]]).resize(),
    },
  );
});

bot.help(async (ctx) => {
  await ctx.reply(
    `*Команды:*\n` +
    `📋 /newbooking — создать новую бронь\n` +
    `❌ /cancel — отменить текущее действие\n` +
    `/help — эта справка`,
    { parse_mode: "Markdown" },
  );
});

bot.command("newbooking", (ctx) => ctx.scene.enter("booking"));
bot.hears("📋 Новая бронь", (ctx) => ctx.scene.enter("booking"));

// ── Обработка ошибок ──────────────────────────────────────────────────────────
bot.catch((err, ctx) => {
  console.error(`[Bot] Error for update ${ctx.updateType}:`, err);
  ctx
    .reply("⚠️ Произошла ошибка. Попробуйте ещё раз или напишите /cancel.")
    .catch(() => {});
});

// ── Запуск ────────────────────────────────────────────────────────────────────
bot.launch().then(() => {
  console.log("[Bot] Started successfully");
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
