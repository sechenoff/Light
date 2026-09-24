"use client";

/**
 * Части модалки «Завести потеряшку» (AddProblemItemModal): подписи, стили,
 * хелперы следа, презентационные шаги и загрузка наличия/единиц позиции.
 * Вынесены, чтобы модалка осталась про состояние формы и отправку.
 */

import { useEffect, useState } from "react";

import { apiFetch } from "../../lib/api";
import { toMoscowDateString } from "../../lib/moscowDate";
import type { EquipmentTrail, TrailBooking } from "../inventory/types";
import type { EquipmentSearchItem, EquipmentUnitItem } from "../repair/types";
import type { ProblemItemReason } from "./types";

// ── Подписи ───────────────────────────────────────────────────────────────────

export const REASON_CHIPS: ReadonlyArray<{ value: ProblemItemReason; label: string }> = [
  { value: "NOT_ON_SHELF", label: "Не нашли на складе" },
  { value: "LEFT_ON_SITE", label: "Остался на площадке" },
  { value: "LOST", label: "Потерян" },
  { value: "STOLEN", label: "Украден" },
  { value: "DESTROYED", label: "Уничтожен" },
];

/** Что станет с карточкой — зеркало plannedStatus в problemItemService. */
export const REASON_OUTCOME: Record<ProblemItemReason, string> = {
  NOT_ON_SHELF: "карточка встанет «На поиске»",
  LOST: "карточка встанет «На поиске»",
  STOLEN: "карточка встанет «На поиске»",
  LEFT_ON_SITE: "карточка встанет «Ожидается» — ждём, когда привезут",
  DESTROYED: "карточка сразу закроется как «Списано»",
};

/** Единицы, на которые вторую карточку не заводим — их и не показываем. */
const UNIT_HIDDEN: ReadonlySet<EquipmentUnitItem["status"]> = new Set(["MISSING", "RETIRED"]);
/**
 * Единицы не на складе: видны, но не выбираются. Пропажу со съёмки отметит
 * приёмка, судьбу единицы из мастерской решает ремонт — сервер ответит
 * UNIT_ISSUED / UNIT_IN_REPAIR (problemItemService.createManualUnitProblem).
 */
const UNIT_BLOCKED_NOTE: Partial<Record<EquipmentUnitItem["status"], string>> = {
  ISSUED: "на съёмке — отметят на приёмке",
  MAINTENANCE: "в мастерской — списание через ремонт",
};

const MONTHS_SHORT = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** Сколько броней следа показываем в радио-списке. */
const TRAIL_ROWS = 5;
export const COMMENT_MIN = 3;
export const NO_BOOKING = "none";

// ── Стили (канон AddRepairModal; на телефоне — крупнее, под палец) ─────────────

export const CHIP =
  "rounded-xl border px-3 py-1.5 text-[12px] sm:px-2.5 sm:py-px sm:text-[11px] font-semibold leading-[1.6] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright";
export const CHIP_OFF =
  "border-border bg-surface text-ink-2 hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright";
export const FIELD =
  "w-full rounded border border-border bg-surface px-2 py-1.5 text-[12.5px] text-ink placeholder:text-ink-3 focus:border-accent-bright focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright/30";
export const MINI =
  "inline-flex items-center justify-center gap-1 rounded border border-border bg-surface min-h-10 px-4 py-0.5 text-[11px] sm:min-h-0 sm:px-2 font-semibold leading-[1.55] text-ink-2 transition-colors hover:border-accent-border hover:bg-accent-soft hover:text-accent-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright disabled:opacity-50";
const CHIP_BLOCKED = "cursor-not-allowed border-dashed border-border bg-surface-muted text-ink-3";
const STEP_BTN =
  "flex h-8 w-8 items-center justify-center bg-surface-subtle text-[15px] text-ink-2 transition-colors hover:bg-accent-soft hover:text-accent-bright focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-bright disabled:cursor-not-allowed disabled:opacity-40";

// ── Хелперы ───────────────────────────────────────────────────────────────────

