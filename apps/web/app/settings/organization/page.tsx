"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { toast } from "../../../src/components/ToastProvider";
import { SectionHeader } from "../../../src/components/SectionHeader";
import { AdminTabNav } from "../../../src/components/admin/AdminTabNav";
import { CatalogTab } from "../../../src/components/settings/CatalogTab";
import { EquipmentImportTab } from "../../../src/components/settings/EquipmentImportTab";
import { PricelistTab } from "../../../src/components/settings/PricelistTab";

interface OrgSettings {
  id: string;
  legalName: string | null;
  inn: string | null;
  kpp: string | null;
  bankName: string | null;
  bankBik: string | null;
  rschet: string | null;
  kschet: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  invoiceNumberPrefix: string | null;
  migrationCutoffAt: string | null;
  defaultPaymentTermsDays: number | null;
}

const INPUT_CLASS =
  "w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent";
const INPUT_CLASS_MONO = `${INPUT_CLASS} font-mono`;
const FIELD_ERROR_CLASS = "text-xs text-rose mt-1";

/** ISO-строка или локальное значение → yyyy-MM-ddTHH:mm в ЛОКАЛЬНОМ времени для datetime-local */
function toLocalDatetimeValue(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** Пустая/пробельная строка → null (очистка nullable-поля на бэке) */
function emptyToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? null : trimmed;
}

type FieldErrorKey = "inn" | "bankBik" | "rschet" | "kschet" | "defaultPaymentTermsDays";
type FieldErrors = Partial<Record<FieldErrorKey, string>>;

