import OpenAI from "openai";
import type { OpsMessageExtraction } from "../types";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30_000,
  maxRetries: 0,
});

export type MemberHint = {
  telegramUserId: string;
  username?: string | null;
  firstName?: string | null;
  isAdmin?: boolean;
};

const DEFAULT_EXTRACTION: OpsMessageExtraction = {
  messageType: "OTHER",
  messageTypeConfidence: 0.5,
  entities: {
    projects: [],
    people: [],
    departments: [],
    deadlines: [],
    dependencies: [],
    priorities: [],
  },
  roleCandidates: [],
};

const SYSTEM_PROMPT = `Ты AI-координатор продакшен-чата в Telegram.
Классифицируй сообщение, извлеки сущности и, если это постановка задачи, сформируй task.

ТИПЫ СООБЩЕНИЙ:
TASK — постановка задачи, поручение, надо что-то сделать
DECISION — принято решение
QUESTION — вопрос без ответа, нерешённая тема
RISK — риск или предупреждение
DEADLINE — уточнение срока
BLOCKER — без этого не двигаемся, застряли, ждём
REQUEST — просьба, не строгое поручение
CONFIRMATION — подтверждение, ок, принято, сделано
RESCHEDULE — перенос срока
EXECUTED — сообщение о выполнении (готово, скинул, отправил)
NOT_EXECUTED — не успею, не получается, провал
OTHER — всё остальное

ВОЗВРАЩАЙ СТРОГО JSON:
{
  "messageType": "...",
  "messageTypeConfidence": 0.0,
  "entities": {
    "projects": [],
    "people": [],
    "departments": [],
    "deadlines": [],
    "dependencies": ["текст зависимости если есть"],
    "priorities": []
  },
  "task": {
    "title": "...",
    "description": "...",
    "assigneeTelegramUserId": "ID числом строкой или null",
    "coAssigneeTelegramUserIds": [],
    "dueAt": "ISO-8601 или null",
    "projectName": "название проекта или null",
    "priority": 0-100,
    "confidence": 0.0,
    "needsConfirmation": true|false,
    "blockerHint": "текст того что блокирует или null",
    "dependsOnText": "текст зависимости от другой задачи или null"
  } | null,
  "roleCandidates": [{"roleName": "...", "telegramUserId": "...", "confidence": 0.0}],
  "isUnresolvedDiscussion": true|false,
  "discussionTopic": "тема обсуждения если isUnresolvedDiscussion=true или null"
}

ПРАВИЛА:
- Если НЕ задача — task=null.
- assigneeTelegramUserId — только если уверенность >=0.8, иначе null.
- coAssigneeTelegramUserIds — когда явно упоминается «мы с X», «X и Y сделают», «X поможет».
- dueAt — в ISO только при высокой уверенности, иначе null.
- needsConfirmation=true если task.confidence < 0.85 или нет ответственного.
- roleCandidates — только при явном/почти явном упоминании зоны ответственности.
- isUnresolvedDiscussion=true когда это вопрос/риск без ответственного и без решения.
- blockerHint — если суть в том, что что-то блокирует работу.
- Не выдумывай людей и сроки.`;

