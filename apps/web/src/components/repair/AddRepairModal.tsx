"use client";

/**
 * «Завести поломку» — точка входа в мастерскую вне приёмки.
 *
 * Прибор ломается не только на возврате: его находят на полке, роняют на
 * погрузке, привозят с площадки отдельно. До этой модалки такую поломку
 * заводить было негде, и сломанное продолжало числиться свободным.
 *
 * Четыре шага: что сломалось → какая именно единица (или сколько штук) → что
 * случилось → когда вернётся. Конфликт с бронью НЕ блокирует сохранение:
 * прибор сломан по факту, а не по учёту. Поэтому предупреждение показывается
 * после сохранения — с настоящей бронью из ответа сервера, а не с догадкой.
 */

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toast } from "../ToastProvider";
import { RepairIcon } from "./RepairRiskBadge";
import {
  formatDayMonth,
  type EquipmentSearchItem,
  type EquipmentUnitItem,
  type RepairListItem,
} from "./types";

const REASON_PRESETS = [
  "Не включается",
  "Механическое повреждение",
  "Не держит режим",
  "Повреждён кабель / разъём",
  "Попала влага",
];

const ETA_PRESETS: { label: string; days: number | null }[] = [
  { label: "завтра", days: 1 },
  { label: "3 дня", days: 3 },
  { label: "неделя", days: 7 },
  { label: "не знаю", days: null },
];

/** Единицы, на которые вторую карточку заводить нельзя или бессмысленно. */
const UNIT_BLOCKED: Partial<Record<EquipmentUnitItem["status"], string>> = {
  MAINTENANCE: "уже в ремонте",
  RETIRED: "списана",
  MISSING: "не найдена",
};

const CHIP =
  "rounded-xl border px-2.5 py-px text-[11px] font-semibold leading-[1.6] transition-colors";
const CHIP_OFF =
  "border-border bg-surface text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright";
const CHIP_ON = "border-accent bg-accent text-surface";
const FIELD =
  "w-full rounded border border-border bg-surface px-2 py-1.5 text-[12.5px] text-ink placeholder:text-ink-3";
const MINI =
  "inline-flex items-center justify-center gap-1 rounded border border-border bg-surface px-2 py-0.5 text-[11px] font-semibold leading-[1.55] text-ink-2 transition-colors hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright disabled:opacity-50";

function Step({
  n,
  title,
  hint,
  done,
  children,
}: {
  n: string;
  title: string;
  hint?: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[22px_minmax(0,1fr)] gap-2.5 border-b border-border px-4 py-3 last:border-b-0">
      <span
        className={`mt-px flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[11px] font-semibold leading-none ${
          done ? "border-accent bg-accent text-surface" : "border-border text-ink-3"
        }`}
      >
        {n}
      </span>
      <div className="min-w-0">
        <p className="mb-1.5 text-[12.5px] font-semibold text-ink">
          {title}
          {hint && <span className="font-normal text-ink-3"> · {hint}</span>}
        </p>
        {children}
      </div>
    </div>
  );
}

