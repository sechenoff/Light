"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { apiFetch } from "../../lib/api";
import { formatMoneyRub } from "../../lib/format";
import { toMoscowDateString } from "../../lib/moscowDate";
import { downloadEstimate, printEstimate } from "../../lib/estimateExport";
import { toast } from "../ToastProvider";
import { StatusPill } from "../StatusPill";
import { ClientAutocomplete } from "../bookings/create/ClientAutocomplete";

// ── Типы API ─────────────────────────────────────────────────────────────────

export type BillStatus = "ISSUED" | "PAID" | "CANCELLED";

export type BillPayer = {
  name: string;
  legalName: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  postalAddress: string | null;
  bankName: string | null;
  bankBik: string | null;
  rschet: string | null;
  kschet: string | null;
  phone: string | null;
  email: string | null;
};

export type BillLineDto = {
  id?: string;
  position?: number;
  name: string;
  unit: string;
  quantity: string;
  price: string;
  sum?: string;
};

export type BillDto = {
  id: string;
  year: number;
  number: number;
  date: string;
  status: BillStatus;
  clientId: string;
  clientName: string;
  bookingId: string | null;
  basis: string | null;
  taxNote: string | null;
  dueDate: string | null;
  total: string;
  payer: BillPayer;
  seller: { name: string; rschet: string | null; bankName: string | null };
  notes: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  lines: Array<Required<Pick<BillLineDto, "id" | "position" | "name" | "unit" | "quantity" | "price" | "sum">>>;
};

type PrefillDto = {
  bookingId: string;
  clientId: string;
  client: BillPayer & { id: string };
  basis: string | null;
  dueDate: string | null;
  lines: Array<{ name: string; unit: string; quantity: string; price: string }>;
  expectedTotal: string;
  paymentForm: string;
  taxNote: string | null;
};

type ClientRow = BillPayer & { id: string };

export const BILL_STATUS_LABELS: Record<BillStatus, string> = {
  ISSUED: "Выставлен",
  PAID: "Оплачен",
  CANCELLED: "Отменён",
};

export function billStatusVariant(s: BillStatus): "info" | "ok" | "none" {
  return s === "PAID" ? "ok" : s === "CANCELLED" ? "none" : "info";
}

const UNITS = ["усл. ед.", "шт.", "смена", "час", "день", "компл."];

type LegalKey = keyof Omit<BillPayer, "name">;
const LEGAL_FIELDS: Array<{ key: LegalKey; label: string; placeholder?: string; mono?: boolean; wide?: boolean }> = [
  { key: "legalName", label: "Полное наименование", placeholder: "ООО «Название» / ИП Фамилия И. О.", wide: true },
  { key: "inn", label: "ИНН", placeholder: "10 или 12 цифр", mono: true },
  { key: "kpp", label: "КПП", placeholder: "9 цифр (у ИП нет)", mono: true },
  { key: "ogrn", label: "ОГРН / ОГРНИП", placeholder: "13 или 15 цифр", mono: true },
  { key: "legalAddress", label: "Юридический адрес", wide: true },
  { key: "bankName", label: "Банк" },
  { key: "bankBik", label: "БИК", placeholder: "9 цифр", mono: true },
  { key: "rschet", label: "Расчётный счёт", placeholder: "20 цифр", mono: true },
  { key: "kschet", label: "Корр. счёт", placeholder: "20 цифр", mono: true },
  { key: "phone", label: "Телефон" },
  { key: "email", label: "E-mail" },
];

const EMPTY_LEGAL: Record<LegalKey, string> = {
  legalName: "", inn: "", kpp: "", ogrn: "", legalAddress: "", postalAddress: "",
  bankName: "", bankBik: "", rschet: "", kschet: "", phone: "", email: "",
};

type LineDraft = { key: string; name: string; unit: string; quantity: string; price: string };

const newLine = (init?: Partial<LineDraft>): LineDraft => ({
  key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  name: "",
  unit: "усл. ед.",
  quantity: "1",
  price: "",
  ...init,
});

