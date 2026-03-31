import "dotenv/config";
import { Telegraf, Scenes, session, Markup } from "telegraf";
import type { BotContext } from "./types";
import { bookingScene } from "./scenes/booking";
import { crewCalcScene } from "./scenes/crewCalc";
import { photoAnalysisScene } from "./scenes/photoAnalysis";
import { mainMenuKeyboard } from "./keyboards";
import { logError, logInfo, LOG_FILE } from "./services/logger";
import {
  assignOpsTask,
  confirmOpsRole,
  createOpsTaskManual,
  escalateOpsChat,
  getActiveOpsChats,
  getDueOpsReminders,
  getOpsBlockers,
  getOpsChatMembers,
  getOpsDailySummary,
  getOpsDecisions,
  getOpsDiscussionFollowUps,
  getOpsMemberStats,
  getOpsOwners,
  getOpsProjectStatus,
  getOpsRiskData,
  getOpsTasks,
  getOpsUnresolved,
  getOpsWeeklyStats,
  ingestOpsMessage,
  markDiscussionFollowUpSent,
  markOpsReminderSent,
  postOpsDecision,
  setOpsMode,
  updateOpsChatSettings,
  updateOpsTaskStatus,
  upsertUser,
} from "./services/api";
import {
  extractOpsFromMessage,
  generateDailySummaryText,
  generateRiskReport,
  generateWeeklyReportText,
} from "./services/opsNlp";

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
  { command: "frame", description: "$$$ Кадр (AI) — анализ освещения" },
  { command: "ops_mode", description: "🧭 Режим: observer|coordinator|dispatcher|manager" },
  { command: "ops_tasks", description: "📋 Активные задачи" },
  { command: "ops_add", description: "➕ Создать задачу вручную" },
  { command: "ops_task", description: "📌 Задача из ответа на сообщение" },
  { command: "ops_assign", description: "👤 Назначить: /ops_assign 3 @user" },
  { command: "ops_done", description: "✅ Закрыть задачу: /ops_done 3" },
  { command: "ops_block", description: "🚫 Заблокировать задачу: /ops_block 3" },
  { command: "ops_reopen", description: "🔄 Переоткрыть задачу: /ops_reopen 3" },
  { command: "ops_weekly", description: "📊 Weekly-отчёт" },
  { command: "ops_daily", description: "🗓 Daily-сводка" },
  { command: "ops_owners", description: "👥 Кто за что отвечает" },
  { command: "ops_blockers", description: "🚧 Что блокирует проект" },
  { command: "ops_project", description: "📊 Статус проекта [название]" },
  { command: "ops_unresolved", description: "❓ Нерешённые обсуждения" },
  { command: "ops_decisions", description: "📝 Протокол решений" },
  { command: "ops_risk", description: "⚠️ Риски дня" },
  { command: "ops_stats", description: "📈 Статистика участников" },
  { command: "ops_settings", description: "⚙️ Настройки бота в чате" },
  { command: "cancel", description: "❌ Отменить / в главное меню" },
  { command: "help", description: "ℹ️ Справка" },
]);

const roleConfirmState = new Map<
  string,
  { telegramChatId: string; telegramUserId: string; roleName: string }
>();
const taskAssignState = new Map<string, { taskId: string; title: string }>();
const adminCache = new Map<string, { expiresAt: number; ids: Set<number> }>();
const memberCache = new Map<
  string,
  {
    expiresAt: number;
    members: Array<{ telegramUserId: string; username: string | null; firstName: string | null; isAdmin: boolean }>;
  }
>();

async function getCachedMembers(telegramChatId: string) {
  const cached = memberCache.get(telegramChatId);
  if (cached && cached.expiresAt > Date.now()) return cached.members;
  try {
    const { members } = await getOpsChatMembers(telegramChatId);
    memberCache.set(telegramChatId, { expiresAt: Date.now() + 10 * 60_000, members });
    return members;
  } catch {
    return [];
  }
}

