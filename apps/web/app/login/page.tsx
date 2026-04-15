"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "../../src/lib/api";

type LoginResponse = {
  user: { userId: string; username: string; role: "SUPER_ADMIN" | "RENTAL_ADMIN" };
};

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const redirectTo = searchParams.get("from") || "/dashboard";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch<LoginResponse>("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ username: username.trim(), password }),
      });
      // Сохраняем роль в localStorage для клиентских проверок (доп. к cookie)
      if (typeof window !== "undefined") {
        window.localStorage.setItem(
          "lr_user",
          JSON.stringify({ username: res.user.username, role: res.user.role }),
        );
      }
      router.push(redirectTo);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось войти");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="min-h-screen bg-accent flex items-center justify-center p-6">
      <div className="w-full max-w-[360px]">
        <div className="text-center mb-8">
          <Link href="/" className="inline-block">
            <h1 className="text-xl font-semibold text-white tracking-tight">
              Svetobaza Rental
            </h1>
          </Link>
          <p className="text-accent-border text-xs mt-1.5 eyebrow">Вход в систему</p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-surface rounded-lg shadow-sm p-6 space-y-4 border border-border"
        >
          <div>
            <label className="block text-sm font-medium text-ink mb-1.5">
              Логин
            </label>
            <input
              type="text"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              className="w-full px-3 py-2.5 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright focus:border-accent-bright disabled:bg-surface-subtle"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-ink mb-1.5">
              Пароль
            </label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              className="w-full px-3 py-2.5 border border-border rounded text-sm focus:outline-none focus:ring-2 focus:ring-accent-bright focus:border-accent-bright disabled:bg-surface-subtle"
              required
            />
          </div>

          {error && (
            <div className="bg-rose-soft border border-rose-border text-rose text-sm rounded px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !username || !password}
            className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-2.5 text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "Вход..." : "Войти"}
          </button>

          <div className="pt-2 text-center">
            <Link
              href="/"
              className="text-xs text-ink-3 hover:text-ink-2 transition-colors"
            >
              ← На главную
            </Link>
          </div>
        </form>
      </div>
    </main>
  );
}
