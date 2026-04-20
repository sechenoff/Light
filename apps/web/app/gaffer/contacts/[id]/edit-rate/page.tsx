"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ROLES, getRateCard, listPositions, type RateCardId, type RateCardPositionKey } from "@light-rental/shared";
import {
  getContact,
  updateContact,
  GafferApiError,
  type GafferContact,
} from "../../../../../src/lib/gafferApi";
import { toast } from "../../../../../src/components/ToastProvider";
import { Segmented, Eyebrow } from "../../../../../src/components/gaffer/designSystem";

// ── Local helpers ─────────────────────────────────────────────────────────────

/**
 * Format an integer with NBSP thousands separator: 14000 → "14\u00A0000"
 * Does NOT include the ₽ sign — that's shown as a static suffix element.
 */
function formatThousands(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(n);
}

/** Parse a display string like "14 000" or "14\u00A0000" back to an integer. */
function parseDisplayRate(s: string): number {
  const stripped = s.replace(/[\s\u00A0]/g, "");
  if (!stripped) return 0;
  const n = parseInt(stripped, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Sanitize raw user input: strip non-digits, re-format with NBSP thousands. */
function sanitizeInput(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  return formatThousands(parseInt(digits, 10));
}

function TypePill({ type }: { type: GafferContact["type"] }) {
  if (type === "CLIENT") {
    return (
      <span
        className="inline-flex items-center rounded-full border px-[9px] py-[3px] text-[11px] font-semibold bg-indigo-soft text-indigo border-indigo-border"
        style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
      >
        Заказчик
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center rounded-full border px-[9px] py-[3px] text-[11px] font-semibold bg-teal-soft text-teal border-teal-border"
      style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
    >
      Команда
    </span>
  );
}

/** Rate input with a trailing ₽ suffix */
function RateInput({
  id,
  value,
  onChange,
  placeholder,
  smaller,
  disabled,
}: {
  id?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  smaller?: boolean;
  disabled?: boolean;
}) {
  const padding = smaller ? "px-[11px] py-[7px]" : "px-[11px] py-[9px]";
  return (
    <div className="relative flex items-center">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        value={value}
        placeholder={placeholder ?? "0"}
        disabled={disabled}
        onChange={(e) => onChange(sanitizeInput(e.target.value))}
        className={`w-full ${padding} border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright mono-num pr-7 disabled:opacity-50 disabled:cursor-not-allowed`}
      />
      <span className="absolute right-2.5 text-[12px] text-ink-3 pointer-events-none select-none">₽</span>
    </div>
  );
}

// ── Main content ──────────────────────────────────────────────────────────────

function EditRateContent() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  const [contact, setContact] = useState<GafferContact | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [saving, setSaving] = useState(false);

  // Rate form state — stored as display strings like "14\u00A0000"
  const [shiftRateStr, setShiftRateStr] = useState("");
  const [tier1Str, setTier1Str] = useState("");
  const [tier2Str, setTier2Str] = useState("");
  const [tier3Str, setTier3Str] = useState("");
  const [roleLabel, setRoleLabel] = useState<string | null>(null);

  // Rate-card picker state
  const [cardId, setCardId] = useState<RateCardId>("custom");
  const [positionKey, setPositionKey] = useState<RateCardPositionKey | "">("");

  // Derived numeric values for the formula preview
  const shiftRate = parseDisplayRate(shiftRateStr);
  const tier1 = parseDisplayRate(tier1Str);
  const exampleTotal = shiftRate + 4 * tier1;

  // Load contact on mount
  useEffect(() => {
    let cancelled = false;
    let redirecting = false;
    setLoading(true);
    (async () => {
      try {
        const res = await getContact(id);
        if (!cancelled) {
          const c = res.contact;
          if (c.type !== "TEAM_MEMBER") {
            // Keep loading=true so the page shows the skeleton (not "not found")
            // until Next.js navigates to the view screen.
            redirecting = true;
            toast.error("Ставка настраивается только для команды");
            router.replace(`/gaffer/contacts/${id}`);
            return;
          }
          setContact(c);
          // Initialize from contact's rate fields
          const sr = Math.round(Number(c.shiftRate));
          const t1 = Math.round(Number(c.overtimeTier1Rate));
          const t2 = Math.round(Number(c.overtimeTier2Rate));
          const t3 = Math.round(Number(c.overtimeTier3Rate));
          setShiftRateStr(sr > 0 ? formatThousands(sr) : "");
          setTier1Str(t1 > 0 ? formatThousands(t1) : "");
          setTier2Str(t2 > 0 ? formatThousands(t2) : "");
          setTier3Str(t3 > 0 ? formatThousands(t3) : "");
          setRoleLabel(c.roleLabel ?? null);
          // Initialize rate-card picker
          setCardId(c.rateCardId ?? "custom");
          setPositionKey(c.rateCardPosition ?? "");
        }
      } catch (e) {
        if (!cancelled) {
          // 404 → honest "not found"; other failures (5xx, network) → toast + same fallback
          if (e instanceof GafferApiError && e.status === 404) {
            setNotFound(true);
          } else {
            toast.error("Не удалось загрузить контакт");
            setNotFound(true);
          }
        }
      } finally {
        if (!cancelled && !redirecting) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [id, router]);

  // Auto-fill rates when a (card, position) pair is selected
  useEffect(() => {
    if (cardId === "custom" || !positionKey) return;
    const card = getRateCard(cardId);
    if (!card) return;
    const data = card.positions[positionKey as RateCardPositionKey];
    if (!data) return;
    setShiftRateStr(formatThousands(data.shiftRate));
    setTier1Str(formatThousands(data.ot1Rate));
    setTier2Str(formatThousands(data.ot2Rate));
    setTier3Str(formatThousands(data.ot3Rate));
    setRoleLabel(data.label);
  }, [cardId, positionKey]);

  // Detect which preset role (if any) currently matches the 4 rate fields
  const matchedRoleId = useMemo(() => {
    if (!shiftRateStr && !tier1Str && !tier2Str && !tier3Str) return "";
    const sr = parseDisplayRate(shiftRateStr);
    const t1 = parseDisplayRate(tier1Str);
    const t2 = parseDisplayRate(tier2Str);
    const t3 = parseDisplayRate(tier3Str);
    const match = ROLES.find(
      (r) =>
        r.shiftRate === sr &&
        r.overtime.tier1 === t1 &&
        r.overtime.tier2 === t2 &&
        r.overtime.tier3 === t3,
    );
    return match ? match.id : "";
  }, [shiftRateStr, tier1Str, tier2Str, tier3Str]);

  function handleRoleSelect(roleId: string) {
    if (!roleId) {
      // "— свой вариант —": keep current rates, clear roleLabel
      setRoleLabel(null);
      return;
    }
    const preset = ROLES.find((r) => r.id === roleId);
    if (!preset) return;
    setShiftRateStr(formatThousands(preset.shiftRate));
    setTier1Str(formatThousands(preset.overtime.tier1));
    setTier2Str(formatThousands(preset.overtime.tier2));
    setTier3Str(formatThousands(preset.overtime.tier3));
    setRoleLabel(preset.label);
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateContact(id, {
        shiftRate: String(parseDisplayRate(shiftRateStr)),
        overtimeTier1Rate: String(parseDisplayRate(tier1Str)),
        overtimeTier2Rate: String(parseDisplayRate(tier2Str)),
        overtimeTier3Rate: String(parseDisplayRate(tier3Str)),
        roleLabel: roleLabel ?? null,
        rateCardId: cardId,
        rateCardPosition: cardId === "custom" ? null : (positionKey || null),
        shiftHours: 10,
      });
      toast.success("Ставка сохранена");
      router.push(`/gaffer/contacts/${id}`);
    } catch (err) {
      toast.error(err instanceof GafferApiError ? err.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  // ── Loading skeleton ──
  if (loading) {
    return (
      <div className="p-4 space-y-3 animate-pulse">
        <div className="h-5 bg-border rounded w-1/2" />
        <div className="h-4 bg-border rounded w-1/3" />
        <div className="h-4 bg-border rounded w-2/3" />
      </div>
    );
  }

  // ── Not found ──
  if (notFound || !contact) {
    return (
      <div className="p-6 text-center">
        <p className="text-ink-3 mb-4">Контакт не найден</p>
        <Link href="/gaffer/contacts" className="text-accent-bright">
          ← Все контакты
        </Link>
      </div>
    );
  }

  const isArchived = contact.isArchived;
  const metaParts: string[] = [];
  if (roleLabel) metaParts.push(roleLabel);
  if (contact.telegram) metaParts.push(contact.telegram);
  if (contact.phone) metaParts.push(contact.phone);

  return (
    <div className="min-h-screen bg-surface pb-24">
      {/* Topbar */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        <Link
          href={`/gaffer/contacts/${id}`}
          className="text-accent-bright hover:text-accent transition-colors text-[11px] font-semibold tracking-[1.4px] uppercase"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
        >
          ← Команда
        </Link>
        <TypePill type={contact.type} />
      </div>

      <div className="px-4 pt-5 space-y-5">
        {/* Archived banner */}
        {isArchived && (
          <div className="flex items-center gap-2 bg-slate-soft border border-slate-border text-slate text-[12.5px] rounded px-3 py-2.5">
            <span className="shrink-0">ℹ️</span>
            <span>Контакт в архиве — ставка недоступна для редактирования</span>
          </div>
        )}

        {/* Rate-card picker */}
        <div>
          <Eyebrow>Тарифная сетка</Eyebrow>
          <div className="mt-2">
            <Segmented<RateCardId>
              options={[
                { id: "rates_2024", label: "Тариф 2024" },
                { id: "rates_2026", label: "Тариф 2026" },
                { id: "custom",     label: "Вручную"    },
              ]}
              value={cardId}
              onChange={setCardId}
            />
          </div>
        </div>

        {/* Profile section */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <span
              className="eyebrow"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              Профиль осветителя
            </span>
          </div>
          <h3 className="text-[18px] font-semibold text-ink mb-1">{contact.name}</h3>
          {metaParts.length > 0 && (
            <p className="text-[12.5px] text-ink-3">{metaParts.join(" · ")}</p>
          )}
        </div>

        {/* Rate section */}
        <div>
          <p
            className="eyebrow mb-3"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            Ставка по умолчанию
          </p>
          <div className="grid grid-cols-[1fr_1fr] gap-2">
            {/* Shift rate input */}
            <div>
              <label htmlFor="edit-rate-shift" className="block text-[12px] text-ink-2 mb-1">Смена (до 10 ч)</label>
              <RateInput
                id="edit-rate-shift"
                value={shiftRateStr}
                onChange={setShiftRateStr}
                placeholder={"14\u00A0000"}
                disabled={isArchived || cardId !== "custom"}
              />
            </div>
            {/* Role / position select */}
            <div>
              <label htmlFor="edit-rate-role" className="block text-[12px] text-ink-2 mb-1">
                {cardId !== "custom" ? "Позиция" : "Роль (пресет)"}
              </label>
              {cardId !== "custom" ? (
                <select
                  id="edit-rate-role"
                  value={positionKey}
                  onChange={(e) => setPositionKey(e.target.value as RateCardPositionKey | "")}
                  disabled={isArchived}
                  className="w-full px-[11px] py-[9px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">— выберите —</option>
                  {listPositions(getRateCard(cardId)!).map((p) => (
                    <option key={p.key} value={p.key}>{p.label}</option>
                  ))}
                </select>
              ) : (
                <select
                  id="edit-rate-role"
                  value={matchedRoleId}
                  onChange={(e) => handleRoleSelect(e.target.value)}
                  disabled={isArchived}
                  className="w-full px-[11px] py-[9px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <option value="">— свой вариант —</option>
                  {ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
        </div>

        {/* Overtime nested card */}
        <div className="border border-border rounded overflow-hidden">
          {/* Card header */}
          <div className="px-3 py-2.5 border-b border-border bg-[#fafafa]">
            <p
              className="eyebrow"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              Переработка · ставка за час
            </p>
          </div>
          {/* Card body */}
          <div className="px-3 py-3 space-y-2.5 bg-surface">
            {/* Tier 1 */}
            <div className="grid grid-cols-[80px_1fr] gap-2.5 items-center">
              <label htmlFor="edit-rate-tier1" className="cursor-pointer">
                <p className="text-[12px] text-ink-2 font-medium">Тир 1</p>
                <small className="text-ink-3 text-[10px]">1–8 ч</small>
              </label>
              <RateInput id="edit-rate-tier1" value={tier1Str} onChange={setTier1Str} smaller disabled={isArchived || cardId !== "custom"} />
            </div>
            {/* Tier 2 */}
            <div className="grid grid-cols-[80px_1fr] gap-2.5 items-center">
              <label htmlFor="edit-rate-tier2" className="cursor-pointer">
                <p className="text-[12px] text-ink-2 font-medium">Тир 2</p>
                <small className="text-ink-3 text-[10px]">9–14 ч</small>
              </label>
              <RateInput id="edit-rate-tier2" value={tier2Str} onChange={setTier2Str} smaller disabled={isArchived || cardId !== "custom"} />
            </div>
            {/* Tier 3 */}
            <div className="grid grid-cols-[80px_1fr] gap-2.5 items-center">
              <label htmlFor="edit-rate-tier3" className="cursor-pointer">
                <p className="text-[12px] text-ink-2 font-medium">Тир 3</p>
                <small className="text-ink-3 text-[10px]">15+ ч</small>
              </label>
              <RateInput id="edit-rate-tier3" value={tier3Str} onChange={setTier3Str} smaller disabled={isArchived || cardId !== "custom"} />
            </div>
          </div>
          {/* Formula footer */}
          <div className="px-3 py-2.5 bg-accent-soft border-t border-accent-border text-[11.5px] text-accent">
            Пример при 14 ч:{" "}
            <span className="mono-num">{shiftRateStr || "0"}</span>
            {" + (4 × "}
            <span className="mono-num">{tier1Str || "0"}</span>
            {") = "}
            <b className="mono-num">{formatThousands(exampleTotal)} ₽</b>
          </div>
        </div>

        {/* Snapshot semantics note */}
        <p className="text-[11.5px] text-ink-3 leading-relaxed">
          Ставка применится ко <b>всем будущим</b> проектам. Уже созданные проекты сохраняют свои суммы как снимок — не пересчитываются.
        </p>
      </div>

      {/* Sticky save-bar */}
      <div className="sticky bottom-0 bg-surface border-t border-border px-4 py-3 flex gap-2">
        <button
          type="button"
          onClick={() => router.push(`/gaffer/contacts/${id}`)}
          className="flex-1 bg-surface border border-border text-ink rounded px-4 py-2.5 text-[13px] hover:bg-[#fafafa] transition-colors"
        >
          Отмена
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || isArchived}
          className="flex-1 bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-2.5 text-[13px] transition-colors disabled:opacity-50"
        >
          {saving ? "Сохраняем…" : "Сохранить ставку"}
        </button>
      </div>
    </div>
  );
}

export default function EditRatePage() {
  return (
    <Suspense
      fallback={
        <div className="p-4 space-y-3 animate-pulse">
          <div className="h-5 bg-border rounded w-1/2" />
          <div className="h-4 bg-border rounded w-1/3" />
          <div className="h-4 bg-border rounded w-2/3" />
        </div>
      }
    >
      <EditRateContent />
    </Suspense>
  );
}
