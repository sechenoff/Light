"use client";

/**
 * Регистрация поломки прямо из киоска (без возврата).
 *
 * Флоу kladovshchika:
 *  1. Поиск оборудования по названию (кириллица, живой поиск от 2 символов).
 *  2. UNIT-оборудование → выбор конкретной единицы (серийник/инвентарник,
 *     единицы в активном ремонте задизейблены); COUNT → степпер количества.
 *  3. Причина (textarea, min 3) + срочность (3 пилюли).
 *  4. Фото с нативной камеры (опционально, до 5 шт) — как в RepairPanel.
 *  5. «Зарегистрировать» → POST /api/warehouse/repairs → фото по одному →
 *     success-экран → onDone() (родитель возвращает список Поломок и
 *     перезагружает его).
 *
 * Touch-таргеты ≥44px; без barcode.
 */

import { useEffect, useRef, useState } from "react";
import {
  scanApi,
  type RepairTarget,
  type RepairTargetUnit,
} from "./api";
import { isScanApiError } from "./types";
import { IconCheck, IconSearch, IconWrench } from "./workstationIcons";

type Urgency = "NOT_URGENT" | "NORMAL" | "URGENT";

const URGENCY_OPTIONS: Array<{ value: Urgency; label: string }> = [
  { value: "NOT_URGENT", label: "Не срочно" },
  { value: "NORMAL", label: "Обычная" },
  { value: "URGENT", label: "Срочно" },
];

const MAX_PHOTOS = 5;

interface PhotoDraft {
  file: File;
  previewUrl: string;
}