const TRIVIAL_PATTERN = /^[\p{Emoji_Presentation}\s.,!?+\-*/=@#№()[\]{}"':;<>]+$/u;
function isTrivialMessage(text: string): boolean {
  if (text.length < 12) return true;
  if (TRIVIAL_PATTERN.test(text)) return true;
  return false;
}

// ── LLM throttle ────────────────────────────────────────────────────────────
// Ограничиваем LLM-запросы: не чаще 1 раза в OPS_LLM_THROTTLE_SEC секунд на чат.
// Если сообщение содержит сигнальные слова (задача, дедлайн и т.п.) — обрабатывается сразу.
const LLM_THROTTLE_MS = Number(process.env.OPS_LLM_THROTTLE_SEC ?? 20) * 1000;
const llmLastCall = new Map<string, number>();

const SIGNAL_WORDS =
  /задач|задание|сделай|нужно|надо|дедлайн|срок|ответственн|назначь|поручи|готово|сделано|заблок|ждёт|зависит|решили|договорились|утвердили/i;

function shouldThrottleLlm(chatId: string, text: string): boolean {
  if (SIGNAL_WORDS.test(text)) return false; // приоритетные — не ограничиваем
  const last = llmLastCall.get(chatId) ?? 0;
  return Date.now() - last < LLM_THROTTLE_MS;
}

function markLlmCall(chatId: string) {
  llmLastCall.set(chatId, Date.now());
}

async function getAdminIdsForChat(ctx: BotContext): Promise<Set<number>> {
  if (!ctx.chat) return new Set();
  const chatKey = String(ctx.chat.id);
  const cached = adminCache.get(chatKey);
  if (cached && cached.expiresAt > Date.now()) return cached.ids;

  try {
    const admins = await ctx.getChatAdministrators();
    const ids = new Set<number>(admins.map((admin) => admin.user.id));
    adminCache.set(chatKey, { expiresAt: Date.now() + 5 * 60_000, ids });
    return ids;
  } catch {
    return new Set();
  }
}

function sendMainMenu(ctx: BotContext, text: string) {
  return ctx.reply(text, { parse_mode: "Markdown", ...mainMenuKeyboard });
}

// ── Команды ───────────────────────────────────────────────────────────────────
const mainMenuIntroText =
  `👋 Добро пожаловать в *Light Rental*!\n\n` +
  `*🎬 Аренда оборудования* — заявка на бронь\n` +
  `*💡 Калькулятор осветителей* — расчёт ставок\n` +
  `*$$$ Кадр (AI)* — отправьте кадр, получите список света и смету\n\n` +
  `Выберите раздел кнопками или командами /rental, /crewcalc, /frame`;

const helpMenuText =
  `*Справка*\n\n` +
  `*🎬 Аренда оборудования* — заявка на бронь\n` +
  `*💡 Калькулятор осветителей* — расчёт ставок\n` +
  `*$$$ Кадр (AI)* — пришлите кадр → AI восстановит освещение и рассчитает смету\n\n` +
  `Кнопки меню или команды /rental, /crewcalc, /frame\n\n` +
  `/cancel — в главное меню`;

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
    "📸 Отправьте кадр — AI восстановит вероятное освещение и предложит список оборудования из каталога.",
  );
}

bot.command("rental", enterBooking);
bot.command("crewcalc", enterCrewCalc);
bot.command("frame", enterPhotoAnalysis);

bot.hears("🎬 Аренда оборудования", enterBooking);
bot.hears("💡 Калькулятор осветителей", enterCrewCalc);
bot.hears("$$$ Кадр (AI)", enterPhotoAnalysis);

bot.hears("ℹ️ Помощь", async (ctx) => {
  await sendMainMenu(ctx, helpMenuText);
});

/** Фото вне сцены — запускаем анализ освещения */
bot.on("photo", async (ctx) => {
  if (ctx.session?.__scenes?.current) return; // уже в сцене — сцена сама обработает
  await ctx.scene.enter("photoAnalysis");
});

bot.hears("🏠 Главное меню", async (ctx) => {
  if (ctx.session?.__scenes?.current) return;
  await sendMainMenu(ctx, "🏠 *Главное меню*");
});

/** /cancel вне сцен — главное меню (в сценах отмену обрабатывает сама сцена) */
bot.command("cancel", async (ctx) => {
  if (ctx.session?.__scenes?.current) return;
  await sendMainMenu(ctx, "🏠 *Главное меню*");
});

bot.command("ops_mode", async (ctx) => {
  if (!ctx.chat) return;
  const chatType = ctx.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const text = "text" in ctx.message ? ctx.message.text : "";
  const modeArg = text.split(" ")[1]?.trim().toUpperCase();
  const mode =
    modeArg === "OBSERVER" || modeArg === "COORDINATOR" || modeArg === "DISPATCHER" || modeArg === "MANAGER"
      ? modeArg
      : null;
  if (!mode) {
    await ctx.reply("Использование: /ops_mode observer|coordinator|dispatcher|manager");
    return;
  }
  await setOpsMode(String(ctx.chat.id), mode);
  await ctx.reply(`Режим обновлён: ${mode}`);
});

bot.command("ops_tasks", async (ctx) => {
  if (!ctx.chat) return;
  const chatType = ctx.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const { tasks } = await getOpsTasks(String(ctx.chat.id));
  if (tasks.length === 0) {
    await ctx.reply("Активных задач пока нет.");
    return;
  }
  const lines = tasks.slice(0, 10).map((task, index) => {
    const assignee = task.assigneeTelegramUserId ? `@${task.assigneeTelegramUserId}` : "не назначен";
    const due = task.dueAt ? new Date(task.dueAt).toLocaleString("ru-RU") : "без срока";
    return `${index + 1}. ${task.title}\n   статус: ${task.status}, срок: ${due}, ответственный: ${assignee}`;
  });
  await ctx.reply(`Активные задачи:\n\n${lines.join("\n")}`);
});

bot.command("ops_daily", async (ctx) => {
  if (!ctx.chat) return;
  const chatType = ctx.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const summary = await getOpsDailySummary(String(ctx.chat.id));
  if (!summary.exists) {
    await ctx.reply("По этому чату ещё нет данных.");
    return;
  }
  await ctx.reply(
    `За сегодня:\n` +
      `— создано задач: ${summary.created}\n` +
      `— выполнено: ${summary.done}\n` +
      `— просрочено: ${summary.overdue}\n` +
      `— без ответственного: ${summary.withoutAssignee}\n` +
      `— в блокере: ${summary.blocked}`,
  );
});

