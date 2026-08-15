"use client";

/**
 * Журнал работ: лента записей и форма новой записи.
 *
 * Форма собрана под человека с грязными руками, который стоит у верстака с
 * телефоном: заготовки-чипы вместо набора текста и пресеты часов вместо
 * цифровой клавиатуры. Своими словами и своё число тоже можно — просто это не
 * основной путь.
 *
 * Первая же запись по карточке, которую никто не взял, берёт её в работу
 * (сервер делает это сам, см. `addWorkLog` в repairService). Поэтому форма
 * показывается и в статусе «Ждёт ремонта» — раньше она там висела, а сервер
 * отвечал на неё 400-м.
 *
 * Суммы — только руководителю: у техника денег на экране нет нигде.
 */

import { useState } from "react";

import { formatRub, pluralize } from "../../lib/format";
import { RepairIcon } from "./RepairRiskBadge";
import { formatDayMonth } from "./types";

export interface RepairWorkLogEntry {
  id: string;
  repairId: string;
  description: string;
  /** Decimal-строка. */
  timeSpentHours: string;
  /** Decimal-строка. */
  partCost: string;
  loggedBy: string;
  /** ISO. */
  loggedAt: string;
  loggedByName: string | null;
}

export interface WorkLogDraft {
  description: string;
  timeSpentHours: number;
  partCost: number;
}

/** «2» → «2 ч», «0.5» → «0,5 ч». Пустые часы печатаем прочерком, а не нулём. */
function hoursText(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return "—";
  return `${String(n).replace(".", ",")} ч`;
}

// ── Лента записей ────────────────────────────────────────────────────────────

