import { Scenes, Markup } from "telegraf";
import type { BotContext } from "../types";
import { ROLES, ROLES_BY_ID, calculateCrewCost, type RoleId, type RoleBreakdown } from "@light-rental/shared";
import { mainMenuKeyboard } from "../keyboards";

type CrewCalcDraft = {
  step: "hours" | "role" | "done";
  /** Часы для расчёта (целые; дробный ввод округляется вверх) */
  hours?: number;
  /** Как ввёл пользователь, если было дробное */
  hoursRaw?: number;
  roleIndex: number;
  counts: Partial<Record<RoleId, number>>;
};

const calcWizardKeyboard = Markup.keyboard([["🏠 Главное меню"]]).resize();

const calcResultKeyboard = Markup.keyboard([
  ["🔄 Новый расчёт"],
  ["🏠 Главное меню"],
]).resize();

function getS(ctx: BotContext): CrewCalcDraft {
  const d = ctx.scene.state as Partial<CrewCalcDraft>;
  return {
    step: d.step ?? "hours",
    hours: d.hours,
    roleIndex: d.roleIndex ?? 0,
    counts: d.counts ?? {},
  };
}

function setS(ctx: BotContext, patch: Partial<CrewCalcDraft>): void {
  Object.assign(ctx.scene.state, patch);
}

/** Дробные часы → округление вверх до целого (14,5 → 15) */
function billableHours(entered: number): number {
  if (!Number.isFinite(entered) || entered < 0) return entered;
  const frac = entered % 1;
  if (frac === 0 || Math.abs(frac) < 1e-9) return Math.round(entered);
  return Math.ceil(entered);
}

function fmtMoney(n: number): string {
  return `${n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`;
}