bot.command("ops_owners", async (ctx) => {
  if (!ctx.chat) return;
  const chatType = ctx.chat.type;
  if (chatType !== "group" && chatType !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const { owners } = await getOpsOwners(String(ctx.chat.id));
  if (owners.length === 0) {
    await ctx.reply("Карта ролей пока не собрана.");
    return;
  }
  const lines = owners.map((owner) => {
    const conf = Math.round(Number(owner.confidence) * 100);
    const tag = owner.status === "CONFIRMED" ? "✅" : "?";
    return `${tag} ${owner.roleName}: @${owner.telegramUserId} (${conf}%)`;
  });
  await ctx.reply(`Кто за что отвечает:\n${lines.join("\n")}`);
});

bot.command("ops_blockers", async (ctx) => {
  if (!ctx.chat) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const { blockers } = await getOpsBlockers(String(ctx.chat.id));
  if (blockers.length === 0) {
    await ctx.reply("Блокеров не обнаружено.");
    return;
  }
  const lines: string[] = ["Блокеры:"];
  for (const task of blockers) {
    const assignee = task.assigneeTelegramUserId ? `@${task.assigneeTelegramUserId}` : "нет ответственного";
    const due = task.dueAt ? `срок ${new Date(task.dueAt).toLocaleDateString("ru-RU")}` : "без срока";
    lines.push(`\n🚧 ${task.title}\n   ${assignee} · ${due}`);
    for (const dep of task.blockedBy) {
      lines.push(`   ← ждёт: ${dep.title}`);
    }
  }
  await ctx.reply(lines.join("\n"));
});

bot.command("ops_project", async (ctx) => {
  if (!ctx.chat) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const text = "text" in ctx.message ? ctx.message.text : "";
  const projectArg = text.split(" ").slice(1).join(" ").trim() || undefined;

  const status = await getOpsProjectStatus(String(ctx.chat.id), projectArg).catch(() => null);
  if (!status) {
    await ctx.reply("По этому чату ещё нет данных.");
    return;
  }

  const lines: string[] = [
    `Статус проекта${status.projectName ? ` — ${status.projectName}` : ""}:`,
    ``,
  ];

  if (status.nearDeadlineTasks.length > 0) {
    lines.push("⏰ Ближайшие дедлайны:");
    for (const t of status.nearDeadlineTasks) {
      const due = t.dueAt ? new Date(t.dueAt).toLocaleString("ru-RU") : "–";
      const a = t.assigneeUsername ? `@${t.assigneeUsername}` : "нет";
      lines.push(`  · ${t.title} (${due}, ${a})`);
    }
    lines.push("");
  }

  if (status.overdueTasks.length > 0) {
    lines.push("⚠️ Просрочено:");
    for (const t of status.overdueTasks) {
      const a = t.assigneeTelegramUserId ? `@${t.assigneeTelegramUserId}` : "нет";
      lines.push(`  · ${t.title} — ${a}`);
    }
    lines.push("");
  }

  if (status.blockedTasks.length > 0) {
    lines.push("🚧 Блокеры:");
    for (const t of status.blockedTasks) {
      const a = t.assigneeTelegramUserId ? `@${t.assigneeTelegramUserId}` : "нет";
      lines.push(`  · ${t.title} — ${a}`);
    }
    lines.push("");
  }

  lines.push(
    `📋 В работе: ${status.openTasks.length} · ✅ Готово: ${status.doneTasks}`,
  );

  await ctx.reply(lines.join("\n"));
});

bot.command("ops_unresolved", async (ctx) => {
  if (!ctx.chat) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const { discussions } = await getOpsUnresolved(String(ctx.chat.id));
  if (discussions.length === 0) {
    await ctx.reply("Нерешённых обсуждений не обнаружено.");
    return;
  }
  const lines = discussions.slice(0, 10).map((d) => {
    const age = Math.round((Date.now() - new Date(d.lastActivityAt).getTime()) / (60 * 60 * 1000));
    return `❓ ${d.topic}\n   без движения: ${age} ч.`;
  });
  await ctx.reply(`Нерешённые обсуждения:\n\n${lines.join("\n")}`);
});

bot.command("ops_decisions", async (ctx) => {
  if (!ctx.chat) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const { decisions } = await getOpsDecisions(String(ctx.chat.id), 10);
  if (decisions.length === 0) {
    await ctx.reply("Протокол решений пока пуст.");
    return;
  }
  const lines = decisions.map((d) => {
    const who = d.madeByUsername ? `@${d.madeByUsername}` : (d.madeByFirstName ?? "?");
    const date = new Date(d.createdAt).toLocaleDateString("ru-RU");
    const project = d.projectName ? ` [${d.projectName}]` : "";
    return `• ${d.text}${project}\n  — ${who}, ${date}`;
  });
  await ctx.reply(`Последние решения:\n\n${lines.join("\n")}`);
});

bot.command("ops_risk", async (ctx) => {
  if (!ctx.chat) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const data = await getOpsRiskData(String(ctx.chat.id)).catch(() => null);
  if (!data) {
    await ctx.reply("Нет данных по рискам.");
    return;
  }
  const report = await generateRiskReport(data);
  await ctx.reply(report);
});

bot.command("ops_stats", async (ctx) => {
  if (!ctx.chat) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const { stats } = await getOpsMemberStats(String(ctx.chat.id));
  if (stats.length === 0) {
    await ctx.reply("Статистики по участникам ещё нет.");
    return;
  }
  const lines = stats.slice(0, 10).map((s) => {
    const name = s.username ? `@${s.username}` : (s.firstName ?? "?");
    const rate = `${s.done}/${s.total}`;
    const warn = s.overdueRate >= 30 ? " ⚠️" : "";
    return `${name}: ${rate}${s.overdue > 0 ? `, ${s.overdue} просроч.` : ""}${warn}`;
  });
  await ctx.reply(`Статистика участников:\n${lines.join("\n")}`);
});

bot.command("ops_settings", async (ctx) => {
  if (!ctx.chat) return;
  if (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup") {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const text = "text" in ctx.message ? ctx.message.text : "";
  const parts = text.split(/\s+/).slice(1);

  if (parts.length === 0) {
    await ctx.reply(
      "Настройки бота:\n\n" +
        "/ops_settings quiet <от> <до> — тихие часы (0-23)\n" +
        "/ops_settings strictness <0-100> — частота уточнений\n\n" +
        "Пример: /ops_settings quiet 23 9\n" +
        "Пример: /ops_settings strictness 70",
    );
    return;
  }

  if (parts[0] === "quiet" && parts[1] !== undefined && parts[2] !== undefined) {
    const from = parseInt(parts[1], 10);
    const to = parseInt(parts[2], 10);
    if (isNaN(from) || isNaN(to) || from < 0 || from > 23 || to < 0 || to > 23) {
      await ctx.reply("Неверный формат. Пример: /ops_settings quiet 23 9");
      return;
    }
    await updateOpsChatSettings({ telegramChatId: String(ctx.chat.id), quietHoursFrom: from, quietHoursTo: to });
    await ctx.reply(`Тихие часы обновлены: ${from}:00 — ${to}:00`);
    return;
  }

  if (parts[0] === "strictness" && parts[1] !== undefined) {
    const val = parseInt(parts[1], 10);
    if (isNaN(val) || val < 0 || val > 100) {
      await ctx.reply("Значение должно быть от 0 до 100. Пример: /ops_settings strictness 70");
      return;
    }
    await updateOpsChatSettings({ telegramChatId: String(ctx.chat.id), strictness: val });
    await ctx.reply(`Строгость обновлена: ${val}/100`);
    return;
  }

  await ctx.reply("Неизвестная настройка. /ops_settings для списка.");
});

// ── Ручное управление задачами ─────────────────────────────────────────────

function opsGroupOnly(ctx: BotContext) {
  const t = ctx.chat?.type;
  return t === "group" || t === "supergroup";
}

/**
 * /ops_add <заголовок задачи> [@username] [до 18:00 завтра]
 * Создаёт задачу немедленно, без AI.
 */
bot.command("ops_add", async (ctx) => {
  if (!ctx.chat || !opsGroupOnly(ctx)) {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const text = "text" in ctx.message ? ctx.message.text : "";
  const raw = text.replace(/^\/ops_add\s*/i, "").trim();
  if (!raw) {
    await ctx.reply("Использование: /ops_add Название задачи [@username] [до ДД.ММ ЧЧ:ММ]\n\nПример:\n/ops_add Подготовить смету @lena до 28.03 18:00");
    return;
  }

  // Извлекаем @username
  const atMatch = raw.match(/@(\w+)/);
  const usernameHint = atMatch?.[1] ?? null;
  const titleRaw = raw.replace(/@\w+/g, "").trim();

  // Находим assignee по username в кэше членов
  const members = await getCachedMembers(String(ctx.chat.id));
  const assignee = usernameHint
    ? members.find((m) => m.username?.toLowerCase() === usernameHint.toLowerCase())
    : undefined;

  try {
    const task = await createOpsTaskManual({
      telegramChatId: String(ctx.chat.id),
      title: titleRaw,
      assigneeTelegramUserId: assignee?.telegramUserId,
      createdByTelegramUserId: String(ctx.from?.id ?? ""),
    });
    const who = assignee ? ` → @${assignee.username}` : "";
    await ctx.reply(`✅ Задача создана: ${task.title}${who}\nID задачи: \`${task.id.slice(0, 8)}\``, {
      parse_mode: "Markdown",
    });
  } catch {
    await ctx.reply("Не удалось создать задачу. Попробуйте позже.");
  }
});

/**
 * /ops_done 3  — закрыть задачу №3 из /ops_tasks
 */
bot.command("ops_done", async (ctx) => {
  if (!ctx.chat || !opsGroupOnly(ctx)) return;
  await handleTaskStatusCommand(ctx, "DONE", "ops_done");
});

/**
 * /ops_block 3  — поставить задачу №3 в блокер
 */
bot.command("ops_block", async (ctx) => {
  if (!ctx.chat || !opsGroupOnly(ctx)) return;
  await handleTaskStatusCommand(ctx, "BLOCKED", "ops_block");
});

/**
 * /ops_reopen 3  — вернуть задачу №3 в IN_PROGRESS
 */
bot.command("ops_reopen", async (ctx) => {
  if (!ctx.chat || !opsGroupOnly(ctx)) return;
  await handleTaskStatusCommand(ctx, "IN_PROGRESS", "ops_reopen");
});

async function handleTaskStatusCommand(ctx: BotContext, newStatus: string, cmdName: string) {
  if (!ctx.message) return;
  const text = "text" in ctx.message ? ctx.message.text : "";
  const numStr = text.replace(/^\/\w+\s*/i, "").trim();
  const num = parseInt(numStr, 10);
  if (isNaN(num) || num < 1) {
    await ctx.reply(`Использование: /${cmdName} <номер задачи>\n\nСписок задач: /ops_tasks`);
    return;
  }

  const { tasks } = await getOpsTasks(String(ctx.chat!.id));
  const task = tasks[num - 1];
  if (!task) {
    await ctx.reply(`Задача #${num} не найдена. Всего задач: ${tasks.length}`);
    return;
  }

  const statusEmoji: Record<string, string> = {
    DONE: "✅",
    BLOCKED: "🚫",
    IN_PROGRESS: "🔄",
    NEW: "🆕",
  };

  try {
    await updateOpsTaskStatus({
      taskId: task.id,
      status: newStatus as "NEW" | "IN_PROGRESS" | "BLOCKED" | "DONE" | "OVERDUE",
      actorTelegramUserId: String(ctx.from?.id ?? ""),
    });
    await ctx.reply(
      `${statusEmoji[newStatus] ?? "📌"} Задача обновлена: ${task.title}\nСтатус: ${newStatus}`,
    );
  } catch {
    await ctx.reply("Не удалось обновить статус. Попробуйте позже.");
  }
}

/**
 * /ops_assign 3 @username — переназначить задачу №3 на другого участника.
 * Ищет @username среди членов чата в БД.
 */
bot.command("ops_assign", async (ctx) => {
  if (!ctx.chat || !opsGroupOnly(ctx)) {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const text = "text" in ctx.message ? ctx.message.text : "";
  const parts = text.replace(/^\/ops_assign\s*/i, "").trim().split(/\s+/);
  const num = parseInt(parts[0] ?? "", 10);
  const usernameRaw = (parts[1] ?? "").replace(/^@/, "");

  if (isNaN(num) || num < 1 || !usernameRaw) {
    await ctx.reply("Использование: /ops_assign <номер задачи> @username\n\nПример: /ops_assign 3 @lena");
    return;
  }

  const { tasks } = await getOpsTasks(String(ctx.chat.id));
  const task = tasks[num - 1];
  if (!task) {
    await ctx.reply(`Задача #${num} не найдена. Всего задач: ${tasks.length}`);
    return;
  }

  const members = await getCachedMembers(String(ctx.chat.id));
  const target = members.find((m) => m.username?.toLowerCase() === usernameRaw.toLowerCase());
  if (!target) {
    await ctx.reply(`@${usernameRaw} не найден среди участников чата.\nСписок: /ops_owners`);
    return;
  }

  try {
    await assignOpsTask({
      taskId: task.id,
      assigneeTelegramUserId: target.telegramUserId,
      actorTelegramUserId: String(ctx.from?.id ?? ""),
    });
    await ctx.reply(`✅ Задача #${num} «${task.title}» переназначена на @${target.username ?? usernameRaw}`);
  } catch {
    await ctx.reply("Не удалось назначить задачу. Попробуйте позже.");
  }
});

/**
 * /ops_task [название] — создать задачу из ответа на сообщение.
 * Если команда — реплай на чьё-то сообщение, текст этого сообщения
 * становится телом задачи. Необязательный аргумент переопределяет заголовок.
 */
bot.command("ops_task", async (ctx) => {
  if (!ctx.chat || !opsGroupOnly(ctx)) {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const cmdText = "text" in ctx.message ? ctx.message.text : "";
  const titleOverride = cmdText.replace(/^\/ops_task\s*/i, "").trim();

  const replyMsg = "reply_to_message" in ctx.message ? ctx.message.reply_to_message : null;
  const sourceText = replyMsg && "text" in replyMsg ? replyMsg.text : null;

  const title = titleOverride || sourceText || null;
  if (!title) {
    await ctx.reply(
      "Ответьте на сообщение командой /ops_task, или укажите название:\n" +
        "/ops_task Подготовить смету по свету",
    );
    return;
  }

  // Определяем возможного ответственного — автора исходного сообщения
  const replyFrom = replyMsg && "from" in replyMsg ? replyMsg.from : null;
  const assigneeId = replyFrom && !replyFrom.is_bot ? String(replyFrom.id) : undefined;

  try {
    const task = await createOpsTaskManual({
      telegramChatId: String(ctx.chat.id),
      title: title.slice(0, 300),
      assigneeTelegramUserId: assigneeId,
      createdByTelegramUserId: String(ctx.from?.id ?? ""),
    });
    const who = assigneeId ? ` → [исполнитель](tg://user?id=${assigneeId})` : "";
    await ctx.reply(`✅ Задача создана: *${task.title}*${who}`, { parse_mode: "Markdown" });
  } catch {
    await ctx.reply("Не удалось создать задачу.");
  }
});

/**
 * /ops_weekly — weekly-отчёт за последние 7 дней
 */
bot.command("ops_weekly", async (ctx) => {
  if (!ctx.chat || !opsGroupOnly(ctx)) {
    await ctx.reply("Команда доступна только в групповом чате.");
    return;
  }
  const weekly = await getOpsWeeklyStats(String(ctx.chat.id)).catch(() => null);
  if (!weekly) {
    await ctx.reply("Данных для weekly-отчёта пока нет.");
    return;
  }
  const text = generateWeeklyReportText(weekly);
  await ctx.reply(text);
});

bot.on("text", async (ctx, next) => {
  const chatType = ctx.chat?.type;
  if (chatType !== "group" && chatType !== "supergroup") return next();
  const text = "text" in ctx.message ? ctx.message.text.trim() : "";
  if (!text || text.startsWith("/")) return next();
  if (isTrivialMessage(text)) return next();

  const sender = ctx.from;
  const chatIdStr = String(ctx.chat.id);

  // Throttle: не дёргаем LLM чаще 1 раза в OPS_LLM_THROTTLE_SEC сек. на чат,
  // если это не приоритетное сообщение (содержащее сигнальные слова).
  if (shouldThrottleLlm(chatIdStr, text)) return next();
  markLlmCall(chatIdStr);
  const adminIds = await getAdminIdsForChat(ctx);
  const senderIsAdmin = adminIds.has(sender.id);

  const dbMembers = await getCachedMembers(chatIdStr);
  const senderInDb = dbMembers.find((m) => m.telegramUserId === String(sender.id));
  const members = [
    {
      telegramUserId: String(sender.id),
      username: sender.username ?? null,
      firstName: sender.first_name ?? null,
      isAdmin: senderIsAdmin,
    },
    ...dbMembers
      .filter((m) => m.telegramUserId !== String(sender.id))
      .map((m) => ({ ...m, isAdmin: m.isAdmin ?? false })),
  ];
  void senderInDb;

  const extraction = await extractOpsFromMessage({
    text,
    memberHints: members,
    projectHints: [],
  });

  const ingested = await ingestOpsMessage({
    chat: {
      telegramChatId: String(ctx.chat.id),
      title: "title" in ctx.chat ? ctx.chat.title : null,
      type: ctx.chat.type,
    },
    sender: {
      telegramUserId: String(sender.id),
      username: sender.username ?? null,
      firstName: sender.first_name ?? null,
      isAdmin: senderIsAdmin,
      isBot: sender.is_bot,
    },
    message: {
      telegramMessageId: ctx.message.message_id,
      text,
      messageDate: new Date(ctx.message.date * 1000).toISOString(),
      rawJson: JSON.stringify(ctx.message),
    },
    extraction,
  });

  if (extraction.task && ingested.createdTask && ingested.mode !== "OBSERVER") {
    const task = ingested.createdTask;
    const dueText = task.dueAt
      ? new Date(task.dueAt).toLocaleString("ru-RU")
      : "без срока";

    if (!task.assigneeTelegramUserId && extraction.task.needsConfirmation) {
      const candidates = (await getCachedMembers(chatIdStr))
        .filter((m) => !m.isAdmin || dbMembers.length <= 3)
        .slice(0, 5);

      if (candidates.length > 0) {
        const stateKey = Math.random().toString(36).slice(2, 9);
        taskAssignState.set(stateKey, { taskId: task.id, title: task.title });

        const buttons = candidates.map((m) =>
          Markup.button.callback(
            m.username ? `@${m.username}` : (m.firstName ?? `id${m.telegramUserId}`),
            `ta:${stateKey}:${m.telegramUserId}`,
          ),
        );
        buttons.push(Markup.button.callback("Пропустить", `ta:${stateKey}:skip`));

        await ctx.reply(
          `Задача зафиксирована: «${task.title}»\nСрок: ${dueText}\n\nКто возьмёт задачу?`,
          Markup.inlineKeyboard([buttons]),
        );
      } else {
        await ctx.reply(
          `Задача зафиксирована: «${task.title}»\nСрок: ${dueText}\nОтветственный не определён — уточните.`,
        );
      }
    } else {
      const assigneeText = task.assigneeTelegramUserId
        ? mentionTag(task.assigneeTelegramUserId)
        : "не назначен";
      if (!extraction.task.needsConfirmation || extraction.task.confidence >= 0.85) {
        await ctx.reply(
          `Задача зафиксирована\nИсполнитель: ${assigneeText}\nСрок: ${dueText}\nСтатус: NEW`,
          { parse_mode: "Markdown" },
        );
      } else {
        await ctx.reply(
          `Похоже, это задача:\n— «${task.title}»\n— срок: ${dueText}\n— ответственный: ${assigneeText}\nПодтвердите, если всё верно.`,
          { parse_mode: "Markdown" },
        );
      }
    }
  }

  if (ingested.mode !== "OBSERVER") {
    for (const roleCandidate of extraction.roleCandidates) {
      if (roleCandidate.confidence >= 0.85) continue;
      const key = Math.random().toString(36).slice(2, 9);
      roleConfirmState.set(key, {
        telegramChatId: String(ctx.chat.id),
        telegramUserId: roleCandidate.telegramUserId,
        roleName: roleCandidate.roleName,
      });
      await ctx.reply(
        `Похоже, @${roleCandidate.telegramUserId} отвечает за «${roleCandidate.roleName}». Верно?`,
        Markup.inlineKeyboard([
          [
            Markup.button.callback("Да, верно", `rc:${key}:ok`),
            Markup.button.callback("Нет", `rc:${key}:no`),
          ],
        ]),
      );
    }

    const extWithDiscussion = extraction as typeof extraction & {
      isUnresolvedDiscussion?: boolean;
      discussionTopic?: string;
    };
    if (
      extWithDiscussion.isUnresolvedDiscussion &&
      extWithDiscussion.discussionTopic &&
      (ingested.mode === "DISPATCHER" || ingested.mode === "MANAGER")
    ) {
      await fetch(
        `${process.env.API_BASE_URL ?? "http://localhost:4000"}/api/ops/discussions/upsert`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            telegramChatId: String(ctx.chat.id),
            topic: extWithDiscussion.discussionTopic,
            participantTelegramUserIds: [String(sender.id)],
          }),
        },
      ).catch(() => {});
    }

    if (
      extraction.messageType === "DECISION" &&
      extraction.messageTypeConfidence >= 0.8 &&
      text.length >= 10
    ) {
      const projectName = extraction.entities.projects[0] ?? undefined;
      await postOpsDecision({
        telegramChatId: String(ctx.chat.id),
        text,
        projectName,
      }).catch(() => {});
    }
  }
  return next();
});

bot.on("callback_query", async (ctx, next) => {
  if (!("data" in ctx.callbackQuery)) return next();
  const data = ctx.callbackQuery.data;

  if (data.startsWith("ta:")) {
    const [, stateKey, userId] = data.split(":");
    const item = taskAssignState.get(stateKey);
    if (!item) {
      await ctx.answerCbQuery("Уточнение устарело");
      return;
    }
    taskAssignState.delete(stateKey);
    if (userId === "skip") {
      await ctx.answerCbQuery("Пропустили назначение");
      await ctx.editMessageReplyMarkup(undefined);
      return;
    }
    await assignOpsTask({
      taskId: item.taskId,
      assigneeTelegramUserId: userId,
      actorTelegramUserId: ctx.from ? String(ctx.from.id) : undefined,
    });
    await ctx.answerCbQuery("Назначено");
    await ctx.editMessageText(
      `Задача «${item.title}» → назначена на [пользователя](tg://user?id=${userId})`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  if (data.startsWith("ts:")) {
    const [, taskId, state] = data.split(":");
    const statusMap: Record<string, "DONE" | "IN_PROGRESS" | "BLOCKED" | "OVERDUE"> = {
      done: "DONE",
      work: "IN_PROGRESS",
      blocker: "BLOCKED",
      move: "OVERDUE",
    };
    const status = statusMap[state];
    if (status) {
      await updateOpsTaskStatus({
        taskId,
        status,
        actorTelegramUserId: ctx.from ? String(ctx.from.id) : undefined,
      });
      await ctx.answerCbQuery("Статус обновлён");
      await ctx.editMessageReplyMarkup(undefined);
      return;
    }
  }

  if (data.startsWith("rc:")) {
    const [, key, verdict] = data.split(":");
    const item = roleConfirmState.get(key);
    if (!item) {
      await ctx.answerCbQuery("Уточнение устарело");
      return;
    }
    await confirmOpsRole({
      telegramChatId: item.telegramChatId,
      telegramUserId: item.telegramUserId,
      roleName: item.roleName,
      status: verdict === "ok" ? "CONFIRMED" : "REJECTED",
    });
    roleConfirmState.delete(key);
    await ctx.answerCbQuery(verdict === "ok" ? "Сохранил подтверждение" : "Ок, отклонил");
    await ctx.editMessageReplyMarkup(undefined);
    return;
  }

  return next();
});

function mentionTag(userId: string | null): string {
  if (!userId) return "";
  return ` [упомянуть](tg://user?id=${userId})`;
}

const remindersIntervalMs = Number(process.env.OPS_REMINDERS_INTERVAL_MS ?? 60_000);
const escalationIntervalMs = Number(process.env.OPS_ESCALATION_INTERVAL_MS ?? 10 * 60_000);

setInterval(async () => {
  try {
    const { reminders } = await getDueOpsReminders();
    for (const reminder of reminders) {
      const chatId = Number(reminder.chatTelegramId);
      try {
        if (reminder.kind === "DAILY_SUMMARY") {
          const daily = await getOpsDailySummary(reminder.chatTelegramId);
          if (daily.exists) {
            const text = await generateDailySummaryText({
              chatTitle: null,
              created: daily.created,
              done: daily.done,
              overdue: daily.overdue,
              withoutAssignee: daily.withoutAssignee,
              blocked: daily.blocked,
            });
            await bot.telegram.sendMessage(chatId, text);
          }
          await markOpsReminderSent(reminder.id);
          continue;
        }

        if (reminder.kind === "WEEKLY_REPORT") {
          const weekly = await getOpsWeeklyStats(reminder.chatTelegramId);
          if (weekly) {
            const text = generateWeeklyReportText(weekly);
            await bot.telegram.sendMessage(chatId, text);
          }
          await markOpsReminderSent(reminder.id);
          continue;
        }

        if (!reminder.task) {
          await markOpsReminderSent(reminder.id);
          continue;
        }

        const task = reminder.task;
        if (task.status === "DONE") {
          await markOpsReminderSent(reminder.id);
          continue;
        }

        const mention = task.assigneeTelegramUserId
          ? mentionTag(task.assigneeTelegramUserId)
          : "";

        if (reminder.kind === "PRE_DEADLINE") {
          await bot.telegram.sendMessage(
            chatId,
            `⏰ Через 2 часа дедлайн: «${task.title}»${mention}`,
            { parse_mode: "Markdown" },
          );
        } else if (reminder.kind === "AT_DEADLINE") {
          await bot.telegram.sendMessage(
            chatId,
            `🔔 Дедлайн сейчас: «${task.title}»${mention}`,
            { parse_mode: "Markdown" },
          );
        } else if (reminder.kind === "POST_DEADLINE") {
          await bot.telegram.sendMessage(
            chatId,
            `⚠️ Срок прошёл: «${task.title}»${mention}\nОбновите статус:`,
            {
              parse_mode: "Markdown",
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback("✅ Готово", `ts:${task.id}:done`),
                  Markup.button.callback("🔄 В работе", `ts:${task.id}:work`),
                ],
                [
                  Markup.button.callback("🚧 Блокер", `ts:${task.id}:blocker`),
                  Markup.button.callback("📅 Перенос", `ts:${task.id}:move`),
                ],
              ]),
            },
          );
        } else if (reminder.kind === "ESCALATION") {
          await bot.telegram.sendMessage(
            chatId,
            `🚨 Эскалация: задача «${task.title}» просрочена и не обновлялась.${mention}\nВыберите статус:`,
            {
              parse_mode: "Markdown",
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback("✅ Готово", `ts:${task.id}:done`),
                  Markup.button.callback("🔄 В работе", `ts:${task.id}:work`),
                ],
                [
                  Markup.button.callback("🚧 Блокер", `ts:${task.id}:blocker`),
                  Markup.button.callback("📅 Перенос", `ts:${task.id}:move`),
                ],
              ]),
            },
          );
        }
        await markOpsReminderSent(reminder.id);
      } catch (innerErr) {
        logError("ops-reminder-item", `Failed to send reminder ${reminder.id}`, innerErr);
        await markOpsReminderSent(reminder.id).catch(() => {});
      }
    }
  } catch (err) {
    logError("ops-reminders", "Failed to process due reminders", err);
  }
}, remindersIntervalMs);

