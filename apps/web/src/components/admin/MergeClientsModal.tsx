"use client";

/**
 * «Объединить карточки» — один клиент, заведённый несколько раз под разным
 * написанием («Петя Куб», «петя куб»). Шаг 1 — найти вторую карточку:
 * сначала похожие имена, ниже поиск. Шаг 2 — выбрать, чьё имя остаётся, и
 * увидеть, что переедет: сводку строит сервер тем же планом, что и само
 * объединение (`/api/clients/:id/merge-preview`).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { pluralize } from "../../lib/format";
import { toast } from "../ToastProvider";

export type MergeCandidate = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  bookingCount: number;
};

type ContactOutcome = "keep" | "fill" | "conflict";

export type MergePreview = {
  source: MergeCandidate & { hasPortal: boolean };
  target: MergeCandidate & { hasPortal: boolean };
  moves: { bookings: number; bills: number; creditNotes: number; tasks: number };
  contact: {
    phone: ContactOutcome;
    email: ContactOutcome;
    comment: "keep" | "fill" | "append";
    requisites: ContactOutcome;
  };
  portal: {
    outcome: "none" | "keep" | "move" | "drop";
    keptEmail: string | null;
    droppedEmail: string | null;
  };
};

const SEARCH_DEBOUNCE_MS = 200;
const SEARCH_LIMIT = 20;

const bookingsWord = (n: number) => pluralize(n, "бронь", "брони", "броней");

/** «3 брони · +7 900 …» — подпись под именем в списках и карточках выбора. */
function candidateMeta(c: MergeCandidate): string {
  const parts = [c.bookingCount > 0 ? `${c.bookingCount} ${bookingsWord(c.bookingCount)}` : "без броней"];
  if (c.phone) parts.push(c.phone);
  else if (c.email) parts.push(c.email);
  return parts.join(" · ");
}

/** «без броней» в начале предложения — «Без броней». */
const sentence = (s: string) => s.charAt(0).toLocaleUpperCase("ru-RU") + s.slice(1);

/** Сводка предпросмотра человеческими словами — что переедет и что станет с контактами. */
export function mergeSummary(p: MergePreview): { moves: string[]; contacts: string[]; portal: string | null } {
  const { source, target, moves, contact } = p;
  const moveLines: string[] = [];
  if (moves.bookings > 0) {
    const total = target.bookingCount + moves.bookings;
    moveLines.push(
      `${moves.bookings} ${bookingsWord(moves.bookings)}` +
        (target.bookingCount > 0 ? ` — всего станет ${total}` : ""),
    );
  }
  if (moves.bills > 0)
    moveLines.push(`${moves.bills} ${pluralize(moves.bills, "счёт на оплату", "счёта на оплату", "счетов на оплату")}`);
  if (moves.creditNotes > 0)
    moveLines.push(`${moves.creditNotes} ${pluralize(moves.creditNotes, "кредит-нота", "кредит-ноты", "кредит-нот")}`);
  if (moves.tasks > 0) moveLines.push(`${moves.tasks} ${pluralize(moves.tasks, "задача", "задачи", "задач")}`);

  const contacts: string[] = [];
  if (contact.phone === "fill") contacts.push(`Телефон ${source.phone} станет телефоном карточки`);
  if (contact.phone === "conflict")
    contacts.push(`Телефон ${source.phone} сохранится в комментарии — у карточки свой ${target.phone}`);
  if (contact.email === "fill") contacts.push(`Почта ${source.email} станет почтой карточки`);
  if (contact.email === "conflict")
    contacts.push(`Почта ${source.email} сохранится в комментарии — у карточки своя ${target.email}`);
  if (contact.requisites === "fill") contacts.push("Реквизиты для счёта перенесутся");
  if (contact.requisites === "conflict") contacts.push("Реквизиты для счёта останутся свои, ИНН второй карточки — в комментарии");
  if (contact.comment === "fill") contacts.push("Комментарий перенесётся");
  if (contact.comment === "append" && contact.phone !== "conflict" && contact.email !== "conflict" && contact.requisites !== "conflict")
    contacts.push("Комментарий допишется к комментарию карточки");

  const portal =
    p.portal.outcome === "move"
      ? `Доступ в личный кабинет (${p.portal.keptEmail}) перейдёт к «${target.name}»`
      : p.portal.outcome === "drop"
        ? `Останется кабинет «${target.name}» (${p.portal.keptEmail}), кабинет «${source.name}» (${p.portal.droppedEmail}) закроется`
        : null;

  return { moves: moveLines, contacts, portal };
}

type Props = {
  /** Карточка, с которой начали объединение; null — окно закрыто. */
  client: MergeCandidate | null;
  onClose: () => void;
  /** Объединили: id карточки, которая осталась. */
  onMerged: (keptId: string) => void;
};

