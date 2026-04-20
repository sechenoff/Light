"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ROLES } from "@light-rental/shared";
import { createContact, GafferApiError } from "../../../../src/lib/gafferApi";
import { toast } from "../../../../src/components/ToastProvider";
import { Segmented, Eyebrow } from "../../../../src/components/gaffer/designSystem";
import {
  RATE_CARDS,
  getRateCard,
  listPositions,
  type RateCardId,
  type RateCardPositionKey,
} from "@light-rental/shared";

type Step = "picker" | "client" | "crew" | "rental";

// ── Rate helpers (mirror edit-rate page) ────────────────────────────────────

function formatThousands(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
    useGrouping: true,
  }).format(n);
}

function parseDisplayRate(s: string): number {
  const stripped = s.replace(/[\s\u00A0]/g, "");
  if (!stripped) return 0;
  const n = parseInt(stripped, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function sanitizeInput(raw: string): string {
  const digits = raw.replace(/[^\d]/g, "");
  if (!digits) return "";
  return formatThousands(parseInt(digits, 10));
}

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

// ── Shared field primitives ─────────────────────────────────────────────────

function TextField({
  id,
  label,
  required,
  value,
  onChange,
  placeholder,
  type = "text",
  autoFocus,
  error,
  hint,
}: {
  id: string;
  label: string;
  required?: boolean;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
  error?: string;
  hint?: string;
}) {
  return (
    <div>
      <label className="block text-[12px] text-ink-2 mb-1" htmlFor={id}>
        {label} {required && <span className="text-rose">*</span>}
      </label>
      <input
        id={id}
        type={type}
        required={required}
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={`w-full px-[11px] py-[9px] border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright ${
          error ? "border-rose-border focus:ring-rose-border" : "border-border"
        }`}
      />
      {error && <p className="text-rose text-[11.5px] mt-1">{error}</p>}
      {hint && !error && <p className="text-[11px] text-ink-3 mt-1">{hint}</p>}
    </div>
  );
}

function TextArea({
  id,
  label,
  value,
  onChange,
  placeholder,
  rows = 3,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
}) {
  return (
    <div>
      <label className="block text-[12px] text-ink-2 mb-1" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        placeholder={placeholder}
        className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright resize-none"
      />
    </div>
  );
}

// ── Main content ────────────────────────────────────────────────────────────

function GafferNewContactContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Pre-set step from query param (project-creation redirect flow)
  const typeParam = searchParams.get("type");
  const initialStep: Step =
    typeParam === "CLIENT"
      ? "client"
      : typeParam === "TEAM_MEMBER"
      ? "crew"
      : "picker";

  // Return-to flow params (validated on use — only /gaffer/* allowed)
  const rawReturnTo = searchParams.get("returnTo") ?? "";
  const returnLabel = searchParams.get("returnLabel") ?? "";
  const safeReturnTo = rawReturnTo.startsWith("/gaffer/") ? rawReturnTo : "";

  const [step, setStep] = useState<Step>(initialStep);

  // Sync step if query param changes
  useEffect(() => {
    const t = searchParams.get("type");
    if (t === "CLIENT") setStep("client");
    else if (t === "TEAM_MEMBER") setStep("crew");
  }, [searchParams]);

  // Shared form state (used by all 3 variants selectively)
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [telegram, setTelegram] = useState("");
  const [note, setNote] = useState("");

  // Crew-only state
  const [roleId, setRoleId] = useState<string>(""); // "" = not selected yet
  const [customRoleLabel, setCustomRoleLabel] = useState("");
  const [shiftRateStr, setShiftRateStr] = useState("");
  const [tier1Str, setTier1Str] = useState("");
  const [tier2Str, setTier2Str] = useState("");
  const [tier3Str, setTier3Str] = useState("");
  const [cardId, setCardId] = useState<RateCardId>("custom");
  const [positionKey, setPositionKey] = useState<RateCardPositionKey | "">("");

  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const exampleTotal = useMemo(() => {
    const sr = parseDisplayRate(shiftRateStr);
    const t1 = parseDisplayRate(tier1Str);
    return sr + 4 * t1;
  }, [shiftRateStr, tier1Str]);

  function handleRoleSelect(selected: string) {
    setRoleId(selected);
    if (selected === "OTHER" || selected === "") return;
    const preset = ROLES.find((r) => r.id === selected);
    if (!preset) return;
    setShiftRateStr(formatThousands(preset.shiftRate));
    setTier1Str(formatThousands(preset.overtime.tier1));
    setTier2Str(formatThousands(preset.overtime.tier2));
    setTier3Str(formatThousands(preset.overtime.tier3));
  }

  function redirectAfterCreate(contactId: string) {
    let redirectUrl = `/gaffer/contacts/${contactId}`;
    if (safeReturnTo) {
      const params = new URLSearchParams();
      params.set("returnTo", safeReturnTo);
      if (returnLabel) params.set("returnLabel", returnLabel);
      redirectUrl = `${redirectUrl}?${params.toString()}`;
    }
    router.push(redirectUrl);
  }

  function handleApiError(err: unknown) {
    if (err instanceof GafferApiError) {
      if (err.code === "INVALID_TELEGRAM") {
        setErrors({ telegram: "Некорректный Telegram — укажите @username или ссылку t.me/…" });
      } else {
        toast.error(err.message);
      }
    } else {
      toast.error("Не удалось создать контакт");
    }
  }

  async function handleSubmitClient(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setLoading(true);
    try {
      const res = await createContact({
        type: "CLIENT",
        name: name.trim(),
        phone: phone.trim() || undefined,
        telegram: telegram.trim() || undefined,
        note: note.trim() || undefined,
      });
      toast.success("Заказчик создан");
      redirectAfterCreate(res.contact.id);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitCrew(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});

    const rateCardIdToSend: RateCardId = cardId;
    const rateCardPositionToSend =
      cardId === "custom" ? null : (positionKey || null);
    const resolvedLabel =
      cardId !== "custom" && positionKey
        ? RATE_CARDS[cardId as Exclude<RateCardId, "custom">].positions[positionKey as RateCardPositionKey].label
        : roleId === "OTHER"
        ? customRoleLabel.trim() || null
        : ROLES.find((r) => r.id === roleId)?.label ?? null;

    setLoading(true);
    try {
      const res = await createContact({
        type: "TEAM_MEMBER",
        name: name.trim(),
        phone: phone.trim() || undefined,
        telegram: telegram.trim() || undefined,
        note: note.trim() || undefined,
        roleLabel: resolvedLabel,
        shiftRate: String(parseDisplayRate(shiftRateStr)),
        overtimeTier1Rate: String(parseDisplayRate(tier1Str)),
        overtimeTier2Rate: String(parseDisplayRate(tier2Str)),
        overtimeTier3Rate: String(parseDisplayRate(tier3Str)),
        rateCardId: rateCardIdToSend,
        rateCardPosition: rateCardPositionToSend,
        shiftHours: 10,
      });
      toast.success("Осветитель создан");
      redirectAfterCreate(res.contact.id);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmitRental(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    setLoading(true);
    try {
      const res = await createContact({
        type: "VENDOR",
        name: name.trim(),
        phone: phone.trim() || undefined,
        telegram: telegram.trim() || undefined,
        note: note.trim() || undefined,
      });
      toast.success("Рентал создан");
      redirectAfterCreate(res.contact.id);
    } catch (err) {
      handleApiError(err);
    } finally {
      setLoading(false);
    }
  }

  // ── Header ──
  const headerTitle =
    step === "picker"
      ? "Новый контакт"
      : step === "client"
      ? "Новый заказчик"
      : step === "crew"
      ? "Новый осветитель"
      : "Новый рентал";

  const backHref = step === "picker" ? "/gaffer/contacts" : null;

  return (
    <div className="min-h-screen bg-surface">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 border-b border-border">
        {backHref ? (
          <Link
            href={backHref}
            className="text-accent-bright hover:text-accent transition-colors text-[13px]"
          >
            ← Назад
          </Link>
        ) : (
          <button
            type="button"
            onClick={() => {
              setErrors({});
              setStep("picker");
            }}
            className="text-accent-bright hover:text-accent transition-colors text-[13px]"
          >
            ← К выбору
          </button>
        )}
        <h1 className="text-[17px] font-semibold text-ink">{headerTitle}</h1>
      </div>

      {/* Picker step */}
      {step === "picker" && (
        <div className="px-4 py-6 space-y-3">
          <p className="text-[13px] text-ink-3 mb-2">
            Выберите, какой контакт вы добавляете — от этого зависит, какие поля будут в карточке.
          </p>

          <button
            type="button"
            onClick={() => setStep("client")}
            className="w-full text-left bg-surface border border-border rounded px-4 py-4 hover:bg-[#fafafa] hover:border-accent-border transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center rounded-full border px-[9px] py-[3px] text-[11px] font-semibold bg-indigo-soft text-indigo border-indigo-border">
                Заказчик
              </span>
              <span className="text-[15px] font-semibold text-ink">Создать Заказчика</span>
            </div>
            <p className="text-[12px] text-ink-3 mt-1.5">
              Продакшн, агентство или прямой клиент, на которого оформляются проекты.
            </p>
          </button>

          <button
            type="button"
            onClick={() => setStep("crew")}
            className="w-full text-left bg-surface border border-border rounded px-4 py-4 hover:bg-[#fafafa] hover:border-accent-border transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center rounded-full border px-[9px] py-[3px] text-[11px] font-semibold bg-teal-soft text-teal border-teal-border">
                Команда
              </span>
              <span className="text-[15px] font-semibold text-ink">Создать Осветителя</span>
            </div>
            <p className="text-[12px] text-ink-3 mt-1.5">
              Человек из команды: гафер, кей-грип, осветитель, пультовик — с настройкой ставки.
            </p>
          </button>

          <button
            type="button"
            onClick={() => setStep("rental")}
            className="w-full text-left bg-surface border border-border rounded px-4 py-4 hover:bg-[#fafafa] hover:border-accent-border transition-colors"
          >
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center rounded-full border px-[9px] py-[3px] text-[11px] font-semibold bg-amber-soft text-amber border-amber-border">
                Рентал
              </span>
              <span className="text-[15px] font-semibold text-ink">Создать Рентал</span>
            </div>
            <p className="text-[12px] text-ink-3 mt-1.5">
              Рентал-хаус или субподрядчик по оборудованию — для учёта аренды на проектах.
            </p>
          </button>
        </div>
      )}

      {/* Client form */}
      {step === "client" && (
        <form onSubmit={handleSubmitClient} className="px-4 py-5 space-y-4">
          <TextField
            id="c-name"
            label="Имя / Название"
            required
            autoFocus
            value={name}
            onChange={setName}
            placeholder="Ромашка Продакшн"
          />
          <TextField
            id="c-phone"
            label="Телефон"
            type="tel"
            value={phone}
            onChange={setPhone}
            placeholder="+7 999 123-45-67"
          />
          <TextField
            id="c-telegram"
            label="Telegram"
            value={telegram}
            onChange={setTelegram}
            placeholder="@username или t.me/…"
            error={errors.telegram}
            hint="@username или ссылка t.me/…"
          />
          <TextArea
            id="c-note"
            label="Заметка"
            value={note}
            onChange={setNote}
            placeholder="Любая дополнительная информация…"
          />
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-3 text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Создаём…" : "Создать заказчика"}
          </button>
        </form>
      )}

      {/* Crew form */}
      {step === "crew" && (
        <form onSubmit={handleSubmitCrew} className="px-4 py-5 space-y-4">
          <TextField
            id="c-name"
            label="Имя"
            required
            autoFocus
            value={name}
            onChange={setName}
            placeholder="Иван Петров"
          />

          {/* Rate card picker */}
          <div>
            <Eyebrow>Тарифная сетка</Eyebrow>
            <div className="mt-1.5">
              <Segmented<RateCardId>
                options={[
                  { id: "rates_2024", label: "Тариф 2024" },
                  { id: "rates_2026", label: "Тариф 2026" },
                  { id: "custom", label: "Вручную" },
                ]}
                value={cardId}
                onChange={(id) => {
                  setCardId(id);
                  if (id === "custom") {
                    setPositionKey("");
                    // preserve current values — don't wipe
                  }
                }}
              />
            </div>
          </div>

          {/* Specialty — card-mode: position picker; custom-mode: ROLES select */}
          {cardId !== "custom" ? (
            <div>
              <label className="block text-[12px] text-ink-2 mb-1" htmlFor="c-position">
                Позиция
              </label>
              <select
                id="c-position"
                value={positionKey}
                onChange={(e) => {
                  const key = e.target.value as RateCardPositionKey | "";
                  setPositionKey(key);
                  if (key) {
                    const card = getRateCard(cardId);
                    if (card) {
                      const data = card.positions[key as RateCardPositionKey];
                      setShiftRateStr(formatThousands(data.shiftRate));
                      setTier1Str(formatThousands(data.ot1Rate));
                      setTier2Str(formatThousands(data.ot2Rate));
                      setTier3Str(formatThousands(data.ot3Rate));
                    }
                  }
                }}
                className="w-full px-[11px] py-[9px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
              >
                <option value="">— выберите позицию —</option>
                {listPositions(getRateCard(cardId)!).map(({ key, label }) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <>
              <div>
                <label className="block text-[12px] text-ink-2 mb-1" htmlFor="c-role">
                  Специальность
                </label>
                <select
                  id="c-role"
                  value={roleId}
                  onChange={(e) => handleRoleSelect(e.target.value)}
                  className="w-full px-[11px] py-[9px] border border-border rounded text-[13px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright"
                >
                  <option value="">— не выбрано —</option>
                  {ROLES.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                  <option value="OTHER">Другое…</option>
                </select>
                {roleId && roleId !== "OTHER" && (
                  <p className="text-[11px] text-ink-3 mt-1">
                    Ставки подставлены из пресета — можно изменить ниже.
                  </p>
                )}
              </div>

              {roleId === "OTHER" && (
                <TextField
                  id="c-role-custom"
                  label="Название специальности"
                  value={customRoleLabel}
                  onChange={setCustomRoleLabel}
                  placeholder="Например: DIT, дрон-оператор"
                />
              )}
            </>
          )}

          <TextField
            id="c-phone"
            label="Телефон"
            type="tel"
            value={phone}
            onChange={setPhone}
            placeholder="+7 999 123-45-67"
          />
          <TextField
            id="c-telegram"
            label="Telegram"
            value={telegram}
            onChange={setTelegram}
            placeholder="@username или t.me/…"
            error={errors.telegram}
            hint="@username или ссылка t.me/…"
          />

          {/* Rates */}
          <div>
            <p
              className="eyebrow mb-2"
              style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
            >
              Ставка по умолчанию
            </p>
            <div>
              <label htmlFor="c-rate-shift" className="block text-[12px] text-ink-2 mb-1">
                Смена (до 10 ч)
              </label>
              <RateInput
                id="c-rate-shift"
                value={shiftRateStr}
                onChange={setShiftRateStr}
                placeholder={"14\u00A0000"}
                disabled={cardId !== "custom"}
              />
            </div>
          </div>

          {/* Overtime card */}
          <div className="border border-border rounded overflow-hidden">
            <div className="px-3 py-2.5 border-b border-border bg-[#fafafa]">
              <p
                className="eyebrow"
                style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
              >
                Переработка · ставка за час
              </p>
            </div>
            <div className="px-3 py-3 space-y-2.5 bg-surface">
              <div className="grid grid-cols-[80px_1fr] gap-2.5 items-center">
                <label htmlFor="c-rate-tier1" className="cursor-pointer">
                  <p className="text-[12px] text-ink-2 font-medium">Тир 1</p>
                  <small className="text-ink-3 text-[10px]">1–8 ч</small>
                </label>
                <RateInput id="c-rate-tier1" value={tier1Str} onChange={setTier1Str} smaller disabled={cardId !== "custom"} />
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-2.5 items-center">
                <label htmlFor="c-rate-tier2" className="cursor-pointer">
                  <p className="text-[12px] text-ink-2 font-medium">Тир 2</p>
                  <small className="text-ink-3 text-[10px]">9–14 ч</small>
                </label>
                <RateInput id="c-rate-tier2" value={tier2Str} onChange={setTier2Str} smaller disabled={cardId !== "custom"} />
              </div>
              <div className="grid grid-cols-[80px_1fr] gap-2.5 items-center">
                <label htmlFor="c-rate-tier3" className="cursor-pointer">
                  <p className="text-[12px] text-ink-2 font-medium">Тир 3</p>
                  <small className="text-ink-3 text-[10px]">15+ ч</small>
                </label>
                <RateInput id="c-rate-tier3" value={tier3Str} onChange={setTier3Str} smaller disabled={cardId !== "custom"} />
              </div>
            </div>
            <div className="px-3 py-2.5 bg-accent-soft border-t border-accent-border text-[11.5px] text-accent">
              Пример при 14 ч:{" "}
              <span className="mono-num">{shiftRateStr || "0"}</span>
              {" + (4 × "}
              <span className="mono-num">{tier1Str || "0"}</span>
              {") = "}
              <b className="mono-num">{formatThousands(exampleTotal)} ₽</b>
            </div>
          </div>

          <TextArea
            id="c-note"
            label="Заметка"
            value={note}
            onChange={setNote}
            placeholder="Любая дополнительная информация…"
          />

          <button
            type="submit"
            disabled={loading || !name.trim() || (cardId !== "custom" && !positionKey)}
            className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-3 text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Создаём…" : "Создать осветителя"}
          </button>
        </form>
      )}

      {/* Rental form */}
      {step === "rental" && (
        <form onSubmit={handleSubmitRental} className="px-4 py-5 space-y-4">
          <p className="text-[12.5px] text-ink-3 -mt-1">
            Карточка субподрядчика по оборудованию. Ставок нет — суммы фиксируем по факту в проектах.
          </p>
          <TextField
            id="c-name"
            label="Название"
            required
            autoFocus
            value={name}
            onChange={setName}
            placeholder="Свет и Цвет"
          />
          <TextField
            id="c-phone"
            label="Телефон"
            type="tel"
            value={phone}
            onChange={setPhone}
            placeholder="+7 999 123-45-67"
          />
          <TextField
            id="c-telegram"
            label="Telegram"
            value={telegram}
            onChange={setTelegram}
            placeholder="@rental_house или t.me/…"
            error={errors.telegram}
            hint="@username или ссылка t.me/…"
          />
          <TextArea
            id="c-note"
            label="Заметка"
            value={note}
            onChange={setNote}
            placeholder="Условия, контакты менеджера, номенклатура…"
            rows={4}
          />
          <button
            type="submit"
            disabled={loading || !name.trim()}
            className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-3 text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Создаём…" : "Создать рентал"}
          </button>
        </form>
      )}
    </div>
  );
}

export default function GafferNewContactPage() {
  return (
    <Suspense fallback={
      <div className="p-4 space-y-3 animate-pulse">
        <div className="h-5 bg-border rounded w-1/2" />
        <div className="h-4 bg-border rounded w-1/3" />
      </div>
    }>
      <GafferNewContactContent />
    </Suspense>
  );
}
