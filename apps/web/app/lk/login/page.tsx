"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { lkApi } from "../../../src/lib/lkApi";

export default function LkLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await lkApi.requestLogin(email.trim());
      router.push("/lk/login/sent");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="w-full max-w-[360px] bg-surface-2 border border-border rounded-xl p-6 space-y-4"
    >
      <h1 className="text-xl font-medium">Вход в личный кабинет</h1>
      <p className="text-sm text-ink-2">Введите email, и мы пришлём ссылку для входа.</p>
      <input
        type="email"
        required
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="email@example.ru"
        className="w-full px-3 py-2 border border-border rounded-md bg-surface"
      />
      {error && <div className="text-sm text-rose">{error}</div>}
      <button
        type="submit"
        disabled={submitting || !email}
        className="w-full px-4 py-2 bg-accent-bright text-surface rounded-md disabled:opacity-50"
      >
        {submitting ? "Отправляем…" : "Получить ссылку"}
      </button>
    </form>
  );
}