/** «52 102,50» / «52102.5» → число; пустое — NaN. */
function parseNum(raw: string): number {
  const n = Number(raw.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : NaN;
}

function lineSum(l: LineDraft): number {
  const q = parseNum(l.quantity);
  const p = parseNum(l.price);
  if (!Number.isFinite(q) || !Number.isFinite(p)) return 0;
  return Math.round(q * p * 100) / 100;
}

function legalFromPayer(p: Partial<BillPayer> | null | undefined): Record<LegalKey, string> {
  const out = { ...EMPTY_LEGAL };
  if (!p) return out;
  for (const key of Object.keys(EMPTY_LEGAL) as LegalKey[]) out[key] = p[key] ?? "";
  return out;
}

const INPUT = "w-full rounded border border-border bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const INPUT_MONO = `${INPUT} font-mono`;

export type BillEditorProps =
  | { mode: "create"; bookingId?: string | null }
  | { mode: "edit"; billId: string };

/**
 * Редактор счёта на оплату: контрагент с реквизитами (пишутся в карточку
 * клиента), шапка документа, строки, итог. «Выставить и распечатать» создаёт
 * счёт и сразу отправляет PDF на печать — ради этого сервис и делался.
 */
export function BillEditor(props: BillEditorProps) {
  const router = useRouter();
  const isEdit = props.mode === "edit";
  const billId = isEdit ? props.billId : null;
  const bookingId = props.mode === "create" ? props.bookingId ?? null : null;

  const [loading, setLoading] = useState(true);
  const [bill, setBill] = useState<BillDto | null>(null);

  const [clientName, setClientName] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const [legal, setLegal] = useState<Record<LegalKey, string>>(EMPTY_LEGAL);
  const [legalOpen, setLegalOpen] = useState(false);

  const [number, setNumber] = useState("");
  const [nextNumber, setNextNumber] = useState<number | null>(null);
  const [date, setDate] = useState(() => toMoscowDateString(new Date()));
  const [dueDate, setDueDate] = useState("");
  const [basis, setBasis] = useState("");
  const [taxNote, setTaxNote] = useState<string | null>(null); // null — из настроек
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [linkedBookingId, setLinkedBookingId] = useState<string | null>(bookingId);
  const [expectedTotal, setExpectedTotal] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [statusBusy, setStatusBusy] = useState(false);
  const clientLookupSeq = useRef(0);

  // ── Загрузка ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (isEdit && billId) {
          const b = await apiFetch<BillDto>(`/api/bills/${billId}`);
          if (cancelled) return;
          setBill(b);
          setClientName(b.clientName);
          setClientId(b.clientId);
          setLegal(legalFromPayer(b.payer));
          setLegalOpen(Boolean(b.payer.inn || b.payer.legalName));
          setNumber(String(b.number));
          setDate(toMoscowDateString(new Date(b.date)));
          setDueDate(b.dueDate ? toMoscowDateString(new Date(b.dueDate)) : "");
          setBasis(b.basis ?? "");
          setTaxNote(b.taxNote);
          setNotes(b.notes ?? "");
          setLinkedBookingId(b.bookingId);
          setLines(b.lines.map((l) => newLine({ name: l.name, unit: l.unit, quantity: l.quantity, price: l.price })));
        } else {
          const nn = await apiFetch<{ year: number; number: number }>("/api/bills/next-number");
          if (cancelled) return;
          setNextNumber(nn.number);
          if (bookingId) {
            const pf = await apiFetch<PrefillDto>(`/api/bills/prefill?bookingId=${encodeURIComponent(bookingId)}`);
            if (cancelled) return;
            setClientName(pf.client.name);
            setClientId(pf.clientId);
            setLegal(legalFromPayer(pf.client));
            setLegalOpen(true);
            setBasis(pf.basis ?? "");
            setDueDate(pf.dueDate ? toMoscowDateString(new Date(pf.dueDate)) : "");
            setLines(pf.lines.length > 0 ? pf.lines.map((l) => newLine(l)) : [newLine()]);
            setExpectedTotal(pf.expectedTotal);
          }
        }
      } catch (e: unknown) {
        toast.error(e instanceof Error ? e.message : "Не удалось загрузить счёт");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isEdit, billId, bookingId]);

  // ── Реквизиты существующего контрагента подставляются по имени ──
  const lookupClient = useCallback(async (name: string) => {
    const seq = ++clientLookupSeq.current;
    const needle = name.trim().toLocaleLowerCase("ru");
    if (!needle) {
      setClientId(null);
      return;
    }
    try {
      const data = await apiFetch<{ clients: ClientRow[] }>(
        `/api/clients?search=${encodeURIComponent(name.trim())}&limit=50`,
      );
      if (seq !== clientLookupSeq.current) return;
      const list = data.clients ?? [];
      const exact = list.find((c) => c.name.trim().toLocaleLowerCase("ru") === needle) ?? null;
      setClientId(exact?.id ?? null);
      if (exact) {
        setLegal(legalFromPayer(exact));
        if (exact.inn || exact.legalName) setLegalOpen(true);
      }
    } catch {
      /* автокомплит уже показал ошибку сети; реквизиты заполнят руками */
    }
  }, []);

  useEffect(() => {
    if (isEdit) return;
    const t = setTimeout(() => void lookupClient(clientName), 250);
    return () => clearTimeout(t);
  }, [clientName, isEdit, lookupClient]);

  // ── Итоги ──
  const total = useMemo(() => Math.round(lines.reduce((acc, l) => acc + lineSum(l), 0) * 100) / 100, [lines]);
  const expectedMismatch =
    expectedTotal != null && Math.abs(Number(expectedTotal) - total) >= 0.01 ? Number(expectedTotal) : null;

  const lineErrors: Array<string | null> = lines.map((l) => {
    if (!l.name.trim()) return "название";
    const q = parseNum(l.quantity);
    if (!Number.isFinite(q) || q <= 0) return "количество";
    const p = parseNum(l.price);
    if (!Number.isFinite(p) || p < 0) return "цена";
    return null;
  });
  const canSubmit = clientName.trim().length > 0 && lines.length > 0 && lineErrors.every((e) => e === null) && !saving;
  const readOnly = bill?.status === "CANCELLED";

  function setLine(key: string, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function buildLegalPayload(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const key of Object.keys(EMPTY_LEGAL) as LegalKey[]) {
      const v = legal[key].trim();
      out[key] = v === "" ? null : v;
    }
    return out;
  }

  function buildLinesPayload() {
    return lines.map((l) => ({
      name: l.name.trim(),
      unit: l.unit,
      quantity: String(parseNum(l.quantity)),
      price: String(parseNum(l.price)),
    }));
  }

  async function save(andPrint: boolean): Promise<BillDto | null> {
    if (!canSubmit) return null;
    setSaving(true);
    try {
      const common = {
        date,
        dueDate: dueDate || null,
        basis: basis.trim() || null,
        notes: notes.trim() || null,
        lines: buildLinesPayload(),
        clientDetails: buildLegalPayload(),
        ...(taxNote !== null ? { taxNote: taxNote.trim() || null } : {}),
      };
      let saved: BillDto;
      if (isEdit && billId) {
        saved = await apiFetch<BillDto>(`/api/bills/${billId}`, {
          method: "PATCH",
          body: JSON.stringify({
            ...common,
            ...(number.trim() && Number(number) !== bill?.number ? { number: Number(number) } : {}),
          }),
        });
        setBill(saved);
        toast.success("Счёт сохранён");
      } else {
        saved = await apiFetch<BillDto>("/api/bills", {
          method: "POST",
          body: JSON.stringify({
            ...common,
            ...(clientId ? { clientId } : { client: { name: clientName.trim(), ...buildLegalPayload() } }),
            ...(number.trim() ? { number: Number(number) } : {}),
            bookingId: linkedBookingId,
          }),
        });
        toast.success(`Счёт № ${saved.number} выставлен`);
      }
      if (andPrint) await printEstimate(`/api/bills/${saved.id}/pdf`, "Счёт не найден");
      if (!isEdit) router.replace(`/finance/bills/${saved.id}`);
      return saved;
    } catch (e: unknown) {
      const err = e as { message?: string; code?: string };
      toast.error(err?.message ?? "Не удалось сохранить счёт");
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function setStatus(status: BillStatus) {
    if (!bill) return;
    setStatusBusy(true);
    try {
      const updated = await apiFetch<BillDto>(`/api/bills/${bill.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      setBill(updated);
      toast.success(status === "PAID" ? "Отмечен оплаченным" : status === "CANCELLED" ? "Счёт отменён" : "Счёт снова выставлен");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Не удалось сменить статус");
    } finally {
      setStatusBusy(false);
    }
  }

  if (loading) return <div className="p-6 text-sm text-ink-3">Загрузка…</div>;

  const title = isEdit && bill ? `Счёт № ${bill.number} от ${new Date(bill.date).toLocaleDateString("ru-RU")}` : "Новый счёт на оплату";

  return (
    <div className="p-4 lg:p-6">
      {/* Header */}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow text-ink-3">
            <Link href="/finance/bills" className="hover:text-ink">Счета на оплату</Link>
            {" · "}
            {isEdit ? "карточка" : "новый"}
          </p>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-[22px] font-semibold text-ink">
            {title}
            {bill && <StatusPill variant={billStatusVariant(bill.status)} label={BILL_STATUS_LABELS[bill.status]} />}
          </h1>
          {linkedBookingId && (
            <p className="mt-1 text-xs text-ink-3">
              По брони{" "}
              <Link href={`/bookings/${linkedBookingId}`} className="text-accent hover:underline">
                открыть карточку →
              </Link>
            </p>
          )}
        </div>
        {bill && (
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void printEstimate(`/api/bills/${bill.id}/pdf`, "Счёт не найден")}
              className="rounded bg-accent-bright px-3.5 py-2 text-[13px] font-semibold text-surface hover:opacity-90"
            >
              Печать
            </button>
            <button
              type="button"
              onClick={() => void downloadEstimate(`/api/bills/${bill.id}/pdf`, `schet-${bill.number}-${bill.year}.pdf`, "Счёт не найден")}
              className="rounded border border-border px-3.5 py-2 text-[13px] text-ink-2 hover:bg-surface-muted"
            >
              Скачать PDF
            </button>
            {bill.status === "ISSUED" && (
              <button
                type="button"
                disabled={statusBusy}
                onClick={() => void setStatus("PAID")}
                className="rounded border border-emerald-border bg-emerald-soft px-3.5 py-2 text-[13px] text-emerald hover:opacity-90 disabled:opacity-50"
              >
                Оплачен
              </button>
            )}
            {bill.status === "PAID" && (
              <button
                type="button"
                disabled={statusBusy}
                onClick={() => void setStatus("ISSUED")}
                className="rounded border border-border px-3.5 py-2 text-[13px] text-ink-2 hover:bg-surface-muted disabled:opacity-50"
              >
                Вернуть в «Выставлен»
              </button>
            )}
            {bill.status !== "CANCELLED" && (
              <button
                type="button"
                disabled={statusBusy}
                onClick={() => {
                  if (window.confirm(`Отменить счёт № ${bill.number}? Номер останется занятым, документ станет недействительным.`)) {
                    void setStatus("CANCELLED");
                  }
                }}
                className="rounded border border-rose-border px-3.5 py-2 text-[13px] text-rose hover:bg-rose-soft disabled:opacity-50"
              >
                Отменить
              </button>
            )}
          </div>
        )}
      </div>

      {readOnly && (
        <div className="mb-4 rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm text-ink-2">
          Счёт отменён — правки закрыты. Нужен новый документ — выставьте новый счёт.
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
        className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]"
      >
        <div className="space-y-4">
          {/* Контрагент */}
          <section className="rounded-lg border border-border bg-surface p-5 shadow-xs">
            <div className="mb-3 flex items-center justify-between">
              <p className="eyebrow text-ink-3">Покупатель (плательщик)</p>
              {clientId && <span className="text-[11px] text-emerald">✓ контрагент в базе</span>}
            </div>
            <label htmlFor="bill-client" className="eyebrow mb-1 block">Контрагент</label>
            <ClientAutocomplete
              id="bill-client"
              value={clientName}
              onChange={setClientName}
              // По брони контрагент задан самой бронью; у выставленного счёта он не меняется.
              readOnly={isEdit || Boolean(bookingId)}
              placeholder="Название компании или имя"
              autoFocus={!isEdit && !bookingId}
            />
            <button
              type="button"
              onClick={() => setLegalOpen((v) => !v)}
              className="mt-3 text-[12.5px] text-accent hover:underline"
            >
              {legalOpen ? "Скрыть реквизиты" : "Реквизиты для счёта (ИНН, банк, адрес)"}
            </button>
            {legalOpen && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                {LEGAL_FIELDS.map((f) => (
                  <div key={f.key} className={f.wide ? "sm:col-span-2" : ""}>
                    <label htmlFor={`bill-${f.key}`} className="eyebrow mb-1 block">{f.label}</label>
                    <input
                      id={`bill-${f.key}`}
                      type="text"
                      inputMode={f.mono ? "numeric" : undefined}
                      className={f.mono ? INPUT_MONO : INPUT}
                      placeholder={f.placeholder}
                      value={legal[f.key]}
                      disabled={readOnly}
                      onChange={(e) => setLegal((prev) => ({ ...prev, [f.key]: e.target.value }))}
                    />
                  </div>
                ))}
                <p className="text-xs text-ink-3 sm:col-span-2">
                  Реквизиты сохраняются в карточке клиента — следующий счёт этому контрагенту подставит их сам.
                  Для физлица можно оставить пустыми: в бланке напечатается только имя.
                </p>
              </div>
            )}
          </section>

          {/* Позиции */}
          <section className="rounded-lg border border-border bg-surface p-5 shadow-xs">
            <p className="eyebrow mb-3 text-ink-3">Товары и услуги</p>
            <div className="space-y-2">
              {/* Одна строка на позицию — только на широких экранах (xl): левая колонка
                  страницы ≈ 480 px при боковом меню, и шесть колонок в неё не встают. */}
              <div className="hidden grid-cols-[minmax(0,1fr)_72px_96px_112px_104px_24px] gap-2 px-1 text-[11px] text-ink-3 xl:grid">
                <span>Наименование</span>
                <span className="text-right">Кол-во</span>
                <span>Ед.</span>
                <span className="text-right">Цена, ₽</span>
                <span className="text-right">Сумма</span>
                <span />
              </div>
              {lines.map((l, i) => (
                <div
                  key={l.key}
                  className="grid grid-cols-[minmax(0,1fr)_72px_96px_112px_88px_24px] gap-2 rounded border border-border p-2 xl:grid-cols-[minmax(0,1fr)_72px_96px_112px_104px_24px] xl:items-center xl:border-0 xl:p-0"
                >
                  <input
                    type="text"
                    aria-label={`Наименование позиции ${i + 1}`}
                    className={`${INPUT} col-span-6 xl:col-span-1`}
                    placeholder="Аренда светового оборудования 10–12.09.2026"
                    value={l.name}
                    disabled={readOnly}
                    onChange={(e) => setLine(l.key, { name: e.target.value })}
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="Количество"
                    className={`${INPUT_MONO} text-right`}
                    value={l.quantity}
                    disabled={readOnly}
                    onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                  />
                  <select
                    aria-label="Единица"
                    className={INPUT}
                    value={l.unit}
                    disabled={readOnly}
                    onChange={(e) => setLine(l.key, { unit: e.target.value })}
                  >
                    {(UNITS.includes(l.unit) ? UNITS : [l.unit, ...UNITS]).map((u) => (
                      <option key={u} value={u}>{u}</option>
                    ))}
                  </select>
                  <input
                    type="text"
                    inputMode="decimal"
                    aria-label="Цена"
                    className={`${INPUT_MONO} text-right`}
                    placeholder="0"
                    value={l.price}
                    disabled={readOnly}
                    onChange={(e) => setLine(l.key, { price: e.target.value })}
                  />
                  <div className="mono-num text-right text-sm text-ink">{formatMoneyRub(lineSum(l))}</div>
                  <button
                    type="button"
                    aria-label="Удалить позицию"
                    disabled={readOnly || lines.length === 1}
                    onClick={() => setLines((prev) => prev.filter((x) => x.key !== l.key))}
                    className="text-ink-3 hover:text-rose disabled:opacity-30"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            {!readOnly && (
              <button
                type="button"
                onClick={() => setLines((prev) => [...prev, newLine()])}
                className="mt-3 text-[12.5px] text-accent hover:underline"
              >
                + Добавить позицию
              </button>
            )}
          </section>

          {/* Шапка документа */}
          <section className="rounded-lg border border-border bg-surface p-5 shadow-xs">
            <p className="eyebrow mb-3 text-ink-3">Документ</p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <label htmlFor="bill-number" className="eyebrow mb-1 block">Номер</label>
                <input
                  id="bill-number"
                  type="number"
                  min={1}
                  className={INPUT_MONO}
                  placeholder={nextNumber != null ? `авто: ${nextNumber}` : ""}
                  value={number}
                  disabled={readOnly}
                  onChange={(e) => setNumber(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="bill-date" className="eyebrow mb-1 block">Дата</label>
                <input id="bill-date" type="date" className={INPUT_MONO} value={date} disabled={readOnly} onChange={(e) => setDate(e.target.value)} />
              </div>
              <div>
                <label htmlFor="bill-due" className="eyebrow mb-1 block">Оплатить до</label>
                <input id="bill-due" type="date" className={INPUT_MONO} value={dueDate} disabled={readOnly} onChange={(e) => setDueDate(e.target.value)} />
              </div>
              <div className="sm:col-span-3">
                <label htmlFor="bill-basis" className="eyebrow mb-1 block">Основание</label>
                <input
                  id="bill-basis"
                  type="text"
                  className={INPUT}
                  placeholder="Договор № 12 от 01.09.2026 / Смета № СМ-2026-0031"
                  value={basis}
                  disabled={readOnly}
                  onChange={(e) => setBasis(e.target.value)}
                />
              </div>
              <div className="sm:col-span-3">
                <label htmlFor="bill-tax" className="eyebrow mb-1 block">Пометка о налоге</label>
                <input
                  id="bill-tax"
                  type="text"
                  className={INPUT}
                  placeholder="из настроек организации (например, «Без НДС (УСН)»)"
                  value={taxNote ?? ""}
                  disabled={readOnly}
                  onChange={(e) => setTaxNote(e.target.value)}
                />
              </div>
              <div className="sm:col-span-3">
                <label htmlFor="bill-notes" className="eyebrow mb-1 block">Примечание в счёте</label>
                <textarea
                  id="bill-notes"
                  rows={2}
                  className={INPUT}
                  placeholder="Печатается под назначением платежа"
                  value={notes}
                  disabled={readOnly}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
          </section>
        </div>

        {/* Итог */}
        <aside className="lg:sticky lg:top-20 flex flex-col gap-3 self-start rounded-lg border border-border bg-surface p-4 shadow-xs">
          <p className="eyebrow text-ink-3">Итого к оплате</p>
          <div className="flex items-baseline gap-1">
            <span className="font-mono text-[30px] font-semibold leading-none text-ink">
              {Math.round(total).toLocaleString("ru-RU")}
            </span>
            <span className="text-[18px] text-ink-3">₽</span>
          </div>
          <p className="text-xs text-ink-3">
            {lines.length} {lines.length === 1 ? "позиция" : lines.length < 5 ? "позиции" : "позиций"} · {formatMoneyRub(total)}
          </p>
          {expectedMismatch != null && (
            <p className="rounded border border-amber-border bg-amber-soft px-2 py-1.5 text-[11.5px] leading-snug text-ink-2">
              По брони к оплате {formatMoneyRub(expectedMismatch)} — строки счёта дают другую сумму. Проверьте, что это намеренно.
            </p>
          )}
          {!readOnly && (
            <div className="flex flex-col gap-2 pt-1">
              {isEdit ? (
                <>
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full rounded bg-accent-bright px-4 py-2.5 text-sm font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {saving ? "Сохранение…" : "Сохранить изменения"}
                  </button>
                  <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => void save(true)}
                    className="w-full rounded border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-surface-muted disabled:opacity-40"
                  >
                    Сохранить и распечатать
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!canSubmit}
                    onClick={() => void save(true)}
                    className="w-full rounded bg-accent-bright px-4 py-2.5 text-sm font-medium text-surface hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {saving ? "Выставляю…" : "Выставить и распечатать →"}
                  </button>
                  <button
                    type="submit"
                    disabled={!canSubmit}
                    className="w-full rounded border border-border bg-surface px-4 py-2.5 text-sm font-medium text-ink-2 hover:bg-surface-muted disabled:opacity-40"
                  >
                    Выставить без печати
                  </button>
                </>
              )}
              <Link
                href="/finance/bills"
                className="w-full rounded px-4 py-2 text-center text-sm text-ink-3 hover:text-ink"
              >
                К списку
              </Link>
            </div>
          )}
          {lineErrors.some((e) => e !== null) && (
            <p className="text-[11.5px] text-ink-3">
              Заполните {lineErrors.filter((e) => e !== null).length === 1 ? "поле" : "поля"}:{" "}
              {Array.from(new Set(lineErrors.filter((e): e is string => e !== null))).join(", ")}.
            </p>
          )}
          {bill?.seller && (
            <p className="border-t border-border pt-3 text-[11.5px] text-ink-3">
              Получатель: {bill.seller.name}
              {bill.seller.rschet ? ` · р/с ${bill.seller.rschet}` : " · банковские реквизиты не заполнены — QR в счёте не печатается"}
            </p>
          )}
        </aside>
      </form>
    </div>
  );
}