setInterval(async () => {
  try {
    const { chats } = await getActiveOpsChats();
    for (const chat of chats) {
      if (chat.mode === "OBSERVER") continue;
      try {
        const { escalated } = await escalateOpsChat(chat.telegramChatId);
        for (const task of escalated) {
          if (task.escalationCount > 3) continue;
          const mention = task.assigneeTelegramUserId ? mentionTag(task.assigneeTelegramUserId) : "";
          await bot.telegram
            .sendMessage(
              Number(chat.telegramChatId),
              `🚨 Задача «${task.title}» просрочена${mention}. Эскалация #${task.escalationCount}.\nВыберите статус:`,
              {
                parse_mode: "Markdown",
                ...Markup.inlineKeyboard([
                  [
                    Markup.button.callback("✅ Готово", `ts:${task.id}:done`),
                    Markup.button.callback("🔄 В работе", `ts:${task.id}:work`),
                  ],
                  [
                    Markup.button.callback("🚧 Блокер", `ts:${task.id}:blocker`),
                    Markup.button.callback("📅 Перенос", `ts:${task.id}:move`),
                  ],
                ]),
              },
            )
            .catch(() => {});
        }
      } catch {
        // не прерываем цикл для остальных чатов
      }
    }
  } catch (err) {
    logError("ops-escalation", "Failed escalation sweep", err);
  }
}, escalationIntervalMs);

const followUpIntervalMs = Number(process.env.OPS_FOLLOWUP_INTERVAL_MS ?? 30 * 60_000);
setInterval(async () => {
  try {
    const { discussions } = await getOpsDiscussionFollowUps();
    for (const d of discussions) {
      await bot.telegram
        .sendMessage(
          Number(d.chatTelegramId),
          `❓ Обсуждение «${d.topic}» открыто уже ${d.staleSinceHours} ч. без решения.\n` +
            `Есть ответственный? /ops_owners — посмотреть карту ролей.`,
        )
        .catch(() => {});
      await markDiscussionFollowUpSent(d.id).catch(() => {});
    }
  } catch (err) {
    logError("ops-follow-up", "Failed discussion follow-up sweep", err);
  }
}, followUpIntervalMs);

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
const WEBHOOK_PORT   = Number(process.env.WEBHOOK_PORT ?? 3001);
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
