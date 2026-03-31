"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { apiFetch } from "../../src/lib/api";

const SESSION_KEY = "settings_auth";
const ADMIN_PWD = "4020909";

type PricelistMeta =
  | { exists: false }
  | { exists: true; filename: string; size: number; uploadedAt: string };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

/* ─── Экран входа ─── */
function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [pwd, setPwd] = useState("");
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pwd === ADMIN_PWD) {
      sessionStorage.setItem(SESSION_KEY, "1");
      onSuccess();
    } else {
      setError(true);
      setPwd("");
      setTimeout(() => setError(false), 2000);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-8">
          <div className="flex flex-col items-center mb-6">
            <div className="w-14 h-14 rounded-2xl bg-slate-900 flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <h1 className="text-xl font-semibold text-slate-800">Настройки</h1>
            <p className="text-sm text-slate-500 mt-1 text-center">Введите пароль администратора</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <input
                ref={inputRef}
                type="password"
                value={pwd}
                onChange={(e) => setPwd(e.target.value)}
                placeholder="Пароль"
                className={`w-full px-4 py-3 rounded-xl border text-sm transition-colors outline-none ${
                  error
                    ? "border-red-300 bg-red-50 text-red-700 placeholder-red-300"
                    : "border-slate-300 bg-white text-slate-800 placeholder-slate-400 focus:border-slate-500"
                }`}
              />
              {error && (
                <p className="mt-2 text-xs text-red-600 text-center">Неверный пароль</p>
              )}
            </div>
            <button
              type="submit"
              className="w-full bg-slate-900 hover:bg-slate-700 text-white font-medium text-sm py-3 rounded-xl transition-colors"
            >
              Войти
            </button>
          </form>

          <div className="mt-4 text-center">
            <Link href="/equipment" className="text-xs text-slate-400 hover:text-slate-600 transition-colors">
              ← Вернуться назад
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Основная страница ─── */
function SettingsContent({ onLogout }: { onLogout: () => void }) {
  const [meta, setMeta] = useState<PricelistMeta | null>(null);
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadMeta() {
    try {
      const data = await apiFetch<PricelistMeta>("/api/pricelist");
      setMeta(data);
    } catch {
      setMeta({ exists: false });
    }
  }

  useEffect(() => { loadMeta(); }, []);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      await apiFetch("/api/pricelist", { method: "POST", body: form });
      setMessage({ type: "ok", text: `Файл «${file.name}» успешно загружен` });
      await loadMeta();
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : "Ошибка загрузки" });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function handleDelete() {
    if (!confirm("Удалить прайслист?")) return;
    setDeleting(true);
    setMessage(null);
    try {
      await apiFetch("/api/pricelist", { method: "DELETE" });
      setMessage({ type: "ok", text: "Прайслист удалён" });
      await loadMeta();
    } catch (err) {
      setMessage({ type: "err", text: err instanceof Error ? err.message : "Ошибка удаления" });
    } finally {
      setDeleting(false);
    }
  }

  function handleLogout() {
    sessionStorage.removeItem(SESSION_KEY);
    onLogout();
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/equipment" className="text-slate-500 hover:text-slate-800 transition-colors text-sm">
            ← Назад
          </Link>
          <h1 className="text-xl font-semibold text-slate-800">Настройки</h1>
        </div>
        <button
          onClick={handleLogout}
          className="text-xs text-slate-400 hover:text-slate-600 transition-colors"
        >
          Выйти
        </button>
      </header>

      <main className="max-w-2xl mx-auto px-6 py-8 space-y-6">

        {/* Навигация по разделам */}
        <section className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-800 mb-4">Разделы</h2>
          <div className="grid grid-cols-2 gap-3">
            <Link
              href="/finance"
              className="flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 transition-colors"
            >
              <span className="text-xl">💰</span>
              <div>
                <div className="text-sm font-medium text-slate-800">Финансы</div>
                <div className="text-xs text-slate-500">Доходы и расходы</div>
              </div>
            </Link>
            <Link
              href="/crew-calculator"
              className="flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 transition-colors"
            >
              <span className="text-xl">🧮</span>
              <div>
                <div className="text-sm font-medium text-slate-800">Калькулятор</div>
                <div className="text-xs text-slate-500">Расчёт ставок осветителей</div>
              </div>
            </Link>
            <Link
              href="/ops"
              className="flex items-center gap-3 px-4 py-3 rounded-xl border border-indigo-200 bg-indigo-50 hover:bg-indigo-100 transition-colors"
            >
              <span className="text-xl">🤖</span>
              <div>
                <div className="text-sm font-medium text-indigo-800">Ops Dashboard</div>
                <div className="text-xs text-indigo-600">Задачи и координация команды</div>
              </div>
            </Link>
            <Link
              href="/bookings"
              className="flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-200 hover:bg-slate-50 transition-colors"
            >
              <span className="text-xl">📋</span>
              <div>
                <div className="text-sm font-medium text-slate-800">Брони</div>
                <div className="text-xs text-slate-500">Список бронирований</div>
              </div>
            </Link>
          </div>
        </section>

        {/* Редактор оборудования */}
        <section className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-800 mb-1">Каталог оборудования</h2>
          <p className="text-sm text-slate-500 mb-5">
            Добавление, редактирование и удаление позиций оборудования, управление категориями и ценами.
          </p>
          <Link
            href="/equipment/manage"
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-slate-900 hover:bg-slate-700 text-white text-sm font-medium rounded-xl transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
            Открыть редактор
          </Link>
        </section>

        {/* Прайслист */}
        <section className="bg-white rounded-2xl border border-slate-200 p-6 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-800 mb-1">Прайслист для Telegram-бота</h2>
          <p className="text-sm text-slate-500 mb-5">
            Файл будет предложен пользователю бота когда он не может найти нужное оборудование.
            Поддерживаются PDF, Excel (.xlsx), Word (.docx) и другие форматы.
          </p>

          {message && (
            <div className={`mb-4 px-4 py-3 rounded-lg text-sm font-medium ${
              message.type === "ok"
                ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                : "bg-red-50 text-red-700 border border-red-200"
            }`}>
              {message.text}
            </div>
          )}

          {meta === null ? (
            <div className="text-sm text-slate-400 py-4">Загрузка…</div>
          ) : meta.exists ? (
            <div className="flex items-center justify-between gap-4 p-4 bg-slate-50 rounded-xl border border-slate-200 mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-lg bg-blue-100 flex items-center justify-center flex-shrink-0">
                  <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 truncate">{meta.filename}</div>
                  <div className="text-xs text-slate-500">
                    {formatBytes(meta.size)} · Загружен {formatDate(meta.uploadedAt)}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <a
                  href="/api/pricelist/file"
                  className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 hover:bg-blue-100 rounded-lg transition-colors"
                >
                  Скачать
                </a>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-3 py-1.5 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-lg transition-colors disabled:opacity-50"
                >
                  {deleting ? "Удаление…" : "Удалить"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 p-4 bg-amber-50 rounded-xl border border-amber-200 mb-4">
              <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span className="text-sm text-amber-700">Прайслист не загружен. Бот не сможет его отправить клиентам.</span>
            </div>
          )}

          <label className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer transition-colors ${
            uploading
              ? "bg-slate-100 text-slate-400 cursor-not-allowed"
              : "bg-slate-800 hover:bg-slate-700 text-white"
          }`}>
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
            </svg>
            {uploading ? "Загрузка…" : meta?.exists ? "Заменить файл" : "Загрузить прайслист"}
            <input
              ref={fileRef}
              type="file"
              className="hidden"
              accept=".pdf,.xlsx,.xls,.docx,.doc,.csv"
              disabled={uploading}
              onChange={handleUpload}
            />
          </label>
        </section>

      </main>
    </div>
  );
}

/* ─── Точка входа ─── */
export default function SettingsPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setAuthed(sessionStorage.getItem(SESSION_KEY) === "1");
  }, []);

  if (authed === null) return null;

  if (!authed) {
    return <LoginScreen onSuccess={() => setAuthed(true)} />;
  }

  return <SettingsContent onLogout={() => setAuthed(false)} />;
}