export async function extractOpsFromMessage(args: {
  text: string;
  memberHints: MemberHint[];
  projectHints?: string[];
}): Promise<OpsMessageExtraction> {
  const membersList = args.memberHints
    .map((m) => {
      const username = m.username ? `@${m.username}` : "";
      const firstName = m.firstName ?? "";
      return `${m.telegramUserId} | ${username} | ${firstName} | admin:${Boolean(m.isAdmin)}`;
    })
    .join("\n");
  const projectsList = (args.projectHints ?? []).join(", ");

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          SYSTEM_PROMPT +
          `\n\nУЧАСТНИКИ ЧАТА:\n${membersList || "(нет данных)"}` +
          `\nПРОЕКТЫ: ${projectsList || "(нет)"}`,
      },
      { role: "user", content: args.text },
    ],
  });

  try {
    const raw = response.choices[0].message.content ?? "{}";
    const parsed = JSON.parse(raw) as Partial<OpsMessageExtraction> & {
      isUnresolvedDiscussion?: boolean;
      discussionTopic?: string;
    };
    const base: OpsMessageExtraction = {
      messageType: parsed.messageType ?? "OTHER",
      messageTypeConfidence:
        typeof parsed.messageTypeConfidence === "number" ? parsed.messageTypeConfidence : 0.5,
      entities: {
        projects: parsed.entities?.projects ?? [],
        people: parsed.entities?.people ?? [],
        departments: parsed.entities?.departments ?? [],
        deadlines: parsed.entities?.deadlines ?? [],
        dependencies: parsed.entities?.dependencies ?? [],
        priorities: parsed.entities?.priorities ?? [],
      },
      task: parsed.task ?? undefined,
      roleCandidates: Array.isArray(parsed.roleCandidates) ? parsed.roleCandidates : [],
    };

    if (parsed.isUnresolvedDiscussion && parsed.discussionTopic) {
      (base as OpsMessageExtraction & { isUnresolvedDiscussion: boolean; discussionTopic: string }).isUnresolvedDiscussion =
        true;
      (base as OpsMessageExtraction & { isUnresolvedDiscussion: boolean; discussionTopic: string }).discussionTopic =
        parsed.discussionTopic;
    }

    return base;
  } catch {
    return DEFAULT_EXTRACTION;
  }
}

export type DailySummaryInput = {
  chatTitle: string | null;
  created: number;
  done: number;
  overdue: number;
  withoutAssignee: number;
  blocked: number;
};

export async function generateDailySummaryText(input: DailySummaryInput): Promise<string> {
  if (input.created === 0 && input.done === 0 && input.overdue === 0) {
    return (
      `Дейли-отчёт${input.chatTitle ? ` — ${input.chatTitle}` : ""}:\n` +
      `Сегодня задач не зафиксировано.`
    );
  }
  const lines = [
    `Дейли-отчёт${input.chatTitle ? ` — ${input.chatTitle}` : ""}:`,
    `— создано задач: ${input.created}`,
    `— выполнено: ${input.done}`,
    `— просрочено: ${input.overdue}`,
    `— без ответственного: ${input.withoutAssignee}`,
  ];
  if (input.blocked > 0) lines.push(`— в блокере: ${input.blocked}`);
  if (input.overdue > 0) lines.push(`\n⚠️ Проверьте просроченные задачи.`);
  return lines.join("\n");
}

type RiskInput = {
  overdueTasks: Array<{ title: string; dueAt: string | null; assigneeUsername: string | null }>;
  blockedTasks: Array<{ title: string; blockers: string[] }>;
  unresolvedDiscussions: Array<{ topic: string; staleSinceHours: number }>;
  membersAtRisk: Array<{ username: string | null; firstName: string | null; overdueCount: number }>;
};

export async function generateRiskReport(data: RiskInput): Promise<string> {
  const totalSignals =
    data.overdueTasks.length + data.blockedTasks.length + data.unresolvedDiscussions.length + data.membersAtRisk.length;

  if (totalSignals === 0) {
    return "Риски дня: значимых рисков не обнаружено.";
  }

  const context = [
    data.overdueTasks.length > 0
      ? `Просроченные задачи (${data.overdueTasks.length}): ` +
        data.overdueTasks
          .slice(0, 5)
          .map((t) => `«${t.title}»${t.assigneeUsername ? ` (@${t.assigneeUsername})` : ""}`)
          .join(", ")
      : null,
    data.blockedTasks.length > 0
      ? `Задачи в блокере (${data.blockedTasks.length}): ` +
        data.blockedTasks
          .slice(0, 3)
          .map((t) => `«${t.title}»`)
          .join(", ")
      : null,
    data.unresolvedDiscussions.length > 0
      ? `Нерешённые обсуждения: ` +
        data.unresolvedDiscussions
          .slice(0, 3)
          .map((d) => `«${d.topic}» (${d.staleSinceHours}ч без движения)`)
          .join(", ")
      : null,
    data.membersAtRisk.length > 0
      ? `Участники с большим числом просрочки: ` +
        data.membersAtRisk
          .map((m) => `${m.username ? `@${m.username}` : m.firstName ?? "?"} (${m.overdueCount} задач)`)
          .join(", ")
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.3,
      max_tokens: 300,
      messages: [
        {
          role: "system",
          content:
            "Ты AI-координатор продакшен-команды. На основе данных сформулируй 2-3 ключевых риска на сегодня. " +
            "Каждый риск — одна строка, начинается с эмодзи ⚠️ или 🚨, без заголовка, без нумерации, максимально конкретно. " +
            "В конце одна строка-рекомендация.",
        },
        { role: "user", content: context },
      ],
    });
    const text = response.choices[0].message.content?.trim() ?? "";
    return `Риски дня:\n${text}`;
  } catch {
    // Fallback to structured text if LLM fails
    const lines = ["Риски дня:"];
    if (data.overdueTasks.length > 0)
      lines.push(`⚠️ ${data.overdueTasks.length} задач просрочено без обновления статуса`);
    if (data.blockedTasks.length > 0)
      lines.push(`🚨 ${data.blockedTasks.length} задач в блокере`);
    if (data.unresolvedDiscussions.length > 0)
      lines.push(`⚠️ ${data.unresolvedDiscussions.length} обсуждений без решения более 48ч`);
    if (data.membersAtRisk.length > 0)
      lines.push(`⚠️ Перегрузка: ${data.membersAtRisk.map((m) => m.username ?? m.firstName ?? "?").join(", ")}`);
    return lines.join("\n");
  }
}

