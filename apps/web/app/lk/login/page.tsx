"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { lkApi } from "../../../src/lib/lkApi";

export default function LkLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);
  const [magicSubmitting, setMagicSubmitting] = useState(false);
  const [magicError, setMagicError] = useState<string | null>(null);

  async function onPasswordLogin(e: React.FormEvent) {
    e.preventDefault();
    setPasswordSubmitting(true);
    setPasswordError(null);
    try {
      await lkApi.passwordLogin(email.trim(), password);
      router.push("/lk");
    } catch (err) {
      setPasswordError("Неверные учётные данные");
    } finally {
      setPasswordSubmitting(false);
    }
  }

  async function onMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setMagicSubmitting(true);
    setMagicError(null);
    try {
      await lkApi.requestLogin(email.trim());
      router.push("/lk/login/sent");
    } catch (err) {
      setMagicError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setMagicSubmitting(false);
    }
  }

  const isSubmitting = passwordSubmitting || magicSubmitting;

  return (
    <div className="w-full max-w-[360px] bg-surface-muted border border-border rounded-lg p-6 space-y-5">
      <div>
        <h1 className="text-xl font-medium">Вход в личный кабинет</h1>
      </div>

      {/* Shared email field */}
      <div>
        <label htmlFor="lk-email" className="block text-sm text-ink-2 mb-1">Email</label>
        <input
          id="lk-email"
          type="email"
          required
          autoFocus
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@example.ru"
          className="w-full px-3 py-2.5 border border-border rounded text-sm bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-bright focus:border-accent-bright disabled:bg-surface-subtle"
          disabled={isSubmitting}
        />
      </div>

      {/* Password section */}
      <form onSubmit={onPasswordLogin} className="space-y-3">
        <div>
          <label htmlFor="lk-password" className="block text-sm text-ink-2 mb-1">Пароль</label>
          <input
            id="lk-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••••••"
            className="w-full px-3 py-2.5 border border-border rounded text-sm bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-bright focus:border-accent-bright disabled:bg-surface-subtle"
            disabled={isSubmitting}
          />
        </div>
        {passwordError && <div className="text-sm text-rose">{passwordError}</div>}
        <button
          type="submit"
          disabled={isSubmitting || !email || !password}
          className="w-full px-4 py-2.5 rounded text-sm font-medium border border-accent-bright bg-accent-bright text-surface hover:bg-accent transition-colors disabled:opacity-50"
        >
          {passwordSubmitting ? "Входим…" : "Войти"}
        </button>
      </form>

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 border-t border-border" />
        <span className="text-xs text-ink-3">или</span>
        <div className="flex-1 border-t border-border" />
      </div>

      {/* Magic-link section */}
      <form onSubmit={onMagicLink} className="space-y-3">
        <p className="text-sm text-ink-2">Получить ссылку для входа на email</p>
        {magicError && <div className="text-sm text-rose">{magicError}</div>}
        <button
          type="submit"
          disabled={isSubmitting || !email}
          className="w-full px-4 py-2.5 rounded text-sm font-medium border border-border text-ink bg-surface hover:bg-surface-muted transition-colors disabled:opacity-50"
        >
          {magicSubmitting ? "Отправляем…" : "Получить ссылку"}
        </button>
      </form>
    </div>
  );
}
