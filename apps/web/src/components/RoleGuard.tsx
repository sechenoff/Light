"use client";

import { useCurrentUser, type AdminRole } from "../lib/auth";
import Link from "next/link";

/**
 * Обёртка для страниц с ролевой проверкой. Для неавторизованных показывает заглушку
 * (middleware.ts уже должен был редиректнуть на /login), для авторизованных с иной
 * ролью — сообщение "нет доступа".
 */
export function RoleGuard({
  allow,
  children,
}: {
  allow: AdminRole[];
  children: React.ReactNode;
}) {
  const { user, loading } = useCurrentUser();

  if (loading) {
    return (
      <div className="p-8 text-center text-sm text-slate-500">
        Проверка доступа…
      </div>
    );
  }

  if (!user) {
    return (
      <div className="p-8 max-w-md mx-auto text-center">
        <h2 className="text-lg font-semibold text-slate-900 mb-2">Требуется вход</h2>
        <p className="text-sm text-slate-600 mb-4">
          Для доступа к этой странице войдите в систему.
        </p>
        <Link
          href="/login"
          className="inline-block bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium rounded-lg px-4 py-2 transition-colors"
        >
          Войти
        </Link>
      </div>
    );
  }

  if (!allow.includes(user.role)) {
    return (
      <div className="p-8 max-w-md mx-auto text-center">
        <h2 className="text-lg font-semibold text-slate-900 mb-2">Нет доступа</h2>
        <p className="text-sm text-slate-600 mb-4">
          У вашей учётной записи нет прав для просмотра этой страницы.
        </p>
        <Link
          href="/dashboard"
          className="inline-block bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-medium rounded-lg px-4 py-2 transition-colors"
        >
          На дашборд
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
