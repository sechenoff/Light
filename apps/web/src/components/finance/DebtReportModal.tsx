"use client";

import { useEffect, useMemo, useState } from "react";

import { formatRub, pluralize } from "../../lib/format";
import { downloadEstimate, printEstimate } from "../../lib/estimateExport";

/** Одна отмеченная в реестре строка долга. */
export interface DebtReportSelection {
  bookingId: string;
  clientId: string;
  clientName: string;
  projectName: string;
  amountOutstanding: string;
  daysOverdue: number | null;
}

type Props = {
  open: boolean;
  rows: DebtReportSelection[];
  onClose: () => void;
  /** Снять строку прямо из панели — выбор в таблице меняется вместе с ней. */
  onRemove: (bookingId: string) => void;
  /** Снять всего клиента разом. */
  onRemoveClient: (clientId: string) => void;
};

const REPORT_NOT_FOUND = "Не удалось сформировать отчёт";
const PDF_PATH = "/api/finance/debts/report.pdf";
const XLSX_PATH = "/api/finance/debts/report.xlsx";

/**
 * Панель «Сформировать отчёт»: последняя остановка перед печатью.
 *
 * Отмеченные строки показаны сгруппированно по клиентам — здесь видно, кого и
 * за какие проекты сотрудник пойдёт обзванивать, и отсюда же лишнее снимается.
 * Выбор в таблице и состав отчёта — одно и то же множество: панель не делает
 * своей копии, иначе они разъехались бы при первой же правке.
 */
