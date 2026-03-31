"use client";

import { useEffect, useState, useCallback } from "react";
import {
  getActiveOpsChats,
  getOpsTasksWeb,
  getOpsDailySummaryWeb,
  getOpsMemberStatsWeb,
  getOpsUnresolvedWeb,
  getOpsDecisionsWeb,
  getOpsRiskWeb,
  getOpsWeeklyWeb,
  updateOpsTaskStatusWeb,
  createOpsTaskWeb,
  type OpsChat,
  type OpsTaskRow,
  type OpsMemberStat,
} from "../../src/lib/api";

// ── Types ────────────────────────────────────────────────────────────────────

type DailySummary = {
  exists: boolean;
  created: number;
  done: number;
  overdue: number;
  withoutAssignee: number;
  blocked: number;
};

type Discussion = { id: string; topic: string; status: string; lastActivityAt: string };

type Decision = {
  id: string;
  text: string;
  projectName: string | null;
  madeByUsername: string | null;
  madeByFirstName: string | null;
  createdAt: string;
};

type RiskData = {
  overdueTasks: Array<{ title: string; dueAt: string | null; assigneeUsername: string | null }>;
  blockedTasks: Array<{ title: string; blockers: string[] }>;
  unresolvedDiscussions: Array<{ topic: string; staleSinceHours: number }>;
  membersAtRisk: Array<{ username: string | null; firstName: string | null; overdueCount: number }>;
};

type WeeklyData = {
  created: number;
  done: number;
  overdue: number;
  blocked: number;
  decisionsLogged: number;
  completionRate: number;
  topMembers: Array<{ telegramUserId: string; username: string | null; firstName: string | null; total: number; done: number; overdue: number }>;
};

type Tab = "tasks" | "decisions" | "risk" | "weekly";

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<string, string> = {
  NEW: "Новая",
  IN_PROGRESS: "В работе",
  BLOCKED: "Блокер",
  DONE: "Готово",
  OVERDUE: "Просрочено",
};
const STATUS_COLOR: Record<string, string> = {
  NEW: "bg-slate-100 text-slate-700",
  IN_PROGRESS: "bg-blue-100 text-blue-800",
  BLOCKED: "bg-red-100 text-red-800",
  DONE: "bg-green-100 text-green-800",
  OVERDUE: "bg-orange-100 text-orange-800",
};

