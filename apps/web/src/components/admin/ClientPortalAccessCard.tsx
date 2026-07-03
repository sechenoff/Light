"use client";
import { useEffect, useState } from "react";
import { toast } from "../ToastProvider";

type PortalAccount = {
  id: string;
  email: string;
  status: "PENDING" | "ACTIVE" | "DISABLED";
  invitedAt: string | null;
  acceptedAt: string | null;
  lastLoginAt: string | null;
};

interface ClientPortalAccessCardProps {
  clientId: string;
  defaultEmail: string | null;
}

export function ClientPortalAccessCard({ clientId, defaultEmail }: ClientPortalAccessCardProps) {
  const [account, setAccount] = useState<PortalAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [msg, setMsg] = useState<string | null>(null);
  // lk-invite-fallback: ссылка-приглашение из последнего invite/resend —
  // ручной канал доставки, когда письмо не ушло (и просто удобный дубль).
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [emailFailed, setEmailFailed] = useState(false);
  // «Отправить на другой адрес»: инлайн-правка email в resend-потоке
  // (исправление опечатки без пересоздания аккаунта).
  const [editingEmail, setEditingEmail] = useState(false);
  const [newEmail, setNewEmail] = useState("");

  async function refresh() {
    try {
      const r = await fetch(`/api/admin/clients/${clientId}/portal-account`, {
        credentials: "include",
      });
      const body = await r.json();
      setAccount(body.account ?? null);
    } catch {
      setAccount(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/admin/clients/${clientId}/portal-account`, { credentials: "include" })
      .then((r) => r.json())
      .then((body) => {
        if (!cancelled) {
          setAccount(body.account ?? null);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  function applyInviteResult(body: { emailSent?: boolean; inviteUrl?: string | null }, successMsg: string) {
    setInviteUrl(body.inviteUrl ?? null);
    const failed = body.emailSent === false;
    setEmailFailed(failed);
    setMsg(failed ? null : successMsg);
  }

  // API кладёт русское сообщение HttpError в body.message (app.ts);
  // body.error существует только у отдельных легаси-веток — оставлен фолбэком.
  function apiErrorMessage(body: { message?: string; error?: string } | null | undefined, fallback: string): string {
    return body?.message || body?.error || fallback;
  }

  async function invite() {
    setBusy(true);
    setMsg(null);
    setEmailFailed(false);
    try {
      const r = await fetch(`/api/admin/clients/${clientId}/portal-invite`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await r.json();
      if (!r.ok) {
        throw new Error(apiErrorMessage(body, "Ошибка при отправке приглашения"));
      }
      applyInviteResult(body, "Приглашение отправлено");
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function resend(targetEmail?: string) {
    setBusy(true);
    setMsg(null);
    setEmailFailed(false);
    try {
      const r = await fetch(`/api/admin/clients/${clientId}/portal-account/resend`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(targetEmail ? { newEmail: targetEmail } : {}),
      });
      const body = await r.json();
      if (!r.ok) {
        throw new Error(apiErrorMessage(body, "Ошибка"));
      }
      applyInviteResult(
        body,
        targetEmail ? "Email обновлён, ссылка отправлена" : "Ссылка повторно отправлена",
      );
      setEditingEmail(false);
      setNewEmail("");
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function action(path: string, successMsg: string) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch(`/api/admin/clients/${clientId}/portal-account/${path}`, {
        method: "POST",
        credentials: "include",
      });
      if (!r.ok) {
        const body = await r.json();
        throw new Error(apiErrorMessage(body, "Ошибка"));
      }
      setMsg(successMsg);
      await refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Ошибка");
    } finally {
      setBusy(false);
    }
  }

  async function copyInviteUrl() {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast.success("Ссылка-приглашение скопирована");
    } catch {
      toast.error("Не удалось скопировать ссылку");
    }
  }

  // Блок результата invite/resend: amber-предупреждение при провале письма
  // и кнопка ручного fallback «Скопировать ссылку» — в любом случае.
  const inviteResultBlock = (
    <>
      {emailFailed && (
        <p className="text-sm text-amber bg-amber-soft border border-amber-border rounded-md px-3 py-2">
          Письмо не отправлено — отправьте ссылку вручную
        </p>
      )}
      {inviteUrl && (
        <button
          onClick={copyInviteUrl}
          className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-surface transition-colors"
        >
          Скопировать ссылку
        </button>
      )}
    </>
  );

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-surface-2 p-4">
        <p className="eyebrow mb-2">Доступ в кабинет</p>
        <p className="text-sm text-ink-2">Загрузка…</p>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="rounded-lg border border-border bg-surface-2 p-4 space-y-3">
        <p className="eyebrow">Доступ в кабинет</p>
        <p className="text-sm text-ink-2">Кабинет не создан. Введите email для отправки приглашения.</p>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="email@example.ru"
          className="w-full px-3 py-2 text-sm border border-border rounded-md bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent"
        />
        <button
          onClick={invite}
          disabled={busy || !email.trim()}
          className="px-4 py-2 text-sm bg-accent-bright text-white rounded-md disabled:opacity-50 hover:opacity-90 transition-opacity"
        >
          {busy ? "Отправка…" : "Дать доступ в кабинет"}
        </button>
        {inviteResultBlock}
        {msg && <p className="text-sm text-ink-2">{msg}</p>}
      </div>
    );
  }

  const statusLabel: Record<PortalAccount["status"], string> = {
    PENDING: "Приглашение отправлено",
    ACTIVE: "Активен",
    DISABLED: "Отключён",
  };

  const statusClass: Record<PortalAccount["status"], string> = {
    PENDING: "text-amber",
    ACTIVE: "text-ok",
    DISABLED: "text-ink-3",
  };

  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4 space-y-3">
      <p className="eyebrow">Доступ в кабинет</p>

      <div className="text-sm space-y-1">
        <p className="font-medium text-ink">{account.email}</p>
        <p className={statusClass[account.status]}>
          {statusLabel[account.status]}
          {account.status === "ACTIVE" && account.lastLoginAt
            ? ` · последний вход ${new Date(account.lastLoginAt).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}`
            : null}
          {account.status === "PENDING" && account.invitedAt
            ? ` · приглашён ${new Date(account.invitedAt).toLocaleDateString("ru-RU")}`
            : null}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {(account.status === "PENDING" || account.status === "ACTIVE") && (
          <>
            <button
              onClick={() => resend()}
              disabled={busy}
              className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-surface transition-colors disabled:opacity-50"
            >
              Переслать ссылку
            </button>
            <button
              onClick={() => {
                setEditingEmail((v) => !v);
                setNewEmail(account.email);
                setMsg(null);
              }}
              disabled={busy}
              className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-surface transition-colors disabled:opacity-50"
            >
              На другой адрес…
            </button>
          </>
        )}
        {account.status !== "DISABLED" && (
          <button
            onClick={() => action("disable", "Доступ отключён")}
            disabled={busy}
            className="px-3 py-1.5 text-sm border border-rose-border text-rose rounded-md hover:bg-rose-soft transition-colors disabled:opacity-50"
          >
            Отключить
          </button>
        )}
        {account.status === "DISABLED" && (
          <button
            onClick={() => action("reenable", "Доступ восстановлен")}
            disabled={busy}
            className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-surface transition-colors disabled:opacity-50"
          >
            Восстановить
          </button>
        )}
      </div>

      {editingEmail && (
        <div className="space-y-2">
          <p className="text-sm text-ink-2">Отправить приглашение на другой адрес (email аккаунта будет обновлён):</p>
          <div className="flex flex-wrap gap-2">
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="email@example.ru"
              aria-label="Новый email для доступа в кабинет"
              className="flex-1 min-w-[200px] px-3 py-2 text-sm border border-border rounded-md bg-surface text-ink focus:outline-none focus:ring-2 focus:ring-accent"
            />
            <button
              onClick={() => resend(newEmail.trim().toLowerCase())}
              disabled={busy || !newEmail.trim()}
              className="px-3 py-1.5 text-sm bg-accent-bright text-white rounded-md disabled:opacity-50 hover:opacity-90 transition-opacity"
            >
              {busy ? "Отправка…" : "Отправить"}
            </button>
            <button
              onClick={() => {
                setEditingEmail(false);
                setNewEmail("");
              }}
              disabled={busy}
              className="px-3 py-1.5 text-sm border border-border rounded-md hover:bg-surface transition-colors disabled:opacity-50"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      {inviteResultBlock}
      {msg && <p className="text-sm text-ink-2">{msg}</p>}
    </div>
  );
}