function dayMonth(iso: string): { d: number; m: number } {
  const [, m, d] = toMoscowDateString(new Date(iso)).split("-").map(Number);
  return { d, m: m - 1 };
}

/** «9–11 сен», «30 авг – 1 сен», «9 сен». Московская дата. */
export function formatTrailDates(startIso: string, endIso: string): string {
  const s = dayMonth(startIso);
  const e = dayMonth(endIso);
  if (s.m === e.m && s.d === e.d) return `${s.d} ${MONTHS_SHORT[s.m]}`;
  if (s.m === e.m) return `${s.d}–${e.d} ${MONTHS_SHORT[e.m]}`;
  return `${s.d} ${MONTHS_SHORT[s.m]} – ${e.d} ${MONTHS_SHORT[e.m]}`;
}

/** Как бронь вернулась на склад — человеческими словами. */
export function trailRowNote(b: TrailBooking): string {
  const issued = `выдано ${b.quantity}`;
  if (b.returnMode === "OUT") return `${issued} · ещё на съёмке`;
  if (b.returnMode === "AUTO") return `${issued} · возврат отмечен автоматически`;
  if (b.returnMode === "KIOSK") {
    const remarks = (b.remarks?.problemQty ?? 0) + (b.remarks?.repairQty ?? 0);
    const who = b.returnedBy ? `принимал ${b.returnedBy}` : "принято в киоске";
    return `${issued} · ${who}${remarks > 0 ? ` · замечаний при приёмке: ${remarks}` : ""}`;
  }
  if (b.status === "CONFIRMED") return `${issued} · срок вышел, возврат не отмечен`;
  return b.returnedBy ? `${issued} · отмечен вручную (${b.returnedBy})` : `${issued} · отмечен вручную`;
}

/**
 * Бронь, к которой можно привязать ручную потеряшку, — вернувшаяся на склад.
 * Бронь на съёмке (OUT) уже вычтена из полки, а её приёмка сама спросит про
 * недостающее: сервер такую привязку отклонит (BOOKING_STILL_OUT).
 */
export function isPickableBooking(trail: EquipmentTrail, bookingId: string): boolean {
  return trail.bookings.some((b) => b.bookingId === bookingId && b.returnMode !== "OUT");
}

/** Первые вернувшиеся брони следа; подсказку сервера показываем, даже если она глубже. */
function visibleTrailBookings(trail: EquipmentTrail): TrailBooking[] {
  const returned = trail.bookings.filter((b) => b.returnMode !== "OUT");
  const head = returned.slice(0, TRAIL_ROWS);
  const suggested = trail.suggestedBookingId;
  if (!suggested || head.some((b) => b.bookingId === suggested)) return head;
  const extra = returned.find((b) => b.bookingId === suggested);
  return extra ? [...head.slice(0, TRAIL_ROWS - 1), extra] : head;
}

/** Сырой `YYYY-MM-DD` из `<input type="date">` → ISO, как у приёмки в киоске. */
export function bareDateToIso(d: string): string {
  return new Date(`${d}T00:00:00.000Z`).toISOString();
}

export function errorCode(e: unknown): string | undefined {
  if (typeof e !== "object" || e === null) return undefined;
  const { code, details } = e as { code?: unknown; details?: unknown };
  if (typeof code === "string") return code;
  return typeof details === "string" ? details : undefined;
}

export function errorDetails(e: unknown): Record<string, unknown> {
  const details = (e as { details?: unknown } | null)?.details;
  return typeof details === "object" && details !== null ? (details as Record<string, unknown>) : {};
}

export function errorMessage(e: unknown, fallback: string): string {
  return e instanceof Error && e.message ? e.message : fallback;
}

// ── Каркас шага ───────────────────────────────────────────────────────────────

export function Step({
  n,
  title,
  done,
  children,
}: {
  n: string;
  title: string;
  done?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="grid grid-cols-[22px_minmax(0,1fr)] gap-2.5 border-b border-border px-4 py-3">
      <span
        aria-hidden="true"
        className={`mt-px flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[11px] font-semibold leading-none ${
          done ? "border-accent bg-accent text-surface" : "border-border text-ink-3"
        }`}
      >
        {n}
      </span>
      <div className="min-w-0">
        <h4 className="mb-1.5 text-[12.5px] font-semibold text-ink">{title}</h4>
        {children}
      </div>
    </section>
  );
}

