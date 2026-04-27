"use client";

import { Suspense, useEffect, useState } from "react";
import { useRequireRole } from "../../../src/hooks/useRequireRole";
import { apiFetch } from "../../../src/lib/api";
import { toast } from "../../../src/components/ToastProvider";

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

function OrgSettingsForm() {
  const [form, setForm] = useState<Partial<OrgSettings>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<OrgSettings>("/api/settings/organization")
      .then((d) => { if (!cancelled) setForm(d); })
      .catch((e: unknown) => {
        if (!cancelled) toast.error(e instanceof Error ? e.message : "Ошибка загрузки настроек");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  function set(key: keyof OrgSettings, value: string | number) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiFetch("/api/settings/organization", {
        method: "PATCH",
        body: JSON.stringify({
          legalName: form.legalName ?? undefined,
          inn: form.inn ?? undefined,
          kpp: form.kpp ?? undefined,
          bankName: form.bankName ?? undefined,
          bankBik: form.bankBik ?? undefined,
          rschet: form.rschet ?? undefined,
          kschet: form.kschet ?? undefined,
          address: form.address ?? undefined,
          phone: form.phone ?? undefined,
          email: form.email ?? undefined,
          invoiceNumberPrefix: form.invoiceNumberPrefix ?? undefined,
          migrationCutoffAt: form.migrationCutoffAt
            ? new Date(form.migrationCutoffAt).toISOString()
            : undefined,
          defaultPaymentTermsDays:
            form.defaultPaymentTermsDays != null ? Number(form.defaultPaymentTermsDays) : undefined,
        }),
      });
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

  return (
    <form onSubmit={handleSave} className="max-w-xl space-y-4">
      {/* Legal info */}
      <div className="bg-surface border border-border rounded-lg p-5 space-y-4">
        <p className="eyebrow text-ink-3 mb-1">Юридические данные</p>

        <div>
          <label className="eyebrow block mb-1">Юр. имя</label>
          <input
            type="text"
            className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
            value={form.legalName ?? ""}
            onChange={(e) => set("legalName", e.target.value)}
            placeholder="ООО «Свет Съёмки»"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="eyebrow block mb-1">ИНН</label>
            <input
              type="text"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink font-mono"
              value={form.inn ?? ""}
              onChange={(e) => set("inn", e.target.value)}
              placeholder="1234567890"
              maxLength={12}
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">КПП</label>
            <input
              type="text"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink font-mono"
              value={form.kpp ?? ""}
              onChange={(e) => set("kpp", e.target.value)}
              placeholder="123456789"
              maxLength={9}
            />
          </div>
        </div>

        <div>
          <label className="eyebrow block mb-1">Адрес</label>
          <input
            type="text"
            className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
            value={form.address ?? ""}
            onChange={(e) => set("address", e.target.value)}
            placeholder="г. Москва, ул. Кинематографистов, д. 1"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="eyebrow block mb-1">Телефон</label>
            <input
              type="tel"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
              value={form.phone ?? ""}
              onChange={(e) => set("phone", e.target.value)}
              placeholder="+7 495 000-00-00"
            />
          </div>
          <div>
            <label className="eyebrow block mb-1">Email</label>
            <input
              type="email"
              className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
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
          <label className="eyebrow block mb-1">Банк</label>
          <input
            type="text"
            className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
            value={form.bankName ?? ""}
            onChange={(e) => set("bankName", e.target.value)}
            placeholder="АО «Тинькофф Банк»"
          />
        </div>

        <div>
          <label className="eyebrow block mb-1">БИК</label>
          <input
            type="text"
            className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink font-mono"
            value={form.bankBik ?? ""}
            onChange={(e) => set("bankBik", e.target.value)}
            placeholder="044525974"
            maxLength={9}
          />
        </div>

        <div>
          <label className="eyebrow block mb-1">Расч. счёт</label>
          <input
            type="text"
            className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink font-mono"
            value={form.rschet ?? ""}
            onChange={(e) => set("rschet", e.target.value)}
            placeholder="40702810012345678901"
            maxLength={20}
          />
        </div>

        <div>
          <label className="eyebrow block mb-1">Корр. счёт</label>
          <input
            type="text"
            className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink font-mono"
            value={form.kschet ?? ""}
            onChange={(e) => set("kschet", e.target.value)}
            placeholder="30101810200000000974"
            maxLength={20}
          />
        </div>
      </div>

      {/* Invoice settings */}
      <div className="bg-surface border border-border rounded-lg p-5 space-y-4">
        <p className="eyebrow text-ink-3 mb-1">Нумерация счетов</p>

        <div>
          <label className="eyebrow block mb-1">Префикс номера счетов</label>
          <input
            type="text"
            className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink font-mono"
            value={form.invoiceNumberPrefix ?? ""}
            onChange={(e) => set("invoiceNumberPrefix", e.target.value)}
            placeholder="LR"
            maxLength={10}
          />
          <p className="text-xs text-ink-3 mt-1">Пример: LR-2026-0001</p>
        </div>

        <div>
          <label className="eyebrow block mb-1">Дата начала миграции</label>
          <input
            type="datetime-local"
            className="w-full border border-border rounded px-3 py-2 text-sm bg-surface text-ink"
            value={form.migrationCutoffAt
              ? new Date(form.migrationCutoffAt).toISOString().slice(0, 16)
              : ""}
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
          <label className="eyebrow block mb-1">Срок оплаты по умолчанию</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={90}
              className="w-24 border border-border rounded px-3 py-2 text-sm bg-surface text-ink font-mono"
              value={form.defaultPaymentTermsDays ?? 7}
              onChange={(e) => set("defaultPaymentTermsDays", parseInt(e.target.value, 10) || 0)}
            />
            <span className="text-sm text-ink-2">дн.</span>
          </div>
          <p className="text-xs text-ink-3 mt-1">
            Через сколько дней после возврата ожидается оплата. Применится к новым броням; существующие — через скрипт-бекфил.
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

function PageGuard() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);
  if (loading || !authorized) return null;
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
      <p className="eyebrow text-ink-3 mb-1">Настройки</p>
      <h1 className="text-xl font-semibold text-ink mb-6">Организация</h1>
      <Suspense fallback={<div className="py-8 text-sm text-ink-3">Загрузка…</div>}>
        <OrgSettingsForm />
      </Suspense>
    </div>
  );
}

export default function OrganizationSettingsRoute() {
  return <PageGuard />;
}