export function AddRepairModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  /** Вызывается после успешного создания — страница перечитывает очередь. */
  onCreated: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EquipmentSearchItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<EquipmentSearchItem | null>(null);

  const [units, setUnits] = useState<EquipmentUnitItem[]>([]);
  const [unitId, setUnitId] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);

  const [reason, setReason] = useState("");
  const [photos, setPhotos] = useState<File[]>([]);
  const [etaDays, setEtaDays] = useState<number | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateRepairId, setDuplicateRepairId] = useState<string | null>(null);
  /** Заведённая карточка с риском из ответа сервера — второй экран модалки. */
  const [created, setCreated] = useState<RepairListItem | null>(null);

  const searchRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setQuery("");
    setResults([]);
    setPicked(null);
    setUnits([]);
    setUnitId(null);
    setQuantity(1);
    setReason("");
    setPhotos([]);
    setEtaDays(null);
    setError(null);
    setDuplicateRepairId(null);
    setCreated(null);
  }, []);

  useEffect(() => {
    if (open) reset();
  }, [open, reset]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, saving, onClose]);

  // Поиск по названию, как в доборе на складе: штрихкод вводить не нужно.
  useEffect(() => {
    if (!open || picked) return;
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      apiFetch<{ equipments: EquipmentSearchItem[] }>(
        `/api/equipment?search=${encodeURIComponent(needle)}`,
      )
        .then((d) => {
          if (!cancelled) setResults(d.equipments.slice(0, 8));
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query, open, picked]);

  useEffect(() => {
    if (!picked || picked.stockTrackingMode !== "UNIT") {
      setUnits([]);
      return;
    }
    let cancelled = false;
    apiFetch<{ units: EquipmentUnitItem[] }>(`/api/equipment/${picked.id}/units`)
      .then((d) => {
        if (!cancelled) setUnits(d.units);
      })
      .catch(() => {
        if (!cancelled) setUnits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [picked]);

  if (!open) return null;

  const isUnitMode = picked?.stockTrackingMode === "UNIT";
  const parkTotal = picked?.totalQuantity ?? 0;
  const freeNow = isUnitMode ? (picked?.unitStatusCounts?.AVAILABLE ?? 0) : null;
  const willBeFree = freeNow === null ? null : Math.max(0, freeNow - (isUnitMode ? 1 : quantity));

  const canSubmit =
    picked !== null && reason.trim().length > 0 && (!isUnitMode || unitId !== null) && !saving;

  function etaValue(): string | null {
    if (etaDays === null) return null;
    const d = new Date();
    d.setDate(d.getDate() + etaDays);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Фото — best-effort и намеренно не в транзакции: карточка уже заведена, и
   * ронять её из-за неудачной загрузки снимка нельзя. Не прикрепилось —
   * говорим об этом и отправляем человека дозагрузить в карточку.
   */
  async function uploadPhotos(repairId: string) {
    if (photos.length === 0) return;
    try {
      for (const file of photos) {
        const form = new FormData();
        form.append("photo", file);
        await apiFetch(`/api/repairs/${repairId}/photos`, { method: "POST", body: form });
      }
    } catch {
      toast.info("Поломка заведена, но фото не прикрепились — добавьте их в карточке ремонта");
    }
  }

  async function handleSubmit() {
    if (!picked) return;
    setSaving(true);
    setError(null);
    setDuplicateRepairId(null);
    try {
      const { repair } = await apiFetch<{ repair: RepairListItem }>("/api/repairs", {
        method: "POST",
        body: JSON.stringify({
          equipmentId: picked.id,
          ...(unitId ? { unitId } : {}),
          quantity: isUnitMode ? 1 : quantity,
          reason: reason.trim(),
          expectedReadyAt: etaValue(),
          acknowledgedConflict: true,
        }),
      });
      await uploadPhotos(repair.id);
      onCreated();

      // Риск считает сервер. Если бронь под ударом — показываем её и не даём
      // закрыть модалку молча: это тот случай, когда гафферу лучше позвонить.
      if (repair.risk.level === "BLOCKS" || repair.risk.level === "TIGHT") {
        setCreated(repair);
        setSaving(false);
        return;
      }
      toast.success("Поломка заведена — прибор выведен из работы");
      onClose();
    } catch (e: unknown) {
      const err = e as { code?: string; details?: { repairId?: string }; message?: string };
      if (err?.code === "REPAIR_ACTIVE_EXISTS" && err.details?.repairId) {
        setDuplicateRepairId(err.details.repairId);
      } else {
        setError(err?.message ?? "Не удалось завести поломку");
      }
      setSaving(false);
    }
  }

  // ── Экран результата: бронь под угрозой ────────────────────────────────────

  if (created) {
    const b = created.risk.booking;
    return (
      <div className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-scrim/40 px-4 py-6">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Поломка заведена"
          className="w-full max-w-[660px] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-lg"
        >
          <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <RepairIcon name="alert" large className="text-rose" />
            <h3 className="font-cond text-[15px] font-bold">Поломка заведена — бронь под угрозой</h3>
            <button
              type="button"
              aria-label="Закрыть"
              onClick={onClose}
              className="ml-auto text-ink-3 hover:text-ink"
            >
              <RepairIcon name="x" large />
            </button>
          </div>

          <div className="flex flex-col gap-3 px-4 py-3">
            <p className="flex items-start gap-2 rounded border border-rose-border bg-rose-soft px-2.5 py-2 text-xs leading-[1.45] text-rose">
              <RepairIcon name="block" className="mt-0.5" />
              <span>
                <b className="font-bold">На эти даты уже есть бронь.</b>{" "}
                {/* Без кавычек вокруг проекта: имена проектов часто содержат
                    свои — «Клип «Север»» читался как двойное экранирование. */}
                {b
                  ? `${formatDayMonth(b.startDate)}, ${b.projectName}, ${b.clientName} — не хватает ${created.risk.shortfall} шт, подмены в парке нет.`
                  : `Свободных не хватает: не хватает ${created.risk.shortfall} шт.`}{" "}
                <span className="font-normal text-ink-2">
                  Карточка уже в очереди: прибор сломан по факту, а не по учёту. Гафферу лучше
                  позвонить сегодня.
                </span>
              </span>
            </p>
            <p className="flex items-start gap-2 rounded border border-teal-border bg-teal-soft px-2.5 py-2 text-xs leading-[1.45] text-teal">
              <RepairIcon name="check" className="mt-0.5" />
              <span>
                <b className="font-bold">Перестало числиться свободным.</b> Календарь, проверка
                доступности и добор на складе теперь считают одинаково.
              </span>
            </p>
          </div>

          <div className="flex items-center gap-2 border-t border-border bg-surface-muted px-4 py-2.5">
            {b && (
              <Link href={`/bookings/${b.id}`} className={MINI}>
                Открыть бронь {b.no} →
              </Link>
            )}
            <span className="ml-auto" />
            <Link href={`/repair/${created.id}`} className={MINI}>
              Открыть карточку →
            </Link>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center gap-1.5 rounded border border-accent-bright bg-accent-bright px-3 py-1 text-xs font-semibold text-surface hover:border-accent hover:bg-accent"
            >
              Понятно
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Форма ──────────────────────────────────────────────────────────────────

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-scrim/40 px-4 py-6"
      onClick={() => !saving && onClose()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Завести поломку"
        className="w-full max-w-[660px] overflow-hidden rounded-lg border border-border-strong bg-surface shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <RepairIcon name="wrench" large className="text-accent-bright" />
          <h3 className="font-cond text-[15px] font-bold">Завести поломку</h3>
          <span className="hidden text-[11.5px] text-ink-3 sm:inline">
            нашли сломанный прибор вне приёмки
          </span>
          <button
            type="button"
            aria-label="Закрыть"
            onClick={onClose}
            className="ml-auto text-ink-3 hover:text-ink"
          >
            <RepairIcon name="x" large />
          </button>
        </div>

        {/* ШАГ 1 · какой прибор */}
        <Step n="1" title="Что сломалось" done={picked !== null}>
          {picked ? (
            <div className="flex flex-wrap items-center gap-2 rounded border border-accent-border bg-accent-soft px-2.5 py-1.5 text-[12.5px]">
              <RepairIcon name="box" large className="text-accent" />
              <span className="font-cond text-[15px] font-bold">{picked.name}</span>
              <span className="text-[11.5px] text-ink-2">
                {picked.category} · {isUnitMode ? "штучный учёт" : "без штучного учёта"} ·{" "}
                {parkTotal} в парке
              </span>
              <button
                type="button"
                className={`${MINI} ml-auto`}
                onClick={() => {
                  setPicked(null);
                  setUnitId(null);
                  setQuery("");
                  setDuplicateRepairId(null);
                  searchRef.current?.focus();
                }}
              >
                Выбрать другой
              </button>
            </div>
          ) : (
            <>
              <div className="relative">
                <RepairIcon name="search" className="absolute left-2 top-[9px] text-ink-3" />
                <input
                  ref={searchRef}
                  autoFocus
                  className={`${FIELD} pl-[26px]`}
                  placeholder="Название прибора — например, «скайпанель» или «600d»"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Поиск прибора"
                />
              </div>
              {results.length > 0 && (
                <div className="rounded-b border border-t-0 border-border bg-surface">
                  {results.map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => {
                        setPicked(e);
                        setQuantity(1);
                        setUnitId(null);
                      }}
                      className="flex w-full items-center gap-2 border-b border-border px-2.5 py-1.5 text-left text-[12.5px] last:border-b-0 hover:bg-accent-soft"
                    >
                      <span className="min-w-0 truncate font-semibold">{e.name}</span>
                      <span className="ml-auto whitespace-nowrap text-[11px] text-ink-3">
                        {e.category} · {e.totalQuantity} в парке
                      </span>
                    </button>
                  ))}
                </div>
              )}
              {searching && query.trim().length >= 2 && results.length === 0 && (
                <p className="mt-1.5 text-[11.5px] text-ink-3">Ищем…</p>
              )}
              <p className="mt-1.5 text-[11.5px] leading-[1.45] text-ink-3">
                Поиск по названию, как в доборе на складе.{" "}
                <b className="font-semibold text-ink-2">Штрихкод вводить не нужно</b> — прибор
                ищется словами, которыми его называют в смене.
              </p>
            </>
          )}
        </Step>

        {/* ШАГ 2 · единица либо количество */}
        <Step
          n="2"
          title={isUnitMode ? "Какая именно единица" : "Сколько штук вышло из строя"}
          done={picked !== null && (!isUnitMode || unitId !== null)}
        >
          {!picked && (
            <p className="text-[11.5px] text-ink-3">Сначала выберите прибор на шаге 1.</p>
          )}

          {picked && isUnitMode && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {units.map((u, i) => {
                  const blocked = UNIT_BLOCKED[u.status];
                  const busy = u.status === "ISSUED";
                  const selected = unitId === u.id;
                  // «ед. N» по порядку, а не серийник и тем более не штрихкод:
                  // в смене экземпляры называют номером, а не инвентарным кодом.
                  const label = `ед. ${i + 1}`;
                  return (
                    <button
                      key={u.id}
                      type="button"
                      disabled={Boolean(blocked)}
                      onClick={() => setUnitId(u.id)}
                      className={`rounded border px-2.5 py-0.5 text-[11.5px] font-semibold leading-[1.6] ${
                        selected
                          ? "border-accent bg-accent text-surface"
                          : busy
                            ? "border-amber-border bg-amber-soft text-amber"
                            : "border-border bg-surface text-ink-2"
                      } ${blocked ? "cursor-not-allowed opacity-55" : ""}`}
                    >
                      {label}
                      {busy && " · на съёмке"}
                      {blocked && ` · ${blocked}`}
                    </button>
                  );
                })}
                {units.length === 0 && (
                  <p className="text-[11.5px] text-ink-3">
                    У позиции нет заведённых единиц — заводите поломку на позицию целиком.
                  </p>
                )}
              </div>
              <p className="mt-1.5 text-[11.5px] leading-[1.45] text-ink-3">
                Единицы, которые уже в ремонте или списаны, выбрать нельзя: второй карточки на них
                не будет.
              </p>
            </>
          )}

          {picked && !isUnitMode && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-[11.5px] text-ink-2">Сколько штук вышло из строя:</span>
                <input
                  type="number"
                  min={1}
                  max={Math.max(1, parkTotal)}
                  value={quantity}
                  aria-label="Количество"
                  onChange={(e) => setQuantity(Math.max(1, Number(e.target.value) || 1))}
                  className="mono-num w-14 rounded border border-border bg-surface py-1 text-center text-[15px] font-semibold"
                />
                <span className="text-[11.5px] text-ink-3">из {parkTotal} в парке</span>
              </div>
              <p className="mt-1.5 text-[11.5px] leading-[1.45] text-ink-3">
                У позиций <b className="font-semibold text-ink-2">без штучного учёта</b> (кабели,
                зарядки, стойки) единиц нет — вместо них количество.
              </p>
            </>
          )}

          {duplicateRepairId && (
            <div className="mt-2 flex flex-wrap items-start gap-2 rounded border border-amber-border bg-amber-soft px-2.5 py-2 text-xs leading-[1.45] text-amber">
              <RepairIcon name="hist" className="mt-0.5" />
              <span>Эта единица уже в ремонте. Второй карточки на неё не будет.</span>
              <Link
                href={`/repair/${duplicateRepairId}`}
                className="ml-auto whitespace-nowrap font-semibold text-amber underline"
              >
                Открыть ту карточку →
              </Link>
            </div>
          )}
        </Step>

        {/* ШАГ 3 · что случилось */}
        <Step n="3" title="Что случилось" done={reason.trim().length > 0}>
          <div className="mb-1.5 flex flex-wrap gap-1.5">
            {REASON_PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setReason(p)}
                className={`${CHIP} ${reason === p ? CHIP_ON : CHIP_OFF}`}
              >
                {p}
              </button>
            ))}
          </div>
          <input
            className={FIELD}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Разбит рассеиватель, треснуло крепление ярма — заметили при перекладке"
            aria-label="Что случилось"
          />
          <label className="mt-2 flex cursor-pointer flex-wrap items-center gap-2 rounded border border-dashed border-border-strong bg-surface-muted px-2.5 py-2 text-xs text-ink-2">
            <RepairIcon name="cam" />
            <span>
              Снять или приложить фото{" "}
              <span className="text-ink-3">— необязательно, но техник скажет спасибо</span>
            </span>
            <input
              type="file"
              accept="image/jpeg,image/png"
              multiple
              className="hidden"
              onChange={(e) => setPhotos(Array.from(e.target.files ?? []))}
            />
            {photos.length > 0 && (
              <span className="ml-auto rounded border border-border bg-surface px-[7px] py-px text-[11px] font-semibold text-ink-3">
                {photos.length} {photos.length === 1 ? "снимок" : "снимка"}
              </span>
            )}
          </label>
        </Step>

        {/* ШАГ 4 · срок */}
        <Step n="4" title="Когда вернётся" hint="если знаете">
          <div className="flex flex-wrap gap-1.5">
            {ETA_PRESETS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setEtaDays(p.days)}
                className={`${CHIP} ${etaDays === p.days ? CHIP_ON : CHIP_OFF}`}
              >
                {p.label}
              </button>
            ))}
          </div>
          <p className="mt-1.5 text-[11.5px] leading-[1.45] text-ink-3">
            «Не знаю» — нормальный ответ. В очереди так и напишем:{" "}
            <b className="font-semibold text-ink-2">срок не назначен</b>. Выдуманный прогноз хуже
            честного пробела — по нему начнут планировать съёмку.
          </p>
        </Step>

        {/* ПОСЛЕДСТВИЯ */}
        <Step n="!" title="Что произойдёт после «Вывести из работы»">
          <p className="flex items-start gap-2 rounded border border-teal-border bg-teal-soft px-2.5 py-2 text-xs leading-[1.45] text-teal">
            <RepairIcon name="check" className="mt-0.5" />
            <span>
              <b className="font-bold">Перестанет числиться свободным:</b>{" "}
              {picked === null
                ? "позиция уйдёт из наличия."
                : freeNow !== null
                  ? `было ${parkTotal} в парке / ${freeNow} свободных → станет ${willBeFree} свободных.`
                  : `${quantity} шт из ${parkTotal} в парке уйдут из наличия.`}{" "}
              Календарь, проверка доступности и добор на складе начнут считать одинаково.
            </span>
          </p>
          <p className="mt-2 rounded border border-dashed border-border-strong bg-surface-muted px-2.5 py-2 text-[11.5px] leading-[1.45] text-ink-2">
            Если на эти даты уже есть бронь — заводить всё равно можно: прибор сломан по факту, а
            не по учёту. Сразу после сохранения покажем, какая бронь под угрозой и кому звонить.
          </p>
        </Step>

        {error && (
          <p className="border-t border-border bg-rose-soft px-4 py-2 text-xs text-rose">{error}</p>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-muted px-4 py-2.5">
          <p className="hidden max-w-[330px] text-[11px] leading-[1.4] text-ink-3 md:block">
            Заводить поломку могут кладовщик, техник и руководитель. Карточка появится в очереди
            сразу, в статусе «Ждёт ремонта».
          </p>
          <span className="ml-auto" />
          <button type="button" onClick={onClose} disabled={saving} className={MINI}>
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className="inline-flex items-center gap-1.5 rounded border border-accent-bright bg-accent-bright px-3 py-1 text-xs font-semibold text-surface transition-colors hover:border-accent hover:bg-accent disabled:opacity-50"
          >
            <RepairIcon name="wrench" />
            {saving ? "Сохраняем…" : "Вывести из работы"}
          </button>
        </div>
      </div>
    </div>
  );
}