// ── Шаг 1 · поиск позиции ─────────────────────────────────────────────────────

export function PositionSearch({
  inputRef,
  onPick,
}: {
  inputRef: React.RefObject<HTMLInputElement>;
  onPick: (e: EquipmentSearchItem) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EquipmentSearchItem[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "done" | "error">("idle");

  // Поиск словами, как в доборе на складе: штрихкод вводить не нужно.
  useEffect(() => {
    const needle = query.trim();
    if (needle.length < 2) {
      setResults([]);
      setState("idle");
      return;
    }
    let cancelled = false;
    setState("loading");
    const timer = setTimeout(() => {
      apiFetch<{ equipments: EquipmentSearchItem[] }>(`/api/equipment?search=${encodeURIComponent(needle)}`)
        .then((d) => {
          if (cancelled) return;
          setResults(d.equipments.slice(0, 8));
          setState("done");
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setState("error");
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  return (
    <>
      <div className="relative">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          className="pointer-events-none absolute left-2 top-[9px] h-3.5 w-3.5 fill-none stroke-current stroke-2 text-ink-3"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
        <input
          ref={inputRef}
          className={`${FIELD} pl-[26px]`}
          placeholder="Название позиции — например, «зарядки» или «удлинитель»"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Поиск позиции"
        />
      </div>
      {results.length > 0 && (
        <ul className="rounded-b border border-t-0 border-border bg-surface" aria-label="Найденные позиции">
          {results.map((e) => (
            <li key={e.id} className="border-b border-border last:border-b-0">
              <button
                type="button"
                onClick={() => onPick(e)}
                className="flex w-full items-center gap-2 px-2.5 py-2.5 sm:py-1.5 text-left text-[12.5px] hover:bg-accent-soft focus-visible:bg-accent-soft focus-visible:outline-none"
              >
                {/* Название не сжимается, пока помещается в строку; ужимается и
                    обрезается второстепенная категория */}
                <span className="max-w-full shrink-0 truncate font-semibold text-ink">{e.name}</span>
                <span className="ml-auto min-w-0 max-w-[45%] truncate text-right text-[11px] text-ink-3">
                  {e.category}
                  {e.stockTrackingMode === "UNIT" ? " · штучный учёт" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {state === "loading" && <p className="mt-1.5 text-[11.5px] text-ink-3">Ищем…</p>}
      {state === "done" && results.length === 0 && (
        <p className="mt-1.5 text-[11.5px] text-ink-3">Ничего не нашли — попробуйте другое слово.</p>
      )}
      {state === "error" && (
        <p className="mt-1.5 text-[11.5px] text-rose">Поиск не отвечает — попробуйте ещё раз.</p>
      )}
    </>
  );
}

// ── Шаг 1 · наличие и количество ──────────────────────────────────────────────

export function StockTiles({ trail }: { trail: EquipmentTrail }) {
  const s = trail.onShelf;
  const tiles = [
    { v: s.total, l: "всего по учёту", tone: "text-ink" },
    { v: s.issued + s.calendar, l: "сейчас на съёмке", tone: "text-ink" },
    { v: s.repair, l: "в мастерской", tone: "text-ink" },
    { v: s.expected, l: "должно быть на полке", tone: "text-rose" },
  ];
  return (
    <>
      <dl className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.l} className="flex flex-col-reverse rounded border border-border bg-surface px-2 py-1">
            <dt className="text-[10.5px] leading-[1.3] text-ink-3">{t.l}</dt>
            <dd className={`font-mono text-[15px] font-semibold leading-[1.2] ${t.tone}`}>{t.v}</dd>
          </div>
        ))}
      </dl>
      {s.lost > 0 && (
        <p className="mt-1 text-[11px] text-ink-3">ещё {s.lost} — уже в потеряшках, их повторно не считаем</p>
      )}
    </>
  );
}

export function QuantityStepper({
  value,
  max,
  onChange,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
}) {
  if (max < 1) {
    return (
      <p className="mt-2 rounded border border-rose-border bg-rose-soft px-2.5 py-1.5 text-[11.5px] text-rose">
        По учёту на полке этой позиции сейчас нет — заводить пропажу не из чего.
      </p>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[11.5px] text-ink-2">Не хватает:</span>
      <span className="inline-flex items-center overflow-hidden rounded border border-border bg-surface">
        <button
          type="button"
          aria-label="Меньше"
          className={STEP_BTN}
          disabled={value <= 1}
          onClick={() => onChange(value - 1)}
        >
          −
        </button>
        <span aria-live="polite" aria-label="Количество" className="px-3 font-mono text-[14px] font-semibold text-ink">
          {value}
        </span>
        <button
          type="button"
          aria-label="Больше"
          className={STEP_BTN}
          disabled={value >= max}
          onClick={() => onChange(value + 1)}
        >
          +
        </button>
      </span>
      <span className="text-[11.5px] text-ink-3">
        из {max} на полке · больше, чем должно лежать, завести нельзя
      </span>
    </div>
  );
}

export function UnitPicker({
  units,
  state,
  showRetry,
  onRetry,
  value,
  onChange,
}: {
  /** null — ещё не загружены. */
  units: EquipmentUnitItem[] | null;
  state: TrailState;
  /** Своя «Повторить»; не нужна, если рядом уже есть кнопка для того же перезапроса. */
  showRetry: boolean;
  onRetry: () => void;
  value: string | null;
  onChange: (id: string) => void;
}) {
  if (state === "error") {
    return (
      <p className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-rose">
        Не удалось загрузить единицы.
        {showRetry && (
          <button type="button" className={MINI} onClick={onRetry}>
            Повторить
          </button>
        )}
      </p>
    );
  }
  if (state === "loading" || units === null) {
    return <p className="mt-2 text-[11.5px] text-ink-3">Загружаем единицы…</p>;
  }
  if (units.length === 0) {
    return (
      <p className="mt-2 text-[11.5px] text-ink-3">
        У позиции не заведено ни одной единицы — сначала заведите их в карточке позиции.
      </p>
    );
  }
  // «ед. N» — по порядку заведения среди ВСЕХ единиц, чтобы номер не прыгал.
  const numbered = units.map((u, i) => ({ unit: u, n: i + 1 }));
  const listed = numbered.filter(({ unit }) => !UNIT_HIDDEN.has(unit.status));
  if (listed.length === 0) {
    return (
      <p className="mt-2 text-[11.5px] text-ink-3">
        Все единицы уже числятся пропавшими или списанными — заводить нечего.
      </p>
    );
  }
  const hasChoice = listed.some(({ unit }) => !UNIT_BLOCKED_NOTE[unit.status]);
  return (
    <div className="mt-2">
      <p className="mb-1 text-[11.5px] text-ink-2">Какая именно единица:</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Единица">
        {listed.map(({ unit, n }) => {
          const selected = value === unit.id;
          const blocked = UNIT_BLOCKED_NOTE[unit.status];
          const tone = blocked ? CHIP_BLOCKED : selected ? "border-accent bg-accent text-surface" : CHIP_OFF;
          return (
            <button
              key={unit.id}
              type="button"
              aria-pressed={selected}
              disabled={Boolean(blocked)}
              onClick={() => onChange(unit.id)}
              className={`${CHIP} ${tone}`}
            >
              {unit.serialNumber ? `№ ${unit.serialNumber}` : `ед. ${n}`}
              {blocked ? ` · ${blocked}` : ""}
            </button>
          );
        })}
      </div>
      {!hasChoice && (
        <p className="mt-1.5 text-[11px] text-ink-3">
          Свободных на складе единиц нет: пропажу со съёмки отметят на приёмке, единицу из мастерской
          списывают через ремонт.
        </p>
      )}
    </div>
  );
}

// ── Шаг 2 · где видели в последний раз ────────────────────────────────────────

export function TrailRadios({
  trail,
  value,
  onChange,
  name,
}: {
  trail: EquipmentTrail;
  value: string;
  onChange: (v: string) => void;
  name: string;
}) {
  const rows = visibleTrailBookings(trail);
  const hasOut = trail.bookings.some((b) => b.returnMode === "OUT");
  const rowCls = (on: boolean) =>
    `grid cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-2 border-b border-border px-2.5 py-1.5 text-[12px] last:border-b-0 focus-within:bg-accent-soft ${
      on ? "bg-accent-soft" : "hover:bg-surface-muted"
    }`;
  return (
    <>
      <fieldset className="mt-2 overflow-hidden rounded border border-border bg-surface">
        <legend className="sr-only">Где видели в последний раз</legend>
        <p className="border-b border-border bg-surface-muted px-2.5 py-1 text-[11px] text-ink-3">
          Где видели в последний раз — последние выдачи этой позиции
          {trail.windowIsDefault ? " за 60 дней" : " с прошлой сверки"}. Отметьте вероятную, если есть
        </p>
        {rows.length === 0 && (
          <p className="border-b border-border px-2.5 py-1.5 text-[11.5px] text-ink-3">
            {hasOut ? "Вернувшихся выдач за это время нет." : "За это время позицию не выдавали."}
          </p>
        )}
        {rows.map((b) => (
          <label key={b.bookingId} className={rowCls(value === b.bookingId)}>
            <input
              type="radio"
              name={name}
              value={b.bookingId}
              checked={value === b.bookingId}
              onChange={() => onChange(b.bookingId)}
              className="h-3.5 w-3.5 accent-accent-bright"
            />
            <span className="min-w-0">
              <b className="font-semibold text-ink">{b.projectName}</b>
              <span className="text-ink-2"> · {b.clientName}</span>
              {trail.suggestedBookingId === b.bookingId && (
                <span className="ml-1.5 rounded border border-accent-border bg-accent-soft px-1 text-[10px] font-semibold text-accent-bright">
                  вероятно здесь
                </span>
              )}
              <span className="block text-[11px] text-ink-3">{trailRowNote(b)}</span>
            </span>
            <span className="whitespace-nowrap font-mono text-[11px] text-ink-2">
              {formatTrailDates(b.startDate, b.endDate)}
            </span>
          </label>
        ))}
        <label className={rowCls(value === NO_BOOKING)}>
          <input
            type="radio"
            name={name}
            value={NO_BOOKING}
            checked={value === NO_BOOKING}
            onChange={() => onChange(NO_BOOKING)}
            className="h-3.5 w-3.5 accent-accent-bright"
          />
          <span className="min-w-0">
            <b className="font-semibold text-ink">Не связано с бронью</b>
            <span className="block text-[11px] text-ink-3">пропало на складе / в машине</span>
          </span>
          <span />
        </label>
      </fieldset>
      {hasOut && (
        <p className="mt-1 text-[11px] text-ink-3">
          Брони на съёмке здесь не показаны — если пропало там, отметят на приёмке.
        </p>
      )}
    </>
  );
}

// ── Шаг 2 · причина ───────────────────────────────────────────────────────────

export function ReasonChips({
  value,
  onChange,
}: {
  value: ProblemItemReason;
  onChange: (r: ProblemItemReason) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Что случилось">
        {REASON_CHIPS.map((c) => {
          const selected = value === c.value;
          // «Не нашли на складе» — сигнальная, как в мокапе; остальные — акцент.
          const on =
            c.value === "NOT_ON_SHELF" ? "border-rose bg-rose text-surface" : "border-accent bg-accent text-surface";
          return (
            <button
              key={c.value}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(c.value)}
              className={`${CHIP} ${selected ? on : CHIP_OFF}`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-ink-3">→ {REASON_OUTCOME[value]}</p>
    </>
  );
}

// ── Шаг 1 · выбранная позиция ─────────────────────────────────────────────────

export function PickedPosition({
  picked,
  trail,
  trailState,
  units,
  unitsState,
  unitId,
  quantity,
  onUnpick,
  onRetry,
  onUnitChange,
  onQuantityChange,
}: {
  picked: EquipmentSearchItem;
  trail: EquipmentTrail | null;
  trailState: TrailState;
  units: EquipmentUnitItem[] | null;
  unitsState: TrailState;
  unitId: string | null;
  quantity: number;
  onUnpick: () => void;
  onRetry: () => void;
  onUnitChange: (id: string) => void;
  onQuantityChange: (n: number) => void;
}) {
  const isUnitMode = picked.stockTrackingMode === "UNIT";
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded border border-accent-border bg-accent-soft px-2.5 py-1.5">
        <span className="font-cond text-[15px] font-bold text-ink">{picked.name}</span>
        <span className="text-[11.5px] text-ink-2">
          {picked.category} · {isUnitMode ? "штучный учёт" : "без штучного учёта"}
        </span>
        <button
          type="button"
          onClick={onUnpick}
          className="ml-auto text-[12px] font-semibold text-accent-bright hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-bright"
        >
          изменить
        </button>
      </div>
      {trailState === "loading" && !trail && (
        <p className="mt-2 text-[11.5px] text-ink-3">Считаем наличие по учёту…</p>
      )}
      {trailState === "error" && (
        <p className="mt-2 flex flex-wrap items-center gap-2 text-[11.5px] text-rose">
          Не удалось загрузить наличие.
          <button type="button" className={MINI} onClick={onRetry}>
            Повторить
          </button>
        </p>
      )}
      {isUnitMode ? (
        <UnitPicker
          units={units}
          state={unitsState}
          // «Повторить» наличия выше перезапрашивает и единицы — вторая кнопка лишняя.
          showRetry={trailState !== "error"}
          onRetry={onRetry}
          value={unitId}
          onChange={onUnitChange}
        />
      ) : (
        trail && (
          <>
            <StockTiles trail={trail} />
            <QuantityStepper value={quantity} max={trail.onShelf.expected} onChange={onQuantityChange} />
          </>
        )
      )}
    </>
  );
}

// ── Данные выбранной позиции ──────────────────────────────────────────────────

export type TrailState = "idle" | "loading" | "error";

/**
 * След + наличие позиции (GET /api/problem-items/trail) и, для штучной,
 * её единицы (GET /api/equipment/:id/units). `nonce` — перечитать после отказа
 * сервера (полка или единица изменились, пока модалка была открыта) и по
 * «Повторить». Сбой загрузки единиц — отдельное состояние «error», а не пустой
 * список: иначе он читался бы как «все единицы пропали».
 */
export function usePositionData(picked: EquipmentSearchItem | null, nonce: number) {
  const [trail, setTrail] = useState<EquipmentTrail | null>(null);
  const [trailState, setTrailState] = useState<TrailState>("idle");
  // null — ещё не загружены (или позиция без штучного учёта).
  const [units, setUnits] = useState<EquipmentUnitItem[] | null>(null);
  const [unitsState, setUnitsState] = useState<TrailState>("idle");

  // Другая позиция — старые данные не показываем ни кадра.
  useEffect(() => {
    setTrail(null);
    setTrailState("idle");
    setUnits(null);
    setUnitsState("idle");
  }, [picked]);

  useEffect(() => {
    if (!picked) return;
    let cancelled = false;
    setTrailState("loading");
    apiFetch<{ trail: EquipmentTrail }>(`/api/problem-items/trail?equipmentId=${encodeURIComponent(picked.id)}`)
      .then(({ trail: t }) => {
        if (cancelled) return;
        setTrail(t);
        setTrailState("idle");
      })
      .catch(() => {
        if (!cancelled) setTrailState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [picked, nonce]);

  useEffect(() => {
    if (!picked || picked.stockTrackingMode !== "UNIT") return;
    let cancelled = false;
    setUnitsState("loading");
    apiFetch<{ units: EquipmentUnitItem[] }>(`/api/equipment/${encodeURIComponent(picked.id)}/units`)
      .then((d) => {
        if (cancelled) return;
        setUnits(d.units);
        setUnitsState("idle");
      })
      .catch(() => {
        if (cancelled) return;
        setUnits(null);
        setUnitsState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [picked, nonce]);

  return { trail, trailState, units, unitsState };
}