function Badge({ status }: { status: string }) {
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLOR[status] ?? "bg-slate-100 text-slate-600"}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function OpsDashboard() {
  const [chats, setChats] = useState<OpsChat[]>([]);
  const [selectedChatId, setSelectedChatId] = useState<string>("");
  const [tab, setTab] = useState<Tab>("tasks");

  // Tasks tab
  const [tasks, setTasks] = useState<OpsTaskRow[]>([]);
  const [summary, setSummary] = useState<DailySummary | null>(null);
  const [memberStats, setMemberStats] = useState<OpsMemberStat[]>([]);
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [busyTaskId, setBusyTaskId] = useState<string | null>(null);

  // Decisions tab
  const [decisions, setDecisions] = useState<Decision[]>([]);

  // Risk tab
  const [risk, setRisk] = useState<RiskData | null>(null);

  // Weekly tab
  const [weekly, setWeekly] = useState<WeeklyData | null>(null);

  // Create task modal
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newAssignee, setNewAssignee] = useState("");
  const [newDue, setNewDue] = useState("");
  const [newProject, setNewProject] = useState("");
  const [adding, setAdding] = useState(false);

  const [loading, setLoading] = useState(false);

  useEffect(() => {
    getActiveOpsChats()
      .then(({ chats }) => {
        setChats(chats);
        if (chats.length > 0) setSelectedChatId(chats[0].telegramChatId);
      })
      .catch(() => {});
  }, []);

  const loadTab = useCallback(async () => {
    if (!selectedChatId) return;
    setLoading(true);
    try {
      if (tab === "tasks") {
        const [tasksRes, summaryRes, statsRes, discussRes] = await Promise.all([
          getOpsTasksWeb(selectedChatId, statusFilter || undefined),
          getOpsDailySummaryWeb(selectedChatId),
          getOpsMemberStatsWeb(selectedChatId),
          getOpsUnresolvedWeb(selectedChatId),
        ]);
        setTasks(tasksRes.tasks);
        setSummary(summaryRes);
        setMemberStats(statsRes.stats);
        setDiscussions(discussRes.discussions);
      } else if (tab === "decisions") {
        const res = await getOpsDecisionsWeb(selectedChatId, 30);
        setDecisions(res.decisions);
      } else if (tab === "risk") {
        const res = await getOpsRiskWeb(selectedChatId);
        setRisk(res);
      } else if (tab === "weekly") {
        const res = await getOpsWeeklyWeb(selectedChatId);
        setWeekly(res);
      }
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [selectedChatId, tab, statusFilter]);

  useEffect(() => { loadTab(); }, [loadTab]);

  async function handleStatusChange(taskId: string, status: string) {
    setBusyTaskId(taskId);
    try {
      await updateOpsTaskStatusWeb(taskId, status);
      await loadTab();
    } finally {
      setBusyTaskId(null);
    }
  }

  async function handleAddTask(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || !selectedChatId) return;
    setAdding(true);
    try {
      await createOpsTaskWeb({
        telegramChatId: selectedChatId,
        title: newTitle.trim(),
        assigneeTelegramUserId: newAssignee.trim() || undefined,
        dueAt: newDue ? new Date(newDue).toISOString() : undefined,
        projectName: newProject.trim() || undefined,
      });
      setNewTitle(""); setNewAssignee(""); setNewDue(""); setNewProject("");
      setShowAdd(false);
      if (tab !== "tasks") setTab("tasks"); else await loadTab();
    } finally {
      setAdding(false);
    }
  }

  const selectedChat = chats.find((c) => c.telegramChatId === selectedChatId);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <a href="/equipment" className="text-slate-400 hover:text-slate-600 text-sm">← Light Rental</a>
            <span className="text-slate-300">/</span>
            <h1 className="text-lg font-semibold text-slate-900">Ops Dashboard</h1>
            {selectedChat && (
              <span className="text-sm text-slate-500 bg-slate-100 rounded-full px-3 py-0.5">
                {selectedChat.title || selectedChatId} · {selectedChat.mode}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {chats.length > 1 && (
              <select
                className="text-sm border border-slate-200 rounded-lg px-3 py-1.5 bg-white text-slate-700"
                value={selectedChatId}
                onChange={(e) => setSelectedChatId(e.target.value)}
              >
                {chats.map((c) => (
                  <option key={c.telegramChatId} value={c.telegramChatId}>
                    {c.title || c.telegramChatId}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={() => setShowAdd(true)}
              className="bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium px-4 py-1.5 rounded-lg transition-colors"
            >
              + Задача
            </button>
            <button
              onClick={loadTab}
              disabled={loading}
              className="text-sm text-slate-500 hover:text-slate-700 px-3 py-1.5 rounded-lg border border-slate-200 bg-white transition-colors disabled:opacity-50"
            >
              {loading ? "..." : "↻"}
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="max-w-7xl mx-auto mt-3 flex gap-1">
          {(["tasks", "decisions", "risk", "weekly"] as Tab[]).map((t) => {
            const labels: Record<Tab, string> = { tasks: "Задачи", decisions: "Решения", risk: "Риски", weekly: "Неделя" };
            return (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${tab === t ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"}`}
              >
                {labels[t]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-6">

        {/* ── TASKS TAB ── */}
        {tab === "tasks" && (
          <div className="space-y-6">
            {/* Daily summary */}
            {summary?.exists && (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                {[
                  { label: "Создано", value: summary.created, color: "text-slate-900" },
                  { label: "Выполнено", value: summary.done, color: "text-green-700" },
                  { label: "Просрочено", value: summary.overdue, color: "text-orange-700" },
                  { label: "Блокеры", value: summary.blocked, color: "text-red-700" },
                  { label: "Без ответственного", value: summary.withoutAssignee, color: "text-slate-500" },
                ].map(({ label, value, color }) => (
                  <div key={label} className="bg-white border border-slate-200 rounded-xl p-4 text-center">
                    <div className={`text-2xl font-bold ${color}`}>{value}</div>
                    <div className="text-xs text-slate-500 mt-1">{label}</div>
                  </div>
                ))}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Task list */}
              <div className="lg:col-span-2 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">
                    Задачи ({tasks.filter((t) => t.status !== "DONE").length} активных)
                  </h2>
                  <select
                    className="text-sm border border-slate-200 rounded-lg px-2 py-1 bg-white text-slate-600"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                  >
                    <option value="">Все</option>
                    <option value="NEW">Новые</option>
                    <option value="IN_PROGRESS">В работе</option>
                    <option value="BLOCKED">Блокеры</option>
                    <option value="OVERDUE">Просрочено</option>
                    <option value="DONE">Готово</option>
                  </select>
                </div>

                {tasks.length === 0 && !loading && (
                  <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-slate-400 text-sm">
                    {selectedChatId ? "Задач пока нет" : "Выберите чат"}
                  </div>
                )}

                {tasks.map((task) => (
                  <div
                    key={task.id}
                    className={`bg-white border rounded-xl p-4 transition-opacity ${busyTaskId === task.id ? "opacity-50" : ""} ${task.status === "DONE" ? "border-slate-100" : "border-slate-200"}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <Badge status={task.status} />
                          {task.projectName && (
                            <span className="text-xs text-slate-400 bg-slate-50 rounded px-1.5 py-0.5">{task.projectName}</span>
                          )}
                        </div>
                        <p className={`mt-1 text-sm font-medium ${task.status === "DONE" ? "line-through text-slate-400" : "text-slate-800"}`}>
                          {task.title}
                        </p>
                        <div className="flex items-center gap-3 mt-1 text-xs text-slate-400 flex-wrap">
                          {task.assigneeUsername && <span>@{task.assigneeUsername}</span>}
                          {task.dueAt && (
                            <span className={new Date(task.dueAt) < new Date() && task.status !== "DONE" ? "text-orange-500 font-medium" : ""}>
                              до {new Date(task.dueAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                            </span>
                          )}
                          {task.blockedBy.length > 0 && (
                            <span className="text-red-400">🔗 ждёт: {task.blockedBy.map((b) => b.title).join(", ")}</span>
                          )}
                        </div>
                      </div>
                      {task.status !== "DONE" && (
                        <div className="flex items-center gap-1 shrink-0">
                          {task.status !== "IN_PROGRESS" && (
                            <button onClick={() => handleStatusChange(task.id, "IN_PROGRESS")} disabled={!!busyTaskId} className="text-xs text-blue-600 hover:text-blue-800 px-2 py-1 rounded hover:bg-blue-50 transition-colors">
                              В работу
                            </button>
                          )}
                          {task.status !== "BLOCKED" && (
                            <button onClick={() => handleStatusChange(task.id, "BLOCKED")} disabled={!!busyTaskId} className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50 transition-colors">
                              Блокер
                            </button>
                          )}
                          <button onClick={() => handleStatusChange(task.id, "DONE")} disabled={!!busyTaskId} className="text-xs text-green-600 hover:text-green-800 px-2 py-1 rounded hover:bg-green-50 transition-colors">
                            ✓
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {/* Right: members + discussions */}
              <div className="space-y-4">
                {memberStats.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">Участники</h3>
                    <div className="space-y-2.5">
                      {memberStats.slice(0, 8).map((m) => {
                        const name = m.username ? `@${m.username}` : (m.firstName ?? `id${m.telegramUserId}`);
                        const pct = m.total > 0 ? Math.round((m.done / m.total) * 100) : 0;
                        return (
                          <div key={m.telegramUserId}>
                            <div className="flex items-center justify-between text-sm">
                              <span className="text-slate-700 truncate">{name}</span>
                              <span className="text-xs text-slate-400 ml-2 shrink-0 tabular-nums">{m.done}/{m.total}{m.overdue > 0 ? ` ⚠️${m.overdue}` : ""}</span>
                            </div>
                            <div className="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${m.overdueRate >= 30 ? "bg-orange-400" : "bg-blue-400"}`} style={{ width: `${pct}%` }} />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {discussions.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-3">Нерешённые ({discussions.length})</h3>
                    <div className="space-y-2">
                      {discussions.slice(0, 5).map((d) => {
                        const hours = Math.round((Date.now() - new Date(d.lastActivityAt).getTime()) / 3_600_000);
                        return (
                          <div key={d.id}>
                            <p className="text-sm text-slate-700">❓ {d.topic}</p>
                            <p className="text-xs text-slate-400">без движения {hours} ч.</p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── DECISIONS TAB ── */}
        {tab === "decisions" && (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">Протокол решений</h2>
            {decisions.length === 0 && !loading && (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-slate-400 text-sm">
                Решений пока нет. Бот фиксирует их автоматически, когда участники пишут «решили», «договорились», «утвердили» и т.п.
              </div>
            )}
            <div className="space-y-2">
              {decisions.map((d) => {
                const who = d.madeByUsername ? `@${d.madeByUsername}` : (d.madeByFirstName ?? "?");
                const date = new Date(d.createdAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
                return (
                  <div key={d.id} className="bg-white border border-slate-200 rounded-xl p-4">
                    <p className="text-sm text-slate-800 leading-snug">{d.text}</p>
                    <div className="flex items-center gap-3 mt-2 text-xs text-slate-400">
                      <span>{who}</span>
                      <span>{date}</span>
                      {d.projectName && <span className="bg-slate-100 rounded px-1.5 py-0.5 text-slate-500">{d.projectName}</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── RISK TAB ── */}
        {tab === "risk" && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">Риски</h2>

            {!risk && !loading && (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-slate-400 text-sm">
                Нет данных по рискам
              </div>
            )}

            {risk && (
              <>
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Просрочено", value: risk.overdueTasks.length, color: "text-orange-700", bg: "bg-orange-50 border-orange-100" },
                    { label: "Блокеры", value: risk.blockedTasks.length, color: "text-red-700", bg: "bg-red-50 border-red-100" },
                    { label: "Нерешённых обсуждений", value: risk.unresolvedDiscussions.length, color: "text-slate-700", bg: "bg-slate-50 border-slate-100" },
                  ].map(({ label, value, color, bg }) => (
                    <div key={label} className={`border rounded-xl p-4 text-center ${bg}`}>
                      <div className={`text-3xl font-bold ${color}`}>{value}</div>
                      <div className="text-xs text-slate-500 mt-1">{label}</div>
                    </div>
                  ))}
                </div>

                {risk.overdueTasks.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-orange-700 mb-3">⚠️ Просроченные задачи</h3>
                    <div className="space-y-2">
                      {risk.overdueTasks.map((t, i) => (
                        <div key={i} className="flex items-center justify-between text-sm">
                          <span className="text-slate-700">{t.title}</span>
                          <div className="flex items-center gap-3 text-xs text-slate-400 shrink-0 ml-3">
                            {t.assigneeUsername && <span>@{t.assigneeUsername}</span>}
                            {t.dueAt && <span className="text-orange-500">{new Date(t.dueAt).toLocaleDateString("ru-RU")}</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {risk.blockedTasks.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-red-700 mb-3">🚧 Блокеры</h3>
                    <div className="space-y-2">
                      {risk.blockedTasks.map((t, i) => (
                        <div key={i}>
                          <span className="text-sm text-slate-700">{t.title}</span>
                          {t.blockers.length > 0 && (
                            <p className="text-xs text-slate-400 mt-0.5">← ждёт: {t.blockers.join(", ")}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {risk.membersAtRisk.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-slate-700 mb-3">🔇 Участники под риском</h3>
                    <div className="space-y-1">
                      {risk.membersAtRisk.map((m, i) => {
                        const name = m.username ? `@${m.username}` : (m.firstName ?? "?");
                        return (
                          <div key={i} className="flex items-center justify-between text-sm">
                            <span className="text-slate-700">{name}</span>
                            <span className="text-xs text-orange-500">{m.overdueCount} просроч.</span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {risk.unresolvedDiscussions.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-slate-700 mb-3">❓ Зависшие обсуждения</h3>
                    <div className="space-y-2">
                      {risk.unresolvedDiscussions.map((d, i) => (
                        <div key={i} className="flex items-center justify-between text-sm">
                          <span className="text-slate-700">{d.topic}</span>
                          <span className="text-xs text-slate-400 ml-3 shrink-0">{d.staleSinceHours} ч.</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── WEEKLY TAB ── */}
        {tab === "weekly" && (
          <div className="space-y-4">
            <h2 className="text-sm font-semibold text-slate-700 uppercase tracking-wide">Отчёт за неделю</h2>

            {!weekly && !loading && (
              <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-slate-400 text-sm">
                Нет данных за неделю
              </div>
            )}

            {weekly && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                  {[
                    { label: "Создано", value: weekly.created, color: "text-slate-900" },
                    { label: "Выполнено", value: weekly.done, color: "text-green-700" },
                    { label: "Просрочено", value: weekly.overdue, color: "text-orange-700" },
                    { label: "Блокеры", value: weekly.blocked, color: "text-red-700" },
                    { label: "Решений", value: weekly.decisionsLogged, color: "text-indigo-700" },
                    { label: "% выполнения", value: `${weekly.completionRate}%`, color: weekly.completionRate >= 70 ? "text-green-700" : "text-orange-700" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="bg-white border border-slate-200 rounded-xl p-4 text-center">
                      <div className={`text-2xl font-bold ${color}`}>{value}</div>
                      <div className="text-xs text-slate-500 mt-1">{label}</div>
                    </div>
                  ))}
                </div>

                {weekly.topMembers.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl p-4">
                    <h3 className="text-sm font-semibold text-slate-700 mb-3">Топ участников недели</h3>
                    <div className="space-y-2">
                      {weekly.topMembers.map((m, i) => {
                        const name = m.username ? `@${m.username}` : (m.firstName ?? `id${m.telegramUserId}`);
                        const pct = m.total > 0 ? Math.round((m.done / m.total) * 100) : 0;
                        const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
                        return (
                          <div key={m.telegramUserId} className="flex items-center gap-3">
                            <span className="text-sm w-6 shrink-0">{medal}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between">
                                <span className="text-sm text-slate-700 truncate">{name}</span>
                                <span className="text-xs text-slate-400 ml-2 shrink-0 tabular-nums">{m.done}/{m.total}{m.overdue > 0 ? ` ⚠️${m.overdue}` : ""}</span>
                              </div>
                              <div className="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                <div
                                  className={`h-full rounded-full ${m.overdue > 0 ? "bg-orange-400" : "bg-blue-400"}`}
                                  style={{ width: `${pct}%` }}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Create task modal */}
      {showAdd && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-base font-semibold text-slate-900">Новая задача</h2>
              <button onClick={() => setShowAdd(false)} className="text-slate-400 hover:text-slate-600 text-2xl leading-none">×</button>
            </div>
            <form onSubmit={handleAddTask} className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Название *</label>
                <input
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Например: Подготовить смету на свет"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  required
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Ответственный (Telegram username)</label>
                <input
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="username без @"
                  value={newAssignee}
                  onChange={(e) => setNewAssignee(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Срок</label>
                <input
                  type="datetime-local"
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  value={newDue}
                  onChange={(e) => setNewDue(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Проект</label>
                <input
                  className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Название проекта"
                  value={newProject}
                  onChange={(e) => setNewProject(e.target.value)}
                />
              </div>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowAdd(false)}
                  className="flex-1 text-sm text-slate-600 hover:text-slate-800 border border-slate-200 rounded-lg py-2 transition-colors"
                >
                  Отмена
                </button>
                <button
                  type="submit"
                  disabled={adding || !newTitle.trim()}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg py-2 transition-colors"
                >
                  {adding ? "Создаю..." : "Создать"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
