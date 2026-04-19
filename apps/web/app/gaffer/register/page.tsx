"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  gafferRegister,
  gafferOAuthGoogle,
  gafferOAuthTelegram,
  GafferApiError,
} from "../../../src/lib/gafferApi";
import { useGafferUser } from "../../../src/components/gaffer/GafferUserContext";
import { toast } from "../../../src/components/ToastProvider";
import { GafferAuthCard, GoogleIcon, TelegramIcon } from "../../../src/components/gaffer/GafferAuthCard";

export default function GafferRegisterPage() {
  const router = useRouter();
  const { refresh } = useGafferUser();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState<"google" | "telegram" | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await gafferRegister({
        email: email.trim(),
        password,
        name: name.trim() || undefined,
      });
      await refresh();
      toast.success("Аккаунт создан");
      if (res.user.onboardingCompletedAt) {
        router.push("/gaffer");
      } else {
        router.push("/gaffer/welcome");
      }
    } catch (err) {
      if (err instanceof GafferApiError) {
        setError(err.message);
      } else {
        setError("Не удалось зарегистрироваться. Попробуйте ещё раз.");
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleOAuth(provider: "google" | "telegram") {
    setOauthBusy(provider);
    try {
      if (provider === "google") {
        await gafferOAuthGoogle();
      } else {
        await gafferOAuthTelegram();
      }
      await refresh();
      router.push("/gaffer");
    } catch (err) {
      if (err instanceof GafferApiError) {
        toast.info(err.message);
      } else {
        toast.error("Не удалось войти через OAuth");
      }
    } finally {
      setOauthBusy(null);
    }
  }

  const canSubmit = email.trim().length > 0 && password.length >= 6;

  return (
    <GafferAuthCard activeTab="gaffer" subtitle="Гаффер · регистрация">
      <form onSubmit={handleSubmit} className="space-y-0">
        <label className="block text-[12px] text-ink-2 mb-1" htmlFor="reg-name">
          Имя
        </label>
        <input
          id="reg-name"
          type="text"
          autoFocus
          autoComplete="given-name"
          placeholder="Кирилл"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={loading}
          className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60 mb-[14px]"
        />

        <label className="block text-[12px] text-ink-2 mb-1" htmlFor="reg-email">
          E-mail
        </label>
        <input
          id="reg-email"
          type="email"
          required
          autoComplete="email"
          placeholder="name@studio.ru"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60 mb-[14px]"
        />

        <label className="block text-[12px] text-ink-2 mb-1" htmlFor="reg-password">
          Пароль
        </label>
        <input
          id="reg-password"
          type="password"
          required
          autoComplete="new-password"
          placeholder="минимум 6 символов"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          minLength={6}
          className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60 mb-[14px]"
        />

        {error && (
          <p className="text-rose text-[12px] mb-3" role="alert">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={loading || !canSubmit}
          className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-[11px] text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
        >
          {loading ? "Создаём аккаунт..." : "Зарегистрироваться"}
        </button>

        {/* Divider */}
        <div
          className="flex items-center gap-[10px] my-[18px] text-ink-3 text-[10.5px] font-semibold tracking-[1.2px] uppercase"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
        >
          <span className="flex-1 border-t border-border" />
          или
          <span className="flex-1 border-t border-border" />
        </div>

        {/* Google */}
        <button
          type="button"
          onClick={() => handleOAuth("google")}
          disabled={oauthBusy !== null}
          aria-label="Зарегистрироваться через Google"
          className="w-full flex items-center justify-center gap-[10px] py-[10px] mb-2 border border-border rounded-[6px] bg-surface font-medium text-[13px] text-ink hover:bg-[#fafafa] transition-colors disabled:opacity-60 disabled:cursor-wait"
        >
          <GoogleIcon />
          {oauthBusy === "google" ? "Открываем Google..." : "Через Google"}
        </button>

        {/* Telegram */}
        <button
          type="button"
          onClick={() => handleOAuth("telegram")}
          disabled={oauthBusy !== null}
          aria-label="Зарегистрироваться через Telegram"
          className="w-full flex items-center justify-center gap-[10px] py-[10px] border border-border rounded-[6px] bg-surface font-medium text-[13px] text-[#2ca5e0] hover:bg-[#fafafa] transition-colors disabled:opacity-60 disabled:cursor-wait"
        >
          <TelegramIcon />
          {oauthBusy === "telegram" ? "Открываем Telegram..." : "Через Telegram"}
        </button>

        {/* Login link */}
        <div className="text-center text-[12px] text-ink-2 mt-[18px]">
          Уже есть аккаунт?{" "}
          <Link
            href="/gaffer/login"
            className="text-accent-bright font-medium hover:underline"
          >
            Войти →
          </Link>
        </div>
      </form>
    </GafferAuthCard>
  );
}
