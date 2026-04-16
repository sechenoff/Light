"use client";

import { useRequireRole } from "@/hooks/useRequireRole";
import { AdminTabNav } from "@/components/admin/AdminTabNav";

// ── Toggle component (visual only) ───────────────────────────────────────────

function Toggle({ on }: { on: boolean }) {
  return (
    <div
      aria-label={on ? "включено" : "выключено"}
      className={[
        "relative w-8 h-[18px] rounded-full transition-colors shrink-0",
        on ? "bg-emerald" : "bg-border",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white shadow-sm transition-transform",
          on ? "translate-x-[18px]" : "translate-x-0.5",
        ].join(" ")}
      />
    </div>
  );
}

// ── SettingsCard ──────────────────────────────────────────────────────────────

interface SettingsRow {
  label: string;
  description?: string;
  value?: string;
  toggle?: boolean;
  toggleOn?: boolean;
  link?: string;
}

interface SettingsCardProps {
  icon: string;
  title: string;
  rows: SettingsRow[];
  danger?: boolean;
  fullWidth?: boolean;
}

function SettingsCard({ icon, title, rows, danger }: SettingsCardProps) {
  return (
    <div
      className={[
        "bg-surface border rounded-lg overflow-hidden shadow-xs",
        danger ? "border-rose-border" : "border-border",
      ].join(" ")}
    >
      {/* Card header */}
      <div
        className={[
          "px-4 py-3 border-b flex items-center gap-2",
          danger ? "bg-rose-soft border-rose-border" : "bg-surface-2 border-border",
        ].join(" ")}
      >
        <span className="text-base">{icon}</span>
        <span className="eyebrow">{title}</span>
      </div>

      {/* Card body */}
      <div className="px-5 py-4">
        {rows.map((row, idx) => (
          <div
            key={idx}
            className="flex justify-between items-center py-2 border-b border-border last:border-b-0"
          >
            {/* Label */}
            <div className="space-y-0.5 flex-1 min-w-0 pr-4">
              <div className="text-sm text-ink">{row.label}</div>
              {row.description && (
                <div className="text-xs text-ink-3">{row.description}</div>
              )}
            </div>

            {/* Value / Toggle */}
            <div className="flex items-center gap-3 shrink-0">
              {row.toggle !== undefined ? (
                <Toggle on={row.toggleOn ?? false} />
              ) : (
                <>
                  {row.value && (
                    <span className="mono-num text-xs text-ink-2 font-mono">{row.value}</span>
                  )}
                  {row.link && (
                    <button onClick={() => alert("Настройки пока только для чтения")} className="text-xs text-accent hover:text-accent-bright transition-colors">
                      {row.link}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── DangerRow ─────────────────────────────────────────────────────────────────

function DangerRow({ label, description, action }: { label: string; description: string; action: string }) {
  return (
    <div className="flex justify-between items-center py-3 border-b border-border last:border-b-0">
      <div className="space-y-0.5">
        <div className="text-sm text-ink">{label}</div>
        <div className="text-xs text-ink-3">{description}</div>
      </div>
      <button
        onClick={() => alert("Недоступно в демо-режиме")}
        className="text-xs text-rose hover:text-rose/80 border border-rose-border bg-rose-soft px-3 py-1.5 rounded-lg transition-colors"
      >
        {action}
      </button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function AdminSettingsPage() {
  const { authorized, loading } = useRequireRole(["SUPER_ADMIN"]);

  if (loading) {
    return (
      <div className="p-6">
        <AdminTabNav />
        <div className="mt-6 grid grid-cols-1 lg:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-48 bg-surface-2 rounded-lg animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  if (!authorized) return null;

  return (
    <div className="p-6 space-y-6">
      <AdminTabNav />

      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold text-ink">Настройки</h1>
        <p className="text-sm text-ink-2 mt-0.5">
          Параметры системы. Большинство значений задаются в конфигурации сервера.
        </p>
      </div>

      {/* 2-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Card 1: Организация */}
        <SettingsCard
          icon="🏢"
          title="Организация"
          rows={[
            { label: "Название", value: "Light Rental", link: "Изменить" },
            { label: "Валюта", value: "RUB — Российский рубль" },
            { label: "Часовой пояс", value: "Europe/Moscow (UTC+3)" },
            { label: "Рабочие часы", value: "09:00 – 21:00", link: "Изменить" },
          ]}
        />

        {/* Card 2: Распознавание и AI */}
        <SettingsCard
          icon="🤖"
          title="Распознавание и AI"
          rows={[
            { label: "Провайдер видения", value: "Gemini 2.5 Flash" },
            {
              label: "Автосохранение алиасов",
              description: "Новые совпадения сохраняются как слэнг автоматически",
              toggle: true,
              toggleOn: true,
            },
            { label: "Мин. уверенность совпадения", value: "0.65", link: "Изменить" },
            {
              label: "Анализ фото в заявках",
              description: "Разбирать фото гафер-листов через Gemini",
              toggle: true,
              toggleOn: true,
            },
          ]}
        />

        {/* Card 3: Telegram-бот */}
        <SettingsCard
          icon="✈️"
          title="Telegram-бот"
          rows={[
            { label: "Клиентский бот", value: "● активен", link: "Управление" },
            {
              label: "Уведомления менеджерам",
              description: "Отправлять уведомления при новых заявках",
              toggle: true,
              toggleOn: true,
            },
            { label: "API-ключ бота", value: "***…***", link: "Обновить" },
          ]}
        />

        {/* Card 4: Финансовые правила */}
        <SettingsCard
          icon="💰"
          title="Финансовые правила"
          rows={[
            {
              label: "Авто-подтверждение до",
              description: "Брони ниже суммы подтверждаются без согласования",
              value: "не задано",
              link: "Задать",
            },
            {
              label: "Лояльность (скидка)",
              description: "Скидка постоянным клиентам",
              value: "0%",
              link: "Изменить",
            },
            { label: "Отсрочка оплаты", value: "7 дней", link: "Изменить" },
            {
              label: "Напоминание о просрочке",
              description: "Автоматически напоминать в Telegram",
              toggle: true,
              toggleOn: false,
            },
          ]}
        />
      </div>

      {/* Danger zone (full width) */}
      <div className="border border-rose-border rounded-lg overflow-hidden shadow-xs">
        <div className="px-4 py-3 bg-rose-soft border-b border-rose-border flex items-center gap-2">
          <span className="text-base">⚠️</span>
          <span className="eyebrow text-rose">Опасная зона</span>
        </div>
        <div className="px-5 py-4">
          <DangerRow
            label="Очистить словарь сленга"
            description="Удалит все алиасы и связки. Восстановление невозможно."
            action="Очистить"
          />
          <DangerRow
            label="Экспорт базы данных"
            description="Скачать резервную копию SQLite (.db)"
            action="Скачать"
          />
        </div>
      </div>
    </div>
  );
}