export function WorkLogList({
  entries,
  showMoney,
}: {
  entries: RepairWorkLogEntry[];
  showMoney: boolean;
}) {
  if (entries.length === 0) {
    return (
      <p className="rounded border border-dashed border-border-strong bg-surface-muted px-3 py-3 text-[11.5px] leading-[1.45] text-ink-3">
        Записей ещё нет. Первая запись возьмёт ремонт в работу и покажет остальным, что им
        занимаются.
      </p>
    );
  }

  const cols = showMoney
    ? "grid-cols-[minmax(0,1fr)_56px_78px]"
    : "grid-cols-[minmax(0,1fr)_56px]";

  return (
    <div className="flex flex-col">
      {entries.map((e) => (
        <div
          key={e.id}
          className={`grid ${cols} items-baseline gap-2 border-b border-dashed border-border py-1.5 text-[12.5px] last:border-b-0`}
        >
          <div className="min-w-0">
            {e.description}
            <span className="mt-0.5 block text-[11px] text-ink-3">
              {e.loggedByName ?? "автор не определён"} · {formatDayMonth(e.loggedAt)}
            </span>
          </div>
          <span className="mono-num text-right text-xs">{hoursText(e.timeSpentHours)}</span>
          {showMoney && (
            <span className="mono-num text-right text-xs font-semibold">
              {Number(e.partCost) > 0 ? formatRub(e.partCost) : "—"}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Форма ────────────────────────────────────────────────────────────────────

/** Заготовки покрывают почти весь реальный журнал: разбор, замена, сборка, ожидание. */
const PHRASES = [
  "Разобрал, диагностика",
  "Заменил разъём",
  "Заменил балласт",
  "Собрал, проверил — работает",
  "Нужна запчасть",
];

const HOUR_PRESETS = [0.5, 1, 2];

const CHIP =
  "rounded-xl border px-2.5 py-px text-[11px] font-semibold leading-[1.6] transition-colors";
const CHIP_OFF =
  "border-border bg-surface text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright";
const CHIP_ON = "border-accent bg-accent text-surface";

export function WorkLogComposer({
  onSubmit,
  showMoney,
  autoStarts,
}: {
  onSubmit: (draft: WorkLogDraft) => Promise<void>;
  /** Поле стоимости запчасти видит тот, кто видит суммы. */
  showMoney: boolean;
  /** Карточку ещё никто не взял — так и пишем на кнопке, чтобы смена статуса не была сюрпризом. */
  autoStarts: boolean;
}) {
  const [description, setDescription] = useState("");
  const [hours, setHours] = useState("1");
  const [customHours, setCustomHours] = useState(false);
  const [partCost, setPartCost] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addPhrase(phrase: string) {
    setDescription((prev) => (prev.trim() === "" ? phrase : `${prev.trim()}. ${phrase}`));
    setError(null);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (description.trim() === "") {
      setError("Напишите, что сделали — иначе запись ничего не сообщает");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        description: description.trim(),
        timeSpentHours: Number(hours.replace(",", ".")) || 0,
        partCost: showMoney ? Number(partCost.replace(",", ".")) || 0 : 0,
      });
      setDescription("");
      setHours("1");
      setCustomHours(false);
      setPartCost("");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить запись");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-2.5 rounded border border-border bg-surface-muted p-2"
    >
      <p className="mb-1 block text-[11.5px] font-semibold text-ink-2">Что сделал</p>
      <div className="flex flex-wrap gap-1.5">
        {PHRASES.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => addPhrase(p)}
            className={`${CHIP} ${CHIP_OFF}`}
          >
            {p}
          </button>
        ))}
      </div>

      <input
        type="text"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        placeholder="…или своими словами"
        aria-label="Что сделал"
        className="mt-2 w-full rounded border border-border bg-surface px-2 py-1.5 text-[12.5px] text-ink focus:outline-none focus:ring-1 focus:ring-accent"
      />

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[11.5px] text-ink-2">Часы:</span>
        {HOUR_PRESETS.map((h) => {
          const selected = !customHours && Number(hours) === h;
          return (
            <button
              key={h}
              type="button"
              onClick={() => {
                setCustomHours(false);
                setHours(String(h));
              }}
              aria-pressed={selected}
              className={`${CHIP} ${selected ? CHIP_ON : CHIP_OFF}`}
            >
              {String(h).replace(".", ",")}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setCustomHours(true)}
          aria-pressed={customHours}
          className={`${CHIP} ${customHours ? CHIP_ON : CHIP_OFF}`}
        >
          своё
        </button>
        {customHours && (
          <input
            type="number"
            min="0"
            step="0.5"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
            aria-label="Часы работ"
            autoFocus
            className="w-20 rounded border border-border bg-surface px-2 py-1 text-[12.5px] text-ink"
          />
        )}

        {showMoney && (
          <label className="ml-1 inline-flex items-center gap-1.5 text-[11.5px] text-ink-2">
            Запчасть, ₽:
            <input
              type="number"
              min="0"
              value={partCost}
              onChange={(e) => setPartCost(e.target.value)}
              placeholder="0"
              className="w-24 rounded border border-border bg-surface px-2 py-1 text-[12.5px] text-ink"
            />
          </label>
        )}

        <span className="ml-auto" />
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded border border-accent-bright bg-accent-bright px-3 py-1 text-xs font-semibold text-surface transition-colors hover:border-accent hover:bg-accent disabled:opacity-60"
        >
          <RepairIcon name="plus" />
          {saving ? "Записываем…" : autoStarts ? "Записать и взять в работу" : "Записать"}
        </button>
      </div>

      {autoStarts && (
        <p className="mt-1.5 text-[11px] leading-[1.45] text-ink-3">
          Ремонт ещё никем не взят — эта запись возьмёт его на вас.
        </p>
      )}

      {error && (
        <p className="mt-1.5 rounded border border-rose-border bg-rose-soft px-2.5 py-1 text-xs text-rose">
          {error}
        </p>
      )}
    </form>
  );
}

/** «3 записи · 4,5 ч · запчасти 2 400 ₽» — правый край заголовка журнала. */
export function workLogSummary(
  count: number,
  totalHours: string,
  partsCost: string,
  showMoney: boolean,
): string {
  const parts = [`${count} ${pluralize(count, "запись", "записи", "записей")}`];
  if (Number(totalHours) > 0) parts.push(hoursText(totalHours));
  if (showMoney && Number(partsCost) > 0) parts.push(`запчасти ${formatRub(partsCost)}`);
  return parts.join(" · ");
}
