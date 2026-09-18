"use client";

/**
 * «Ошибка учёта» — причина обязательна (решение владельца: поправку может
 * сделать и кладовщик, но с причиной — она уходит в журнал). Не короче
 * 3 символов после обрезки пробелов, как проверяет сервер (REASON_REQUIRED).
 *
 * Форма сбрасывается только при открытии и при переходе к другой строке.
 * Список расхождений перечитывается, пока диалог открыт (раз в 20 с и при
 * чужом счёте), и та же строка приходит новым объектом — набранная причина
 * от этого стираться не должна. Так же и после 409 LINE_CHANGED (строку
 * пересчитали, пока диалог был открыт): диалог остаётся открытым с набранной
 * причиной и уже новым расхождением — руководитель проверяет его и
 * отправляет причину заново, не набирая её ещё раз.
 *
 * «Учёт поправится: X → Y» — от ТЕКУЩЕГО количества (живого, если учёт менялся
 * после счёта): поправка ложится дельтой на него, как на сервере.
 */

import { useRef, useState } from "react";

import { InventoryDialog } from "./InventoryDialog";
import { adjustPreview, signed } from "./format";
import type { StockCountLineView } from "./types";
import { BTN_GHOST, BTN_PRIMARY } from "./ui";

export const ADJUST_REASON_MIN = 3;

/** Излишек, который может быть бронью, не отмеченной возвращённой. */
export function surplusMayBeUnreturned(line: StockCountLineView): boolean {
  const diff = line.diff ?? 0;
  return diff > 0 && line.expected.issued + line.expected.calendar >= diff;
}

export function AdjustReasonDialog({
  line,
  busy,
  onClose,
  onSubmit,
}: {
  /** null — диалог закрыт. */
  line: StockCountLineView | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (note: string) => void;
}) {
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Какую строку диалог показывает сейчас: null — закрыт. Сравниваем по id,
  // а не по объекту; сброс — прямо в рендере, чтобы при повторном открытии не
  // мелькнула прошлая причина.
  const openId = line?.id ?? null;
  const [shownId, setShownId] = useState<string | null>(null);
  if (openId !== shownId) {
    setShownId(openId);
    if (line) {
      setNote(line.decision === "ADJUST" ? (line.decisionNote ?? "") : "");
      setTouched(false);
    }
  }

  const open = line != null;
  const trimmed = note.trim();
  const valid = trimmed.length >= ADJUST_REASON_MIN;
  const diff = line?.diff ?? 0;
  const preview = line ? adjustPreview(line) : { from: 0, to: 0 };
  const warnUnreturned = line != null && surplusMayBeUnreturned(line);

  const submit = () => {
    setTouched(true);
    if (!valid || busy) return;
    onSubmit(trimmed);
  };

  return (
    <InventoryDialog
      open={open}
      eyebrow="Ошибка учёта"
      title={line?.name ?? ""}
      busy={busy}
      onClose={onClose}
      initialFocusRef={textareaRef}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className={BTN_GHOST}>
            Отмена
          </button>
          <button type="button" onClick={submit} disabled={!valid || busy} className={BTN_PRIMARY}>
            {busy ? "Сохраняю…" : "Поправить учёт"}
          </button>
        </>
      }
    >
      <p>
        Расхождение <b className="mono-num text-ink">{signed(diff)}</b> — не пропажа, а неверное количество в каталоге.
        При завершении учёт поправится:{" "}
        <b className="mono-num text-ink">
          {preview.from} → {preview.to}
        </b>
        .
      </p>
      {warnUnreturned && (
        <p className="mt-2 rounded border border-amber-border bg-amber-soft px-2 py-1.5 text-xs text-ink">
          <b className="font-semibold text-amber">Излишек может быть бронью, не отмеченной возвращённой</b> — сначала
          отметьте возврат и обновите ожидание.
        </p>
      )}
      <label htmlFor="adjust-reason" className="mt-3 block text-xs font-semibold text-ink">
        Причина <span className="text-rose">*</span>
      </label>
      <textarea
        id="adjust-reason"
        ref={textareaRef}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onBlur={() => setTouched(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
        maxLength={2000}
        disabled={busy}
        aria-invalid={touched && !valid}
        aria-describedby="adjust-reason-hint"
        placeholder="Например: в каталоге с импорта 5, по факту всегда было 3"
        className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-3 focus-visible:border-accent-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-soft disabled:opacity-60"
      />
      <p id="adjust-reason-hint" className={`mt-1 text-[11px] ${touched && !valid ? "text-rose" : "text-ink-3"}`}>
        {touched && !valid
          ? `Укажите причину — не короче ${ADJUST_REASON_MIN} символов`
          : "Причина попадёт в журнал вместе с именем того, кто поправил"}
      </p>
    </InventoryDialog>
  );
}