export function MergeClientsModal({ client, onClose, onMerged }: Props) {
  const [other, setOther] = useState<MergeCandidate | null>(null);
  const [keepId, setKeepId] = useState<string | null>(null);
  const [similar, setSimilar] = useState<MergeCandidate[] | null>(null);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<MergeCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const open = client !== null;

  // Новое открытие — с чистого листа: похожие имена грузятся заново.
  useEffect(() => {
    setOther(null);
    setKeepId(null);
    setSearch("");
    setResults([]);
    setPreview(null);
    setPreviewError(null);
    setError(null);
    setSimilar(null);
    if (!client) return;
    let cancelled = false;
    apiFetch<{ clients: MergeCandidate[] }>(`/api/clients/${client.id}/similar`)
      .then((d) => {
        if (!cancelled) setSimilar(d.clients);
      })
      .catch(() => {
        // Подсказка необязательна: без неё остаётся поиск.
        if (!cancelled) setSimilar([]);
      });
    const t = window.setTimeout(() => searchRef.current?.focus(), 50);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [client]);

  // Поиск второй карточки — тот же серверный поиск без учёта регистра.
  useEffect(() => {
    if (!client || other) return;
    const q = search.trim();
    if (!q) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearching(true);
      apiFetch<{ clients: MergeCandidate[] }>(
        `/api/clients?search=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`,
      )
        .then((d) => {
          if (!cancelled) setResults(d.clients.filter((c) => c.id !== client.id));
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [client, other, search]);

  const keep = client && other ? (keepId === other.id ? other : client) : null;
  const drop = client && other ? (keep?.id === other.id ? client : other) : null;

  const loadPreview = useCallback(async (sourceId: string, targetId: string, signal?: { cancelled: boolean }) => {
    setPreview(null);
    setPreviewError(null);
    try {
      const p = await apiFetch<MergePreview>(
        `/api/clients/${sourceId}/merge-preview?into=${encodeURIComponent(targetId)}`,
      );
      if (!signal?.cancelled) setPreview(p);
    } catch (e) {
      if (!signal?.cancelled) setPreviewError(e instanceof Error ? e.message : "Не удалось посчитать, что переедет");
    }
  }, []);

  useEffect(() => {
    if (!keep || !drop) return;
    const signal = { cancelled: false };
    void loadPreview(drop.id, keep.id, signal);
    return () => {
      signal.cancelled = true;
    };
  }, [keep, drop, loadPreview]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !merging) {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const root = dialogRef.current;
      if (!root) return;
      const focusable = root.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || !root.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, merging, onClose]);

  if (!client) return null;

  const choose = (c: MergeCandidate) => {
    setOther(c);
    // Остаётся карточка, у которой больше броней: обычно это и есть «настоящая».
    setKeepId(c.bookingCount > client.bookingCount ? c.id : client.bookingCount > c.bookingCount ? client.id : c.id);
    setError(null);
  };

  const back = () => {
    setOther(null);
    setKeepId(null);
    setPreview(null);
    setPreviewError(null);
    setError(null);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  };

  const confirm = async () => {
    if (!keep || !drop || !preview) return;
    setMerging(true);
    setError(null);
    try {
      await apiFetch(`/api/clients/${drop.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ intoClientId: keep.id }),
      });
      toast.success(`Карточки объединены — осталась «${keep.name}»`);
      onMerged(keep.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось объединить карточки");
    } finally {
      setMerging(false);
    }
  };

  const summary = preview ? mergeSummary(preview) : null;
  const shownSimilar = (similar ?? []).filter((c) => c.id !== client.id);

  const optionRow = (c: MergeCandidate) => (
    <li key={c.id}>
      <button
        type="button"
        onClick={() => choose(c)}
        className="flex w-full min-h-11 items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-subtle focus-visible:bg-surface-subtle focus-visible:outline-none"
      >
        <span className="min-w-0">
          <span className="block break-words text-[13.5px] font-medium text-ink">{c.name}</span>
          <span className="block text-[12px] text-ink-3">{candidateMeta(c)}</span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-ink-3">›</span>
      </button>
    </li>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/50 px-4"
      onClick={() => !merging && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="merge-clients-title"
        className="flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-lg bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <p className="eyebrow mb-1">Объединение карточек</p>
            <h2 id="merge-clients-title" className="break-words text-[17px] font-semibold text-ink">
              {other ? "Объединить карточки" : `Объединить «${client.name}»`}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={merging}
            className="-mr-1 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded text-xl leading-none text-ink-3 hover:bg-surface-subtle hover:text-ink disabled:opacity-50"
            aria-label="Закрыть"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!other ? (
            <>
              <p className="mb-4 text-[13px] text-ink-2">
                {sentence(candidateMeta(client))}. Найдите карточку того же клиента — брони, счета и контакты соберутся
                в одной, а лишняя карточка исчезнет из справочника.
              </p>

              {shownSimilar.length > 0 && (
                <section aria-labelledby="merge-similar-title" className="mb-4">
                  <h3 id="merge-similar-title" className="eyebrow mb-1.5 text-ink-2">
                    Похожие имена
                  </h3>
                  <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                    {shownSimilar.map(optionRow)}
                  </ul>
                </section>
              )}

              <label htmlFor="merge-clients-search" className="eyebrow mb-1.5 block text-ink-2">
                {shownSimilar.length > 0 ? "Другая карточка" : "Найти карточку"}
              </label>
              <input
                id="merge-clients-search"
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Имя клиента…"
                autoComplete="off"
                className="mb-2 w-full rounded border border-border bg-surface px-3 py-2 text-[13.5px] text-ink focus:border-accent-bright focus:outline-none focus:ring-[3px] focus:ring-accent-soft"
              />
              {search.trim() &&
                (searching && results.length === 0 ? (
                  <p className="py-3 text-center text-[13px] text-ink-3">Ищу…</p>
                ) : results.length === 0 ? (
                  <p className="py-3 text-center text-[13px] text-ink-3">Никого с таким именем нет</p>
                ) : (
                  <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
                    {results.map(optionRow)}
                  </ul>
                ))}
            </>
          ) : (
            <>
              <fieldset className="mb-4">
                <legend className="eyebrow mb-1.5 text-ink-2">Какое имя оставить</legend>
                <div className="space-y-2">
                  {[client, other].map((c) => {
                    const checked = keep?.id === c.id;
                    return (
                      <label
                        key={c.id}
                        className={[
                          "flex cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-colors",
                          checked
                            ? "border-accent-bright bg-accent-soft"
                            : "border-border hover:bg-surface-subtle",
                        ].join(" ")}
                      >
                        <input
                          type="radio"
                          name="merge-keep"
                          value={c.id}
                          checked={checked}
                          onChange={() => setKeepId(c.id)}
                          disabled={merging}
                          className="mt-1 h-4 w-4 shrink-0 accent-accent-bright"
                        />
                        <span className="min-w-0">
                          <span className="block break-words text-[13.5px] font-medium text-ink">{c.name}</span>
                          <span className="block text-[12px] text-ink-3">{candidateMeta(c)}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>

              {previewError ? (
                <div className="rounded-md border border-rose-border bg-rose-soft px-3 py-2.5 text-[13px] text-rose">
                  {previewError}{" "}
                  <button
                    type="button"
                    onClick={() => keep && drop && void loadPreview(drop.id, keep.id)}
                    className="underline underline-offset-2"
                  >
                    Повторить
                  </button>
                </div>
              ) : !summary || !keep || !drop ? (
                <div className="space-y-2 rounded-md border border-border bg-surface-subtle px-3 py-3" aria-busy="true">
                  <p className="text-[13px] text-ink-3">Считаю, что переедет…</p>
                  <div className="h-3 w-2/3 animate-pulse rounded bg-border" />
                  <div className="h-3 w-1/2 animate-pulse rounded bg-border" />
                </div>
              ) : (
                <div className="space-y-3 rounded-md border border-border bg-surface-subtle px-3 py-3 text-[13px] text-ink">
                  <div>
                    <p className="mb-1 font-medium">К «{keep.name}» перейдут</p>
                    {summary.moves.length > 0 ? (
                      <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
                        {summary.moves.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-ink-3">Переносить нечего — у второй карточки нет броней и документов.</p>
                    )}
                  </div>
                  {summary.contacts.length > 0 && (
                    <div>
                      <p className="mb-1 font-medium">Контакты</p>
                      <ul className="list-disc space-y-0.5 pl-5 text-ink-2">
                        {summary.contacts.map((l) => (
                          <li key={l} className="break-words">{l}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {summary.portal && (
                    <div>
                      <p className="mb-1 font-medium">Личный кабинет</p>
                      <p className="break-words text-ink-2">{summary.portal}</p>
                    </div>
                  )}
                </div>
              )}

              {keep && drop && (
                <p className="mt-3 rounded-md border border-amber-border bg-amber-soft px-3 py-2 text-[12.5px] text-amber">
                  Карточка «{drop.name}» исчезнет из справочника. Отменить объединение нельзя.
                </p>
              )}
              {error && (
                <p role="alert" className="mt-3 text-[13px] text-rose">
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3">
          {other && (
            <button
              type="button"
              onClick={back}
              disabled={merging}
              className="mr-auto rounded px-2 py-2 text-sm text-ink-2 hover:bg-surface-subtle hover:text-ink disabled:opacity-50"
            >
              ← Другая карточка
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            disabled={merging}
            className="rounded border border-border px-4 py-2 text-sm text-ink-2 hover:bg-surface-subtle disabled:opacity-50"
          >
            Отмена
          </button>
          {other && (
            <button
              type="button"
              onClick={confirm}
              disabled={merging || !preview}
              className="rounded bg-accent-bright px-4 py-2 text-sm text-surface hover:bg-accent disabled:opacity-50"
            >
              {merging ? "Объединяю…" : "Объединить"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
