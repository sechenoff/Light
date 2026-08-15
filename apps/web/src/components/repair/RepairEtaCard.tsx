"use client";

/**
 * «Когда вернётся» — единственное место карточки ремонта с ручным вводом.
 *
 * Поэтому «не знаю» здесь тоже в один тап: пустой срок честно печатается
 * словами «срок не назначен», а не подменяется выдуманным прогнозом. По
 * выдуманной дате начнут планировать съёмку — и узнают о срыве в день выдачи.
 *
 * Пресеты (завтра / 3 дня / неделя) сохраняются сразу: техник стоит у
 * верстака, лишний тап по «Сохранить» здесь стоит дороже, чем кажется.
 */

import { useEffect, useState } from "react";

import { BTN_MINI, CARD, CARD_ZONE, CHIP, CHIP_OFF, CHIP_ON, daysText } from "./cardChrome";
import { RepairIcon } from "./RepairRiskBadge";
import { toMoscowDateString } from "../../lib/moscowDate";
import { daysUntil, formatDayMonth, isEtaOverdue, type RepairListItem } from "./types";

export interface EtaPatch {
  /** «YYYY-MM-DD» либо ISO; null — снять срок. */
  expectedReadyAt?: string | null;
  partsNote?: string | null;
}

/** Дата в формате `<input type="date">` либо пустая строка. */
function dateInputValue(iso: string | null): string {
  return iso ? toMoscowDateString(new Date(iso)) : "";
}

export function RepairEtaCard({
  repair,
  editable,
  onPatch,
}: {
  repair: RepairListItem;
  /** Срок ставят те, кто чинит: руководитель и техник. */
  editable: boolean;
  onPatch: (patch: EtaPatch) => Promise<void>;
}) {
  const [date, setDate] = useState(() => dateInputValue(repair.expectedReadyAt));
  const [note, setNote] = useState(repair.partsNote ?? "");
  const [saving, setSaving] = useState(false);

  // Ответ сервера авторитетнее черновика: вместе со сроком приезжает
  // пересчитанный риск, и поля обязаны показывать то, что легло в базу.
  useEffect(() => {
    setDate(dateInputValue(repair.expectedReadyAt));
    setNote(repair.partsNote ?? "");
  }, [repair.expectedReadyAt, repair.partsNote]);

  const overdue = isEtaOverdue(repair);
  const blocksBooking = repair.risk.level === "BLOCKS" || repair.risk.level === "TIGHT";
  const late = blocksBooking && repair.risk.slackDays !== null && repair.risk.slackDays < 0;

  async function save(patch: EtaPatch) {
    setSaving(true);
    try {
      await onPatch(patch);
    } catch {
      // Сообщение показывает страница через toast — здесь важно только снять
      // блокировку кнопок, иначе форма застынет навсегда.
    } finally {
      setSaving(false);
    }
  }

  function pickInDays(days: number) {
    const base = new Date();
    base.setDate(base.getDate() + days);
    const next = toMoscowDateString(base);
    setDate(next);
    void save({ expectedReadyAt: next, partsNote: note.trim() === "" ? null : note.trim() });
  }

  let sub: string;
  if (!repair.expectedReadyAt) {
    const until = repair.risk.booking ? daysUntil(repair.risk.booking.startDate) : null;
    sub =
      until !== null && until >= 0
        ? `никто не сказал, когда вернётся — до брони ${daysText(until)}`
        : "никто не назначил срок — дату не выдумываем";
  } else if (overdue) {
    sub = `срок прошёл ${daysText(Math.abs(daysUntil(repair.expectedReadyAt)))} назад`;
  } else if (late && repair.risk.slackDays !== null) {
    sub = `позже брони на ${daysText(Math.abs(repair.risk.slackDays))}`;
  } else if (blocksBooking && repair.risk.slackDays !== null) {
    sub = `до брони остаётся ${daysText(repair.risk.slackDays)} запаса`;
  } else {
    sub = "срок назначен техником";
  }

  const dirty =
    date !== dateInputValue(repair.expectedReadyAt) || note.trim() !== (repair.partsNote ?? "");

  const presets: { label: string; days: number }[] = [
    { label: "завтра", days: 1 },
    { label: "3 дня", days: 3 },
    { label: "неделя", days: 7 },
  ];

  return (
    <section className={CARD}>
      <div className={CARD_ZONE}>
        <p className="eyebrow mb-1.5 inline-flex items-center gap-1.5">
          <RepairIcon name="clock" />
          Когда вернётся
        </p>

        {repair.expectedReadyAt ? (
          <p
            className={`mono-num text-2xl font-semibold leading-tight tracking-[-0.015em] ${
              overdue || late ? "text-rose" : "text-ink"
            }`}
          >
            до {formatDayMonth(repair.expectedReadyAt)}
          </p>
        ) : (
          <p className="text-xl font-semibold leading-tight text-ink-3">срок не назначен</p>
        )}

        <p className="mt-0.5 text-[11px] leading-[1.45] text-ink-3">
          {repair.partsNote ? `Ждём ${repair.partsNote} · ` : ""}
          {sub}
        </p>

        {editable && (
          <div className="mt-2.5 border-t border-dashed border-border pt-2.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                aria-label="Срок возврата"
                className="rounded border border-border bg-surface px-2 py-1 text-[12.5px] text-ink"
              />
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  disabled={saving}
                  onClick={() => pickInDays(p.days)}
                  className={`${CHIP} ${CHIP_OFF}`}
                >
                  {p.label}
                </button>
              ))}
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setDate("");
                  void save({ expectedReadyAt: null });
                }}
                className={`${CHIP} ${repair.expectedReadyAt === null ? CHIP_ON : CHIP_OFF}`}
              >
                не знаю
              </button>
            </div>

            <input
              type="text"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
              placeholder="чего ждём — например, разъём Neutrik NL4"
              aria-label="Чего ждём"
              className="mt-2 w-full rounded border border-border bg-surface px-2 py-1.5 text-[12.5px] text-ink"
            />

            <div className="mt-2 flex items-center gap-2">
              <p className="text-[11px] leading-[1.4] text-ink-3">
                «Не знаю» — валидный ответ: честный пробел лучше выдуманной даты.
              </p>
              <button
                type="button"
                disabled={saving || !dirty}
                onClick={() =>
                  void save({
                    expectedReadyAt: date === "" ? null : date,
                    partsNote: note.trim() === "" ? null : note.trim(),
                  })
                }
                className={`${BTN_MINI} ml-auto shrink-0`}
              >
                {saving ? "Сохраняем…" : "Сохранить срок"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