export function DebtReportModal({ open, rows, onClose, onRemove, onRemoveClient }: Props) {
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [includeContacts, setIncludeContacts] = useState(false);
  const [busy, setBusy] = useState<null | "print" | "pdf" | "xlsx">(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onClose]);

  // Группировка для предпросмотра — в том же порядке, что в документе:
  // сначала те, у кого просрочено больше, чтобы обзвон начинался сверху.
  const groups = useMemo(() => {
    const byClient = new Map<string, { clientId: string; clientName: string; rows: DebtReportSelection[]; total: number; overdue: number }>();
    for (const r of rows) {
      const g = byClient.get(r.clientId) ?? {
        clientId: r.clientId,
        clientName: r.clientName,
        rows: [],
        total: 0,
        overdue: 0,
      };
      g.rows.push(r);
      g.total += Number(r.amountOutstanding);
      if ((r.daysOverdue ?? 0) > 0) g.overdue += Number(r.amountOutstanding);
      byClient.set(r.clientId, g);
    }
    return Array.from(byClient.values()).sort((a, b) => b.overdue - a.overdue || b.total - a.total);
  }, [rows]);

  const total = rows.reduce((s, r) => s + Number(r.amountOutstanding), 0);
  const overdueTotal = rows.reduce((s, r) => s + ((r.daysOverdue ?? 0) > 0 ? Number(r.amountOutstanding) : 0), 0);

  if (!open) return null;

  function body() {
    return JSON.stringify({
      bookingIds: rows.map((r) => r.bookingId),
      title: title.trim() || undefined,
      note: note.trim() || undefined,
      includeContacts,
    });
  }

  function requestInit(): RequestInit {
    return { method: "POST", headers: { "Content-Type": "application/json" }, body: body() };
  }

  async function run(kind: "print" | "pdf" | "xlsx") {
    if (rows.length === 0) return;
    setBusy(kind);
    try {
      if (kind === "print") {
        await printEstimate(PDF_PATH, REPORT_NOT_FOUND, requestInit());
      } else if (kind === "pdf") {
        await downloadEstimate(PDF_PATH, "Реестр задолженности.pdf", REPORT_NOT_FOUND, requestInit());
      } else {
        await downloadEstimate(XLSX_PATH, "Реестр задолженности.xlsx", REPORT_NOT_FOUND, requestInit());
      }
    } finally {
      setBusy(null);
    }
  }

  const disabled = rows.length === 0 || busy !== null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-scrim/50 p-0 sm:items-center sm:p-6"
      onClick={() => !busy && onClose()}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Сформировать отчёт по долгам"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[92vh] w-full max-w-[720px] flex-col overflow-hidden rounded-t-xl border border-border bg-surface shadow-lg sm:rounded-xl"
      >
        {/* Шапка */}
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <p className="eyebrow text-ink-3">Взыскание</p>
            <h2 className="mt-0.5 text-[17px] font-semibold text-ink">Отчёт по выбранным долгам</h2>
            <p className="mt-1 text-[12.5px] text-ink-2">
              {groups.length} {pluralize(groups.length, "клиент", "клиента", "клиентов")}
              {" · "}
              {rows.length} {pluralize(rows.length, "долг", "долга", "долгов")}
              {" · "}
              <strong className="mono-num text-ink">{formatRub(total)}</strong>
              {overdueTotal > 0 && (
                <>
                  {" · просрочено "}
                  <strong className="mono-num text-rose">{formatRub(overdueTotal)}</strong>
                </>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            disabled={busy !== null}
            className="rounded p-1 text-ink-3 hover:bg-surface-muted hover:text-ink disabled:opacity-40"
          >
            ✕
          </button>
        </div>

        {/* Состав отчёта */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-ink-3">
              Ничего не выбрано — отметьте долги в реестре.
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              {groups.map((g) => (
                <div key={g.clientId} className="rounded-lg border border-border">
                  <div className="flex items-center justify-between gap-2 border-b border-border bg-surface-subtle px-3 py-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13.5px] font-semibold text-ink">{g.clientName}</div>
                      <div className="text-[11.5px] text-ink-3">
                        {g.rows.length} {pluralize(g.rows.length, "долг", "долга", "долгов")}
                        {g.overdue > 0 && <span className="text-rose"> · просрочено {formatRub(g.overdue)}</span>}
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <span className="mono-num text-[13.5px] font-semibold text-ink">{formatRub(g.total)}</span>
                      <button
                        type="button"
                        aria-label={`Убрать клиента ${g.clientName} из отчёта`}
                        onClick={() => onRemoveClient(g.clientId)}
                        disabled={busy !== null}
                        className="rounded border border-border px-2 py-0.5 text-[11px] text-ink-3 hover:bg-surface hover:text-rose disabled:opacity-40"
                      >
                        убрать
                      </button>
                    </div>
                  </div>
                  <ul>
                    {g.rows.map((r) => (
                      <li
                        key={r.bookingId}
                        className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5 text-[12.5px] last:border-b-0"
                      >
                        <span className="min-w-0 flex-1 truncate text-ink-2">{r.projectName}</span>
                        {(r.daysOverdue ?? 0) > 0 && (
                          <span className="flex-shrink-0 text-[11px] text-rose">
                            {r.daysOverdue} {pluralize(r.daysOverdue ?? 0, "день", "дня", "дней")}
                          </span>
                        )}
                        <span className="mono-num flex-shrink-0 text-ink">{formatRub(r.amountOutstanding)}</span>
                        <button
                          type="button"
                          aria-label={`Убрать «${r.projectName}» из отчёта`}
                          onClick={() => onRemove(r.bookingId)}
                          disabled={busy !== null}
                          className="flex-shrink-0 rounded px-1 text-ink-3 hover:text-rose disabled:opacity-40"
                        >
                          ✕
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          {/* Настройки документа */}
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="debt-report-title" className="eyebrow mb-1 block">
                Заголовок документа
              </label>
              <input
                id="debt-report-title"
                type="text"
                maxLength={120}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Реестр задолженности"
                className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </div>
            <div className="flex items-end">
              <label className="flex cursor-pointer items-start gap-2 text-[12.5px] text-ink-2">
                <input
                  type="checkbox"
                  checked={includeContacts}
                  onChange={(e) => setIncludeContacts(e.target.checked)}
                  className="mt-0.5 rounded border-border"
                />
                <span>
                  Печатать контакты клиентов
                  <span className="block text-[11px] text-ink-3">
                    телефон и почта рядом с именем — чтобы звонить с листа
                  </span>
                </span>
              </label>
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="debt-report-note" className="eyebrow mb-1 block">
                Примечание для сотрудника
              </label>
              <textarea
                id="debt-report-note"
                rows={2}
                maxLength={1000}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Например: обзвонить до пятницы, по «Эпикпро» говорить только с главбухом"
                className="w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </div>
          </div>

          <p className="mt-3 text-[11.5px] leading-snug text-ink-3">
            В документе: клиент, проект, выставлено / оплачено / остаток, срок оплаты и просрочка,
            плюс пустая графа «Дата контакта / результат» под запись от руки. Клиенты идут по
            остроте долга, долги старше 60 дней выделены. Суммы берутся на момент формирования:
            если долг успели закрыть, в отчёт он не попадёт.
          </p>
        </div>

        {/* Действия */}
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={busy !== null}
            className="rounded px-3 py-2 text-[13px] text-ink-3 hover:text-ink disabled:opacity-40"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void run("xlsx")}
            disabled={disabled}
            className="rounded border border-border bg-surface px-3.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "xlsx" ? "Готовлю…" : "Скачать XLSX"}
          </button>
          <button
            type="button"
            onClick={() => void run("pdf")}
            disabled={disabled}
            className="rounded border border-border bg-surface px-3.5 py-2 text-[13px] font-medium text-ink-2 hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "pdf" ? "Готовлю…" : "Скачать PDF"}
          </button>
          <button
            type="button"
            onClick={() => void run("print")}
            disabled={disabled}
            className="rounded bg-accent-bright px-4 py-2 text-[13px] font-semibold text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === "print" ? "Готовлю…" : "Печать →"}
          </button>
        </div>
      </div>
    </div>
  );
}