function OrgSettingsForm({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const [form, setForm] = useState<Partial<OrgSettings>>({});
  // Хранится строкой: Number("") снапал бы очищенное поле в 0
  const [paymentTermsDays, setPaymentTermsDays] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    apiFetch<OrgSettings>("/api/settings/organization")
      .then((d) => {
        if (cancelled) return;
        setForm(d);
        setPaymentTermsDays(d.defaultPaymentTermsDays != null ? String(d.defaultPaymentTermsDays) : "");
        setDirty(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setLoadError(true);
        toast.error(e instanceof Error ? e.message : "Ошибка загрузки настроек");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  function set(key: keyof OrgSettings, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setDirty(true);
    setFieldErrors((prev) =>
      prev[key as FieldErrorKey] ? { ...prev, [key]: undefined } : prev,
    );
  }

  function validate(): boolean {
    const errors: FieldErrors = {};
    const inn = (form.inn ?? "").trim();
    if (inn !== "" && !/^\d{10}(\d{2})?$/.test(inn)) {
      errors.inn = "ИНН должен содержать 10 или 12 цифр";
    }
    const bik = (form.bankBik ?? "").trim();
    if (bik !== "" && !/^\d{9}$/.test(bik)) {
      errors.bankBik = "БИК должен содержать 9 цифр";
    }
    const rschet = (form.rschet ?? "").trim();
    if (rschet !== "" && !/^\d{20}$/.test(rschet)) {
      errors.rschet = "Расчётный счёт должен содержать 20 цифр";
    }
    const kschet = (form.kschet ?? "").trim();
    if (kschet !== "" && !/^\d{20}$/.test(kschet)) {
      errors.kschet = "Корр. счёт должен содержать 20 цифр";
    }
    const days = paymentTermsDays.trim();
    if (days !== "") {
      const n = Number(days);
      if (!Number.isInteger(n) || n < 0 || n > 90) {
        errors.defaultPaymentTermsDays = "Срок оплаты — целое число от 0 до 90";
      }
    }
    setFieldErrors(errors);
    return Object.keys(errors).length === 0;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) {
      toast.error("Проверьте выделенные поля");
      return;
    }
    setSaving(true);
    try {
      const days = paymentTermsDays.trim();
      const prefix = (form.invoiceNumberPrefix ?? "").trim();
      const updated = await apiFetch<OrgSettings>("/api/settings/organization", {
        method: "PATCH",
        body: JSON.stringify({
          legalName: (form.legalName ?? "").trim(),
          inn: (form.inn ?? "").trim(),
          kpp: emptyToNull(form.kpp),
          bankName: emptyToNull(form.bankName),
          bankBik: emptyToNull(form.bankBik),
          rschet: emptyToNull(form.rschet),
          kschet: emptyToNull(form.kschet),
          address: emptyToNull(form.address),
          phone: emptyToNull(form.phone),
          email: emptyToNull(form.email),
          invoiceNumberPrefix: prefix === "" ? undefined : prefix,
          migrationCutoffAt: form.migrationCutoffAt
            ? new Date(form.migrationCutoffAt).toISOString()
            : undefined,
          defaultPaymentTermsDays: days === "" ? undefined : Number(days),
        }),
      });
      // Ресинк формы из ответа сервера — сбрасывает dirty и нормализует значения
      setForm(updated);
      setPaymentTermsDays(
        updated.defaultPaymentTermsDays != null ? String(updated.defaultPaymentTermsDays) : "",
      );
      setDirty(false);
      toast.success("Настройки сохранены");
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Ошибка сохранения");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <div className="py-12 text-center text-ink-3 text-sm">Загрузка…</div>;
  }

  if (loadError) {
    return (
      <div className="py-12 text-center">
        <p className="text-sm text-ink-2 mb-3">Не удалось загрузить настройки организации.</p>
        <button
          type="button"
          onClick={() => setReloadKey((k) => k + 1)}
          className="px-4 py-2 text-sm border border-border rounded text-ink hover:bg-accent-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          Повторить
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="max-w-xl space-y-4">
      {/* Legal info */}
      <div className="bg-surface border border-border rounded-lg p-5 space-y-4">
        <p className="eyebrow text-ink-3 mb-1">Юридические данные</p>

        <div>
          <label htmlFor="org-legal-name" className="eyebrow block mb-1">Юр. имя</label>
          <input
            id="org-legal-name"
            type="text"
            className={INPUT_CLASS}
            value={form.legalName ?? ""}
            onChange={(e) => set("legalName", e.target.value)}
            placeholder="ООО «Свет Съёмки»"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="org-inn" className="eyebrow block mb-1">ИНН</label>
            <input
              id="org-inn"
              type="text"
              inputMode="numeric"
              className={INPUT_CLASS_MONO}
              value={form.inn ?? ""}
              onChange={(e) => set("inn", e.target.value)}
              placeholder="1234567890"
              maxLength={12}
            />
            {fieldErrors.inn && <p className={FIELD_ERROR_CLASS}>{fieldErrors.inn}</p>}
          </div>
          <div>
            <label htmlFor="org-kpp" className="eyebrow block mb-1">КПП</label>
            <input
              id="org-kpp"
              type="text"
              inputMode="numeric"
              className={INPUT_CLASS_MONO}
              value={form.kpp ?? ""}
              onChange={(e) => set("kpp", e.target.value)}
              placeholder="123456789"
              maxLength={9}
            />
          </div>
        </div>

        <div>
          <label htmlFor="org-address" className="eyebrow block mb-1">Адрес</label>
          <input
            id="org-address"
            type="text"
            className={INPUT_CLASS}
            value={form.address ?? ""}
            onChange={(e) => set("address", e.target.value)}
            placeholder="г. Москва, ул. Кинематографистов, д. 1"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label htmlFor="org-phone" className="eyebrow block mb-1">Телефон</label>
            <input
              id="org-phone"
              type="tel"
              className={INPUT_CLASS}
              value={form.phone ?? ""}
              onChange={(e) => set("phone", e.target.value)}
              placeholder="+7 495 000-00-00"
            />
          </div>
          <div>
            <label htmlFor="org-email" className="eyebrow block mb-1">Email</label>
            <input
              id="org-email"
              type="email"
              className={INPUT_CLASS}
              value={form.email ?? ""}
              onChange={(e) => set("email", e.target.value)}
              placeholder="info@company.ru"
            />
          </div>
        </div>
      </div>

      {/* Bank */}
      <div className="bg-surface border border-border rounded-lg p-5 space-y-4">
        <p className="eyebrow text-ink-3 mb-1">Банковские реквизиты</p>

        <div>
          <label htmlFor="org-bank-name" className="eyebrow block mb-1">Банк</label>
          <input
            id="org-bank-name"
            type="text"
            className={INPUT_CLASS}
            value={form.bankName ?? ""}
            onChange={(e) => set("bankName", e.target.value)}
            placeholder="АО «Тинькофф Банк»"
          />
        </div>

        <div>
          <label htmlFor="org-bik" className="eyebrow block mb-1">БИК</label>
          <input
            id="org-bik"
            type="text"
            inputMode="numeric"
            className={INPUT_CLASS_MONO}
            value={form.bankBik ?? ""}
            onChange={(e) => set("bankBik", e.target.value)}
            placeholder="044525974"
            maxLength={9}
          />
          {fieldErrors.bankBik && <p className={FIELD_ERROR_CLASS}>{fieldErrors.bankBik}</p>}
        </div>

        <div>
          <label htmlFor="org-rschet" className="eyebrow block mb-1">Расч. счёт</label>
          <input
            id="org-rschet"
            type="text"
            inputMode="numeric"
            className={INPUT_CLASS_MONO}
            value={form.rschet ?? ""}
            onChange={(e) => set("rschet", e.target.value)}
            placeholder="40702810012345678901"
            maxLength={20}
          />
          {fieldErrors.rschet && <p className={FIELD_ERROR_CLASS}>{fieldErrors.rschet}</p>}
        </div>

        <div>
          <label htmlFor="org-kschet" className="eyebrow block mb-1">Корр. счёт</label>
          <input
            id="org-kschet"
            type="text"
            inputMode="numeric"
            className={INPUT_CLASS_MONO}
            value={form.kschet ?? ""}
            onChange={(e) => set("kschet", e.target.value)}
            placeholder="30101810200000000974"
            maxLength={20}
          />
          {fieldErrors.kschet && <p className={FIELD_ERROR_CLASS}>{fieldErrors.kschet}</p>}
        </div>
      </div>

      {/* Invoice settings */}
      <div className="bg-surface border border-border rounded-lg p-5 space-y-4">
        <p className="eyebrow text-ink-3 mb-1">Нумерация счетов</p>

        <div>
          <label htmlFor="org-invoice-prefix" className="eyebrow block mb-1">Префикс номера счетов</label>
          <input
            id="org-invoice-prefix"
            type="text"
            className={INPUT_CLASS_MONO}
            value={form.invoiceNumberPrefix ?? ""}
            onChange={(e) => set("invoiceNumberPrefix", e.target.value)}
            placeholder="LR"
            maxLength={10}
          />
          <p className="text-xs text-ink-3 mt-1">Пример: LR-2026-0001</p>
        </div>

        <div>
          <label htmlFor="org-migration-cutoff" className="eyebrow block mb-1">Дата начала миграции</label>
          <input
            id="org-migration-cutoff"
            type="datetime-local"
            className={INPUT_CLASS}
            value={form.migrationCutoffAt ? toLocalDatetimeValue(form.migrationCutoffAt) : ""}
            onChange={(e) => set("migrationCutoffAt", e.target.value)}
          />
          <div className="mt-2 p-3 bg-amber-soft border border-amber-border rounded text-xs text-amber">
            Брони, созданные до этой даты, останутся в legacy-режиме. Не меняйте, если уже выпущены инвойсы.
          </div>
        </div>
      </div>

      {/* Finance policy */}
      <div className="bg-surface border border-border rounded-lg p-5 space-y-4">
        <p className="eyebrow text-ink-3 mb-1">Финансовая политика</p>

        <div>
          <label htmlFor="org-payment-terms" className="eyebrow block mb-1">Срок оплаты по умолчанию</label>
          <div className="flex items-center gap-2">
            <input
              id="org-payment-terms"
              type="number"
              inputMode="numeric"
              min={0}
              max={90}
              className="w-24 border border-border rounded px-3 py-2 text-sm bg-surface text-ink font-mono focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              value={paymentTermsDays}
              onChange={(e) => {
                setPaymentTermsDays(e.target.value);
                setDirty(true);
                setFieldErrors((prev) =>
                  prev.defaultPaymentTermsDays
                    ? { ...prev, defaultPaymentTermsDays: undefined }
                    : prev,
                );
              }}
            />
            <span className="text-sm text-ink-2">дн.</span>
          </div>
          {fieldErrors.defaultPaymentTermsDays && (
            <p className={FIELD_ERROR_CLASS}>{fieldErrors.defaultPaymentTermsDays}</p>
          )}
          <p className="text-xs text-ink-3 mt-1">
            0 = оплата в день сдачи · 7 = через неделю · 30 = через месяц. Применится к новым броням; существующие — через скрипт-бекфил.
          </p>
        </div>
      </div>

      {/* Save button */}
      <div className="flex justify-end pt-2">
        <button
          type="submit"
          disabled={saving}
          className="px-5 py-2.5 text-sm bg-accent-bright text-white rounded hover:opacity-90 disabled:opacity-50 font-medium"
        >
          {saving ? "Сохранение…" : "Сохранить"}
        </button>
      </div>
    </form>
  );
}

type SettingsTab = "org" | "catalog" | "import" | "pricelist";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "org", label: "Организация" },
  { id: "catalog", label: "Каталог" },
  { id: "import", label: "Импорт оборудования" },
  { id: "pricelist", label: "Прайслист бота" },
];

function PageGuard() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);
  const [tab, setTab] = useState<SettingsTab>("org");
  const orgDirtyRef = useRef(false);

  function switchTab(next: SettingsTab) {
    if (
      tab === "org" &&
      next !== "org" &&
      orgDirtyRef.current &&
      !window.confirm("Есть несохранённые изменения. Перейти без сохранения?")
    ) {
      return;
    }
    setTab(next);
  }

  if (loading || !authorized) return null;
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <div className="mb-4">
        <AdminTabNav />
      </div>
      <SectionHeader eyebrow="Система" title="Настройки" className="mb-5" />

      {/* Inner tabs: организация + инструменты, вынесенные из «Ещё» */}
      <div role="tablist" aria-label="Разделы настроек" className="flex gap-1 mb-6 border-b border-border overflow-x-auto">
        {SETTINGS_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => switchTab(t.id)}
            className={`px-3.5 py-2 text-sm border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === t.id ? "border-ink text-ink font-medium" : "border-transparent text-ink-2 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "org" && (
        <Suspense fallback={<div className="py-8 text-sm text-ink-3">Загрузка…</div>}>
          <OrgSettingsForm onDirtyChange={(d) => { orgDirtyRef.current = d; }} />
        </Suspense>
      )}
      {tab === "catalog" && <CatalogTab />}
      {tab === "import" && <EquipmentImportTab />}
      {tab === "pricelist" && <PricelistTab />}
    </div>
  );
}

export default function OrganizationSettingsRoute() {
  return <PageGuard />;
}
