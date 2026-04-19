"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  gafferLogin,
  gafferForgotPassword,
  gafferOAuthGoogle,
  gafferOAuthTelegram,
  GafferApiError,
} from "../../../src/lib/gafferApi";
import { useGafferUser } from "../../../src/components/gaffer/GafferUserContext";
import { toast } from "../../../src/components/ToastProvider";
import { ForgotPasswordModal } from "../../../src/components/gaffer/ForgotPasswordModal";
import { GafferAuthCard, GoogleIcon, TelegramIcon } from "../../../src/components/gaffer/GafferAuthCard";

export default function GafferLoginPage() {
  const router = useRouter();
  const { refresh } = useGafferUser();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauthBusy, setOauthBusy] = useState<"google" | "telegram" | null>(null);
  const [showForgot, setShowForgot] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await gafferLogin(email.trim(), password || undefined);
      await refresh();
      if (res.user.onboardingCompletedAt) {
        router.push("/gaffer");
      } else {
        router.push("/gaffer/welcome");
      }
    } catch (err) {
      if (err instanceof GafferApiError) {
        setError(err.message);
      } else {
        setError("Не удалось войти. Попробуйте ещё раз.");
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
      // Стаб никогда не вернёт ok, но если sprint-5 включит реальный флоу — попадём сюда
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

  return (
    <GafferAuthCard activeTab="gaffer" subtitle="Гаффер · личный кабинет">
      <form onSubmit={handleSubmit} className="space-y-0">
        {/* Email */}
        <label className="block text-[12px] text-ink-2 mb-[6px]" htmlFor="gaffer-email">
          E-mail
        </label>
        <input
          id="gaffer-email"
          type="email"
          required
          autoFocus
          autoComplete="email"
          placeholder="name@studio.ru"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          className="w-full px-[12px] py-[10px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60 mb-[18px]"
        />

        {/* Password */}
        <label className="block text-[12px] text-ink-2 mb-[6px]" htmlFor="gaffer-password">
          Пароль
        </label>
        <input
          id="gaffer-password"
          type="password"
          autoComplete="current-password"
          placeholder="•••••••••"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          className="w-full px-[12px] py-[10px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60"
        />

        {/* Forgot password — right-aligned, comfortable margins */}
        <div className="flex justify-end mt-[10px] mb-[20px]">
          <button
            type="button"
            onClick={() => setShowForgot(true)}
            className="text-[12px] text-accent-bright hover:underline"
          >
            Забыли пароль?
          </button>
        </div>

        {error && (
          <p className="text-rose text-[12px] mb-[14px]" role="alert">
            {error}
          </p>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={loading || !email.trim()}
          className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-[12px] text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
        >
          {loading ? "Вход..." : "Войти"}
        </button>

        {/* Divider */}
        <div
          className="flex items-center gap-[10px] my-[24px] text-ink-3 text-[10.5px] font-semibold tracking-[1.2px] uppercase"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
        >
          <span className="flex-1 border-t border-border" />
          или
          <span className="flex-1 border-t border-border" />
        </div>

        {/* OAuth buttons — stacked with breathing room */}
        <div className="flex flex-col gap-[12px]">
          <button
            type="button"
            onClick={() => handleOAuth("google")}
            disabled={oauthBusy !== null}
            aria-label="Войти через Google"
            className="w-full flex items-center justify-center gap-[10px] py-[11px] border border-border rounded-[6px] bg-surface font-medium text-[13px] text-ink hover:bg-[#fafafa] transition-colors disabled:opacity-60 disabled:cursor-wait"
          >
            <GoogleIcon />
            {oauthBusy === "google" ? "Открываем Google..." : "Войти через Google"}
          </button>

          <button
            type="button"
            onClick={() => handleOAuth("telegram")}
            disabled={oauthBusy !== null}
            aria-label="Войти через Telegram"
            className="w-full flex items-center justify-center gap-[10px] py-[11px] border border-border rounded-[6px] bg-surface font-medium text-[13px] text-[#2ca5e0] hover:bg-[#fafafa] transition-colors disabled:opacity-60 disabled:cursor-wait"
          >
            <TelegramIcon />
            {oauthBusy === "telegram" ? "Открываем Telegram..." : "Войти через Telegram"}
          </button>
        </div>

        {/* Register link */}
        <div className="text-center text-[12px] text-ink-2 mt-[24px]">
          Нет аккаунта?{" "}
          <Link
            href="/gaffer/register"
            className="text-accent-bright font-medium hover:underline"
          >
            Зарегистрироваться →
          </Link>
        </div>
      </form>

      {showForgot && (
        <ForgotPasswordModal
          initialEmail={email}
          onClose={() => setShowForgot(false)}
          onSubmit={async (mail) => {
            const res = await gafferForgotPassword(mail);
            toast.success(res.message);
            setShowForgot(false);
          }}
        />
      )}
    </GafferAuthCard>
  );
}