function fmtAmount(n: number): string {
  return n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtRatePerHour(n: number): string {
  return `${n.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/ч`;
}

function formatOvertimeTierLine(
  label: string,
  hours: number,
  ratePerHour: number,
  cost: number,
): string | null {
  if (hours <= 0) return null;
  return `${label} ${hours} ч × ${fmtRatePerHour(ratePerHour)} = ${fmtMoney(cost)}`;
}

/** Подробная карточка роли (как на сайте) */
function formatRoleDetailed(line: RoleBreakdown): string {
  const cfg = ROLES_BY_ID[line.role];
  const parts: string[] = [];

  parts.push(`*${line.label}* × ${line.count}`);
  parts.push("");
  parts.push(`Базовая смена (до 10 ч) ${fmtMoney(line.baseShiftCost)}`);

  const hasOt =
    line.overtimeTier1Hours > 0 ||
    line.overtimeTier2Hours > 0 ||
    line.overtimeTier3Hours > 0;

  if (hasOt) {
    parts.push("");
    parts.push("Переработка:");
    const t1 = formatOvertimeTierLine(
      "1–8 ч переработки",
      line.overtimeTier1Hours,
      cfg.overtime.tier1,
      line.overtimeTier1Cost,
    );
    const t2 = formatOvertimeTierLine(
      "9–14 ч переработки",
      line.overtimeTier2Hours,
      cfg.overtime.tier2,
      line.overtimeTier2Cost,
    );
    const t3 = formatOvertimeTierLine(
      "15+ ч переработки",
      line.overtimeTier3Hours,
      cfg.overtime.tier3,
      line.overtimeTier3Cost,
    );
    if (t1) parts.push(t1);
    if (t2) parts.push(t2);
    if (t3) parts.push(t3);
  }

  parts.push("");
  parts.push(`Итого на 1 чел. (смена + ${fmtAmount(line.totalOvertimeCostPerPerson)} ОТ)`);
  parts.push(`*${fmtMoney(line.totalPerPerson)}*`);

  if (line.count > 1) {
    parts.push("");
    parts.push(`Итого × ${line.count} чел.`);
    parts.push(`*${fmtMoney(line.totalForRole)}*`);
  }

  return parts.join("\n");
}

function formatResult(
  hours: number,
  hoursRaw: number | undefined,
  lines: RoleBreakdown[],
  grandTotal: number,
): string {
  let msg = `📊 *Результат расчёта*\n\n`;
  if (hoursRaw !== undefined && hoursRaw !== hours) {
    const rawStr = String(hoursRaw).replace(".", ",");
    msg += `⏱ Указано: *${rawStr}* ч → в расчёте: *${hours}* ч _(дробная часть округлена вверх до целого часа)_\n\n`;
  } else {
    msg += `⏱ Часов в расчёте: *${hours}*\n\n`;
  }

  if (lines.length === 0) {
    msg += `_Нет ни одной роли с количеством больше 0._`;
    return msg;
  }

  msg += lines.map(formatRoleDetailed).join("\n\n──────────────\n\n");
  msg += `\n\n💰 *Всего по смете: ${fmtMoney(grandTotal)}*`;
  msg += `\n\n_Как на сайте: базовая смена до 10 ч, затем переработка ступенями 1–8 ч / 9–14 ч / 15+ ч._`;
  return msg;
}

export const crewCalcScene = new Scenes.BaseScene<BotContext>("crewCalc");

async function leaveToMain(ctx: BotContext, text: string): Promise<void> {
  await ctx.scene.leave();
  await ctx.reply(text, { parse_mode: "Markdown", ...mainMenuKeyboard });
}

crewCalcScene.enter(async (ctx) => {
  ctx.scene.state = {};
  setS(ctx, { step: "hours", roleIndex: 0, counts: {} });
  await ctx.reply(
    `💡 *Калькулятор осветителей*\n\n` +
    `Ставки и переработки как на сайте (*Калькуляция ставок осветителей*):\n` +
    `• одна базовая смена до *10 ч*\n` +
    `• дальше переработка ступенями: *1–8 ч*, *9–14 ч*, *15+ ч* ОТ\n\n` +
    `Сколько *рабочих часов* у команды за смену?\n` +
    `_Например: 10 или 14,5. Дробная часть округляется вверх до целого часа (14,5 → 15)._`,
    { parse_mode: "Markdown", ...calcWizardKeyboard },
  );
});

crewCalcScene.hears("🏠 Главное меню", async (ctx) => {
  await leaveToMain(ctx, "🏠 Главное меню:");
});

crewCalcScene.command("cancel", async (ctx) => {
  await leaveToMain(ctx, "❌ Расчёт отменён. Главное меню:");
});

crewCalcScene.hears("🔄 Новый расчёт", async (ctx) => {
  const s = getS(ctx);
  if (s.step !== "done") {
    await ctx.reply("Сначала завершите текущий расчёт или нажмите «Главное меню».", calcWizardKeyboard);
    return;
  }
  ctx.scene.state = {};
  setS(ctx, { step: "hours", roleIndex: 0, counts: {} });
  await ctx.reply(
    `Сколько *рабочих часов* у команды за смену?\n_Дробная часть округляется вверх (14,5 → 15)._`,
    { parse_mode: "Markdown", ...calcWizardKeyboard },
  );
});

crewCalcScene.on("text", async (ctx) => {
  const s = getS(ctx);
  const text = ctx.message.text.trim();

  if (text === "🏠 Главное меню" || text === "🔄 Новый расчёт") return;

  if (s.step === "hours") {
    const raw = parseFloat(text.replace(",", "."));
    if (!Number.isFinite(raw) || raw < 0 || raw > 48) {
      await ctx.reply(
        "❓ Введите число от 0 до 48 (часов за смену). Например: `12` или `10,5`",
        { parse_mode: "Markdown", ...calcWizardKeyboard },
      );
      return;
    }
    const hoursB = billableHours(raw);
    const hoursRawStore = raw !== hoursB ? raw : undefined;
    setS(ctx, { hours: hoursB, hoursRaw: hoursRawStore, step: "role", roleIndex: 0, counts: {} });
    const role = ROLES[0];
    const hoursNote =
      hoursRawStore !== undefined
        ? `\n_В расчёте берём ${hoursB} ч (введено ${String(raw).replace(".", ",")} ч)._`
        : "";
    await ctx.reply(
      `Часов для сметы: *${hoursB}*${hoursNote}\n\n` +
      `Сколько человек в роли *${role.label}*?\n` +
      `_Напишите целое число (0 если никого)_`,
      { parse_mode: "Markdown", ...calcWizardKeyboard },
    );
    return;
  }

  if (s.step === "role") {
    const n = parseInt(text, 10);
    if (!Number.isFinite(n) || n < 0 || n > 99) {
      await ctx.reply("❓ Введите целое число от 0 до 99.", calcWizardKeyboard);
      return;
    }
    const role = ROLES[s.roleIndex];
    const counts = { ...s.counts, [role.id]: n } as Partial<Record<RoleId, number>>;
    const nextIndex = s.roleIndex + 1;

    if (nextIndex >= ROLES.length) {
      const result = calculateCrewCost(counts, s.hours!);
      const lines = result.lines;
      const hasAny = lines.length > 0;
      if (!hasAny) {
        await ctx.reply(
          "⚠️ Ни одной роли с количеством больше 0. Начнём состав заново — по очереди укажите числа.",
          calcWizardKeyboard,
        );
        setS(ctx, { step: "role", roleIndex: 0, counts: {} });
        const r0 = ROLES[0];
        await ctx.reply(
          `Сколько человек в роли *${r0.label}*?`,
          { parse_mode: "Markdown", ...calcWizardKeyboard },
        );
        return;
      }
      setS(ctx, { step: "done", counts });
      await ctx.reply(formatResult(s.hours!, s.hoursRaw, lines, result.grandTotal), {
        parse_mode: "Markdown",
        ...calcResultKeyboard,
      });
      return;
    }

    setS(ctx, { counts, roleIndex: nextIndex });
    const nextRole = ROLES[nextIndex];
    await ctx.reply(
      `Сколько человек в роли *${nextRole.label}*?\n_0 если никого_`,
      { parse_mode: "Markdown", ...calcWizardKeyboard },
    );
    return;
  }

  if (s.step === "done") {
    await ctx.reply(
      "Используйте кнопки ниже или *🔄 Новый расчёт*.",
      { parse_mode: "Markdown", ...calcResultKeyboard },
    );
  }
});
