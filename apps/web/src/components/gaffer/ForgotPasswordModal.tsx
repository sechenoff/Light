"use client";

import { useEffect, useRef, useState } from "react";
import { GafferApiError } from "../../lib/gafferApi";

/**
 * Модалка «Забыли пароль?» для /gaffer/login.
 * Минимальная — пока почтовая инфраструктура не подключена, бэкенд только логирует запрос.
 */
export function ForgotPasswordModal({
  initialEmail,
  onClose,
  onSubmit,
}: {
  initialEmail: string;
  onClose: () => void;
  onSubmit: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Esc to close
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmed = email.trim();
    if (!trimmed) {
      setError("Введите email");
      return;
    }
    setBusy(true);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(err instanceof GafferApiError ? err.message : "Не удалось отправить запрос");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-end sm:items-center justify-center z-50 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="forgot-password-title"
    >
      <div className="bg-surface rounded-lg shadow-xl p-5 w-full max-w-sm">
        <h3 id="forgot-password-title" className="text-[15px] font-semibold text-ink mb-1">
          Восстановление пароля
        </h3>
        <p className="text-[12px] text-ink-3 mb-4">
          Укажите email — пришлём ссылку на сброс пароля. Если письмо не приходит, напишите в поддержку.
        </p>

        <form onSubmit={handleSubmit} className="space-y-3">
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="forgot-email">
            E-mail
          </label>
          <input
            ref={inputRef}
            id="forgot-email"
            type="email"
            autoComplete="email"
            placeholder="name@studio.ru"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
            className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
          />

          {error && <p className="text-rose text-[12px]">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-2.5 text-[13px] disabled:opacity-50"
            >
              {busy ? "Отправляем..." : "Отправить"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="flex-1 bg-surface border border-border text-ink rounded px-4 py-2.5 text-[13px] hover:bg-[#fafafa]"
            >
              Отмена
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