export function RegisterBreakageScreen({ onDone }: { onDone: () => void }) {
  // ── Поиск ──────────────────────────────────────────────────────────────────
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<RepairTarget[] | null>(null);
  const [searching, setSearching] = useState(false);

  // ── Выбор цели ─────────────────────────────────────────────────────────────
  const [target, setTarget] = useState<RepairTarget | null>(null);
  const [unit, setUnit] = useState<RepairTargetUnit | null>(null);
  const [quantity, setQuantity] = useState(1);

  // ── Детали ─────────────────────────────────────────────────────────────────
  const [reason, setReason] = useState("");
  const [urgency, setUrgency] = useState<Urgency>("NORMAL");
  const [photos, setPhotos] = useState<PhotoDraft[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Отправка ───────────────────────────────────────────────────────────────
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [donePhotoWarn, setDonePhotoWarn] = useState(0);
  const [success, setSuccess] = useState(false);

  // Живой поиск с debounce 300 мс.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      scanApi
        .searchRepairTargets(q)
        .then((r) => {
          if (!cancelled) setResults(r);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Blob-URL cleanup при размонтировании.
  useEffect(() => {
    return () => {
      photos.forEach((p) => URL.revokeObjectURL(p.previewUrl));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pickTarget(t: RepairTarget) {
    setTarget(t);
    setUnit(null);
    setQuantity(1);
    setResults(null);
    setQuery("");
  }

  function resetTarget() {
    setTarget(null);
    setUnit(null);
  }

  function addPhotos(list: FileList | null) {
    if (!list) return;
    const next: PhotoDraft[] = [];
    for (const file of Array.from(list)) {
      if (photos.length + next.length >= MAX_PHOTOS) break;
      next.push({ file, previewUrl: URL.createObjectURL(file) });
    }
    if (next.length > 0) setPhotos((prev) => [...prev, ...next]);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removePhoto(idx: number) {
    setPhotos((prev) => {
      const victim = prev[idx];
      if (victim) URL.revokeObjectURL(victim.previewUrl);
      return prev.filter((_, i) => i !== idx);
    });
  }

  const targetChosen =
    target != null && (target.trackingMode === "COUNT" || unit != null);
  const canSubmit = targetChosen && reason.trim().length >= 3 && !submitting;

  async function submit() {
    if (!target || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const { repair } = await scanApi.createKioskRepair({
        ...(target.trackingMode === "UNIT"
          ? { equipmentUnitId: unit!.id }
          : { equipmentId: target.equipmentId, quantity }),
        reason: reason.trim(),
        urgency,
      });
      // Фото — по одному, сбой одного не отменяет заявку.
      let failed = 0;
      for (const p of photos) {
        try {
          await scanApi.uploadKioskRepairPhoto(repair.id, p.file);
        } catch {
          failed += 1;
        }
      }
      setDonePhotoWarn(failed);
      setSuccess(true);
    } catch (err: unknown) {
      setSubmitError(
        isScanApiError(err) ? err.message : "Не удалось зарегистрировать поломку",
      );
    } finally {
      setSubmitting(false);
    }
  }

  // ── Success ────────────────────────────────────────────────────────────────
  if (success && target) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-soft">
          <IconCheck className="h-7 w-7 text-emerald" strokeWidth={2.4} />
        </span>
        <p className="text-[16px] font-semibold text-ink">Поломка зарегистрирована</p>
        <p className="text-sm text-ink-2">
          {target.name}
          {target.trackingMode === "UNIT" && unit ? ` · ${unit.label}` : ` · ${quantity} шт`}
          {" — заявка ушла в мастерскую."}
        </p>
        {donePhotoWarn > 0 && (
          <p className="text-xs text-amber">
            {donePhotoWarn} фото не загрузилось — можно добавить позже в мастерской.
          </p>
        )}
        <button
          type="button"
          onClick={onDone}
          className="mt-2 min-h-[44px] rounded-lg bg-accent-bright px-6 py-2.5 text-sm font-semibold text-surface hover:opacity-95"
        >
          Готово
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-3 px-3 py-3 lg:max-w-[560px] lg:px-5 lg:py-4">
      {/* Шаг 1: цель */}
      {target == null ? (
        <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
          <div className="border-b border-border bg-surface-muted px-3.5 py-2.5">
            <h3 className="text-[12.5px] font-semibold">Что сломалось?</h3>
          </div>
          <div className="p-3.5">
            <div className="relative">
              <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-3" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Название оборудования…"
                autoFocus
                className="min-h-[44px] w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-[14px] focus:border-accent-bright focus:outline-none"
                aria-label="Поиск оборудования"
              />
            </div>
            {searching && (
              <p className="mt-2 text-[12px] text-ink-3">Ищем…</p>
            )}
            {results != null && !searching && (
              <div className="mt-2 overflow-hidden rounded-lg border border-border">
                {results.length === 0 ? (
                  <p className="px-3 py-4 text-center text-sm text-ink-3">
                    Ничего не нашли — попробуйте иначе.
                  </p>
                ) : (
                  results.map((r) => (
                    <button
                      key={r.equipmentId}
                      type="button"
                      onClick={() => pickTarget(r)}
                      className="flex min-h-[48px] w-full items-center gap-2.5 border-b border-surface-subtle px-3 py-2 text-left transition-colors last:border-b-0 hover:bg-surface-muted"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{r.name}</span>
                        <span className="block text-[11px] text-ink-3">
                          {r.category} ·{" "}
                          {r.trackingMode === "UNIT"
                            ? `${r.units.length} ед. с учётом`
                            : `${r.totalQuantity} шт на складе`}
                        </span>
                      </span>
                      <span className="text-ink-3">→</span>
                    </button>
                  ))
                )}
              </div>
            )}
            {results == null && !searching && (
              <p className="mt-2 text-[11.5px] text-ink-3">
                Введите минимум 2 символа — например, «aputure» или «штатив».
              </p>
            )}
          </div>
        </section>
      ) : (
        <section className="overflow-hidden rounded-lg border border-accent-border bg-surface shadow-xs">
          <div className="flex items-center justify-between gap-2 border-b border-accent-border bg-accent-soft px-3.5 py-2.5">
            <h3 className="min-w-0 truncate text-[12.5px] font-semibold text-accent-bright">
              {target.name}
            </h3>
            <button
              type="button"
              onClick={resetTarget}
              className="shrink-0 text-[11.5px] font-semibold text-accent-bright underline"
            >
              Изменить
            </button>
          </div>
          <div className="p-3.5">
            {target.trackingMode === "UNIT" ? (
              <>
                <p className="eyebrow mb-2">Какая единица?</p>
                <div className="flex flex-wrap gap-1.5">
                  {target.units.map((u) => {
                    const on = unit?.id === u.id;
                    const disabled = u.inActiveRepair;
                    return (
                      <button
                        key={u.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => setUnit(u)}
                        className={`min-h-[40px] rounded-lg border px-3.5 py-2 text-[12.5px] font-semibold transition-colors ${
                          disabled
                            ? "cursor-not-allowed border-border bg-surface-muted text-ink-3 opacity-60"
                            : on
                              ? "border-accent-bright bg-accent-bright text-surface"
                              : "border-border bg-surface text-ink hover:bg-surface-muted"
                        }`}
                        aria-pressed={on}
                      >
                        {u.label}
                        {disabled ? " · уже в ремонте" : ""}
                      </button>
                    );
                  })}
                </div>
                {target.units.length === 0 && (
                  <p className="text-sm text-ink-3">
                    У этой позиции нет единиц с поштучным учётом.
                  </p>
                )}
              </>
            ) : (
              <>
                <p className="eyebrow mb-2">Сколько штук сломано?</p>
                <div className="inline-flex items-center overflow-hidden rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => setQuantity((n) => Math.max(1, n - 1))}
                    className="flex h-[44px] w-[44px] items-center justify-center text-lg text-ink-2 hover:bg-surface-muted"
                    aria-label="Меньше"
                  >
                    −
                  </button>
                  <span className="mono-num flex h-[44px] w-[56px] items-center justify-center border-x border-border text-[15px] font-semibold">
                    {quantity}
                  </span>
                  <button
                    type="button"
                    onClick={() => setQuantity((n) => Math.min(999, n + 1))}
                    className="flex h-[44px] w-[44px] items-center justify-center text-lg text-ink-2 hover:bg-surface-muted"
                    aria-label="Больше"
                  >
                    +
                  </button>
                </div>
              </>
            )}
          </div>
        </section>
      )}

      {/* Шаг 2: детали (появляется после выбора цели) */}
      {targetChosen && (
        <>
          <section className="overflow-hidden rounded-lg border border-border bg-surface shadow-xs">
            <div className="border-b border-border bg-surface-muted px-3.5 py-2.5">
              <h3 className="text-[12.5px] font-semibold">Что случилось?</h3>
            </div>
            <div className="space-y-3 p-3.5">
              <label className="block">
                <span className="eyebrow mb-1.5 block">Причина</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={3}
                  placeholder="Например: не включается драйвер, мигает при 20%…"
                  className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-[14px] focus:border-accent-bright focus:outline-none"
                  aria-label="Причина поломки"
                />
                {reason.trim().length > 0 && reason.trim().length < 3 && (
                  <span className="mt-1 block text-[11px] text-rose">
                    Минимум 3 символа.
                  </span>
                )}
              </label>
              <div>
                <span className="eyebrow mb-1.5 block">Срочность</span>
                <div className="flex gap-1.5" role="radiogroup" aria-label="Срочность">
                  {URGENCY_OPTIONS.map((o) => {
                    const on = urgency === o.value;
                    return (
                      <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => setUrgency(o.value)}
                        className={`min-h-[40px] flex-1 rounded-lg border px-2 py-2 text-[12.5px] font-semibold transition-colors ${
                          on
                            ? o.value === "URGENT"
                              ? "border-rose bg-rose text-surface"
                              : "border-ink bg-ink text-white"
                            : "border-border bg-surface text-ink-2 hover:bg-surface-muted"
                        }`}
                      >
                        {o.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <span className="eyebrow mb-1.5 block">
                  Фото · {photos.length}/{MAX_PHOTOS}
                </span>
                <div className="flex flex-wrap gap-2">
                  {photos.map((p, i) => (
                    <span key={p.previewUrl} className="relative">
                      {/* eslint-disable-next-line @next/next/no-img-element -- blob-превью с камеры, next/image не применим */}
                      <img
                        src={p.previewUrl}
                        alt={`Фото ${i + 1}`}
                        className="h-[64px] w-[64px] rounded-lg border border-border object-cover"
                      />
                      <button
                        type="button"
                        onClick={() => removePhoto(i)}
                        aria-label={`Удалить фото ${i + 1}`}
                        className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full border border-border bg-surface text-[13px] leading-none text-ink-2 shadow-sm"
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  {photos.length < MAX_PHOTOS && (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="flex h-[64px] w-[64px] items-center justify-center rounded-lg border-[1.5px] border-dashed border-border-strong text-2xl text-ink-3 hover:bg-surface-muted"
                      aria-label="Добавить фото"
                    >
                      +
                    </button>
                  )}
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/jpeg,image/png"
                  capture="environment"
                  multiple
                  hidden
                  onChange={(e) => addPhotos(e.target.files)}
                />
              </div>
            </div>
          </section>

          {submitError && (
            <p role="alert" className="rounded-lg border border-rose-border bg-rose-soft px-3.5 py-2.5 text-sm text-rose">
              {submitError}
            </p>
          )}

          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="flex min-h-[52px] items-center justify-center gap-2 rounded-lg bg-amber px-4 py-3 text-[14px] font-semibold text-surface transition-opacity hover:opacity-95 disabled:opacity-50"
          >
            <IconWrench className="h-[18px] w-[18px]" strokeWidth={2.1} />
            {submitting ? "Регистрируем…" : "Зарегистрировать поломку"}
          </button>
        </>
      )}
    </div>
  );
}
