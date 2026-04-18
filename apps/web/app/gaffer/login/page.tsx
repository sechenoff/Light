"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { gafferLogin, GafferApiError } from "../../../src/lib/gafferApi";
import { useGafferUser } from "../../../src/components/gaffer/GafferUserContext";

export default function GafferLoginPage() {
  const router = useRouter();
  const { refresh } = useGafferUser();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await gafferLogin(email.trim());
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

  return (
    <div
      className="min-h-screen flex flex-col items-center bg-accent pt-14 px-5"
      style={{ minHeight: "640px" }}
    >
      {/* Brand */}
      <div className="text-center mb-7">
        <div
          className="text-white font-semibold text-[22px] tracking-tight mb-1"
          style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          Light Rental
        </div>
        <div
          className="text-accent-border text-[11px] font-semibold tracking-[1.8px] uppercase"
          style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
        >
          Гаффер · личный кабинет
        </div>
      </div>

      {/* Card */}
      <div
        className="w-full bg-surface rounded-lg overflow-hidden shadow-[0_14px_28px_rgba(9,9,11,.22)] border border-white/10"
        style={{ maxWidth: "340px" }}
      >
        {/* Tabs */}
        <div className="grid grid-cols-2 border-b border-border bg-[#fafafa]">
          <a
            href="/login"
            className="py-3 text-center text-[12px] font-semibold tracking-[1.2px] uppercase text-ink-3 border-b-2 border-transparent hover:text-ink transition-colors"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            Сотрудник
          </a>
          <button
            type="button"
            className="py-3 text-center text-[12px] font-semibold tracking-[1.2px] uppercase text-accent border-b-2 border-accent-bright bg-surface"
            style={{ fontFamily: "'IBM Plex Sans Condensed', sans-serif" }}
          >
            Гаффер
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-[22px] space-y-0">
          <label className="block text-[12px] text-ink-2 mb-1" htmlFor="gaffer-email">
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
            className="w-full px-[11px] py-[9px] border border-border rounded text-[13.5px] bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent-border focus:border-accent-bright disabled:opacity-60 mb-[14px]"
          />

          {error && (
            <p className="text-rose text-sm mb-3">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading || !email.trim()}
            className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-[11px] text-[14px] transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
          >
            {loading ? "Вход..." : "Войти"}
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

          {/* Google stub */}
          <button
            type="button"
            disabled
            className="w-full flex items-center justify-center gap-[10px] py-[10px] mb-2 border border-border rounded-[6px] bg-surface font-medium text-[13px] text-ink opacity-50 cursor-not-allowed"
          >
            <span className="text-[15px]">
              <svg viewBox="0 0 18 18" width="16" height="16">
                <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.26-.17-1.84H9v3.48h4.84a4.14 4.14 0 01-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/>
                <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.02-3.7H.96v2.34A9 9 0 009 18z"/>
                <path fill="#FBBC05" d="M3.98 10.72a5.4 5.4 0 010-3.44V4.94H.96a9 9 0 000 8.12l3.02-2.34z"/>
                <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.46 3.44 1.35l2.58-2.58A9 9 0 009 0 9 9 0 00.96 4.94l3.02 2.34C4.68 5.16 6.66 3.58 9 3.58z"/>
              </svg>
            </span>
            Войти через Google
            <span className="ml-1 text-[10px] text-ink-3">Скоро</span>
          </button>

          {/* Telegram stub */}
          <button
            type="button"
            disabled
            className="w-full flex items-center justify-center gap-[10px] py-[10px] border border-border rounded-[6px] bg-surface font-medium text-[13px] text-[#2ca5e0] opacity-50 cursor-not-allowed"
          >
            <span className="text-[15px]">
              <svg viewBox="0 0 18 18" width="16" height="16">
                <circle cx="9" cy="9" r="9" fill="#2CA5E0"/>
                <path fill="#fff" d="M13.54 5.2 11.9 12.9c-.13.55-.47.68-.95.42l-2.6-1.92-1.26 1.2c-.14.14-.26.26-.52.26l.18-2.62 4.78-4.32c.21-.18-.04-.28-.32-.1L5.3 9.54l-2.56-.8c-.56-.18-.57-.56.12-.83L12.82 4.4c.46-.16.87.11.72.8z"/>
              </svg>
            </span>
            Войти через Telegram
            <span className="ml-1 text-[10px] text-ink-3">Скоро</span>
          </button>
        </form>
      </div>
    </div>
  );
}
