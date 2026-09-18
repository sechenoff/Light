"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { apiFetch } from "../../../lib/api";
import { useRequireRole } from "../../../hooks/useRequireRole";
import { projectInput as input, projectPrimary, todayMoscow } from "./types";

export function ProjectBookingForm() {
  const router = useRouter();
  const { authorized } = useRequireRole(["SUPER_ADMIN", "WAREHOUSE"]);
  const [clients, setClients] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [search, setSearch] = useState("");
  const [clientId, setClientId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [paymentForm, setPaymentForm] = useState("CASH");
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        apiFetch<{ clients: Array<{ id: string; name: string }> }>(
          `/api/clients?limit=100&search=${encodeURIComponent(search)}`,
          { signal: controller.signal },
        )
          .then((d) => setClients(d.clients))
          .catch((e) => {
            if (e.name !== "AbortError") setError(e.message);
          }),
      200,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      const result = await apiFetch<{ id: string }>("/api/booking-projects", {
        method: "POST",
        body: JSON.stringify({
          clientId,
          projectName: f.get("projectName"),
          fromDate: f.get("fromDate"),
          throughDate: f.get("throughDate"),
          restFactor: Number(f.get("restPercent")) / 100,
          billingCycle: f.get("billingCycle"),
          paymentTermsDays: Number(f.get("terms")),
          paymentForm,
          cashlessSurchargePercent: Number(f.get("surcharge") || 0),
        }),
      });
      router.push(`/bookings/${result.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось создать проект");
    } finally {
      setBusy(false);
    }
  }
  if (!authorized) return null;
  return (
    <div className="mx-auto max-w-3xl p-4 lg:p-6">
      <Link href="/bookings?mode=PROJECT" className="text-sm text-ink-3">
        ← Длинные проекты
      </Link>
      <h1 className="mt-4 font-cond text-3xl text-ink">Новый длинный проект</h1>
      <p className="mt-2 text-sm text-ink-3">
        Одна карточка для съёмок, доборов, возвратов и расчётов по периодам.
      </p>
      <form
        onSubmit={submit}
        className="mt-6 space-y-5 rounded-lg border border-border bg-surface p-4 md:p-6"
      >
        <label className="block text-sm">
          Название проекта
          <input
            name="projectName"
            required
            maxLength={200}
            className={input}
            placeholder="Название фильма или сериала"
          />
        </label>
        <div>
          <label className="block text-sm">
            Поиск клиента
            <input
              className={input}
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setClientId("");
              }}
              placeholder="Имя или компания"
            />
          </label>
          <label className="mt-2 block text-sm">
            Клиент
            <select
              className={input}
              required
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
            >
              <option value="">Выберите клиента</option>
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <Link
            href="/admin/clients"
            target="_blank"
            className="mt-1 inline-block text-xs text-accent-bright"
          >
            Открыть справочник / создать клиента
          </Link>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            Первый оплачиваемый день
            <input
              className={input}
              type="date"
              name="fromDate"
              defaultValue={todayMoscow()}
              required
            />
          </label>
          <label className="block text-sm">
            Последний оплачиваемый день
            <input className={input} type="date" name="throughDate" required />
          </label>
        </div>
        <p className="text-xs text-ink-3">
          Обе даты входят в расчёт. При выдаче и возврате каждой поставки можно
          уточнить её оплачиваемые дни. Точное время складской операции
          сохраняется отдельно.
        </p>
        <div className="grid gap-4 sm:grid-cols-3">
          <label className="block text-sm">
            Выходной, % ставки
            <input
              className={input}
              name="restPercent"
              type="number"
              min={0}
              max={100}
              step="0.1"
              defaultValue={50}
              required
            />
          </label>
          <label className="block text-sm">
            Расчётный период
            <select name="billingCycle" className={input}>
              <option value="WEEKLY">Неделя</option>
              <option value="MONTHLY">Календарный месяц</option>
            </select>
          </label>
          <label className="block text-sm">
            Дней на оплату
            <input
              className={input}
              name="terms"
              type="number"
              min={0}
              max={365}
              defaultValue={7}
              required
            />
          </label>
        </div>
        <p className="text-xs text-ink-3">
          Начальный календарь: пн–пт — съёмка, сб–вс — выходной. Любой день или
          диапазон можно изменить в карточке.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm">
            Форма расчёта
            <select
              className={input}
              value={paymentForm}
              onChange={(e) => setPaymentForm(e.target.value)}
            >
              <option value="CASH">Наличные</option>
              <option value="CASHLESS">По счёту</option>
            </select>
          </label>
          {paymentForm === "CASHLESS" && (
            <label className="block text-sm">
              Согласованная надбавка, %
              <input
                name="surcharge"
                className={input}
                type="number"
                min={0}
                max={100}
                step="0.1"
                defaultValue={0}
                required
              />
            </label>
          )}
        </div>
        {error && (
          <p role="alert" className="text-sm text-rose">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy} className={projectPrimary}>
          {busy ? "Создаём…" : "Создать проект и добавить оборудование"}
        </button>
      </form>
    </div>
  );
}