type WeeklyStatsInput = {
  chatTitle: string | null;
  created: number;
  done: number;
  overdue: number;
  blocked: number;
  decisionsLogged: number;
  completionRate: number;
  topMembers: Array<{
    telegramUserId: string;
    username: string | null;
    firstName: string | null;
    total: number;
    done: number;
    overdue: number;
  }>;
};

export function generateWeeklyReportText(stats: WeeklyStatsInput): string {
  const lines = [
    `Недельный отчёт${stats.chatTitle ? ` — ${stats.chatTitle}` : ""}:`,
    ``,
    `За неделю:`,
    `— создано задач: ${stats.created}`,
    `— выполнено: ${stats.done} (${stats.completionRate}%)`,
    `— просрочено: ${stats.overdue}`,
    `— в блокере: ${stats.blocked}`,
    `— решений зафиксировано: ${stats.decisionsLogged}`,
  ];

  if (stats.topMembers.length > 0) {
    lines.push(``, `Топ участников:`);
    for (const m of stats.topMembers) {
      const name = m.username ? `@${m.username}` : (m.firstName ?? "?");
      lines.push(`  ${name}: ${m.done}/${m.total} выполнено${m.overdue > 0 ? `, ${m.overdue} просроч.` : ""}`);
    }
  }

  if (stats.completionRate < 50 && stats.created > 0) {
    lines.push(``, `⚠️ Низкий % выполнения — рекомендуется разобрать незакрытые задачи.`);
  }

  return lines.join("\n");
}

export async function generateProjectSummaryText(input: {
  projectName: string;
  openTasks: Array<{ title: string; status: string; assigneeUsername: string | null }>;
  recentDecisions: Array<{ text: string; createdAt: string }>;
  blockedTasks: Array<{ title: string }>;
  overdueTasks: Array<{ title: string }>;
}): Promise<string> {
  const lines = [`Проект: ${input.projectName}`, ``];

  if (input.recentDecisions.length > 0) {
    lines.push(`Последние решения:`);
    for (const d of input.recentDecisions.slice(0, 5)) {
      lines.push(`  • ${d.text}`);
    }
    lines.push(``);
  }

  if (input.openTasks.length > 0) {
    lines.push(`В работе (${input.openTasks.length} задач):`);
    for (const t of input.openTasks.slice(0, 5)) {
      const a = t.assigneeUsername ? `@${t.assigneeUsername}` : "нет ответственного";
      lines.push(`  · ${t.title} — ${a}`);
    }
    lines.push(``);
  }

  if (input.blockedTasks.length > 0) {
    lines.push(`🚧 Блокеры: ${input.blockedTasks.map((t) => t.title).join(", ")}`);
  }

  if (input.overdueTasks.length > 0) {
    lines.push(`⚠️ Просрочено: ${input.overdueTasks.map((t) => t.title).join(", ")}`);
  }

  return lines.join("\n");
}
