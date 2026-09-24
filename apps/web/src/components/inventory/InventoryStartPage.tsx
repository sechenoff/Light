"use client";

/**
 * /warehouse/inventory — вход в раздел. Если инвентаризация уже идёт — сразу
 * в неё (router.replace, чтобы «назад» не возвращал на пустой экран). Иначе —
 * объяснение, как это устроено, и «Начать инвентаризацию».
 */

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useRequireRole } from "../../hooks/useRequireRole";
import { WarehouseSubnav } from "../warehouse/WarehouseSubnav";
import { explainInventoryError, inventoryApi } from "./api";
import { PageHead } from "./InventoryHeader";
import { StartInventoryPanel } from "./StartInventoryPanel";
import { CARD, LINK } from "./ui";

const STEPS: ReadonlyArray<{ title: string; text: string }> = [
  {
    title: "Считаем",
    text: "Кладовщики пересчитывают полку по категориям — в киоске с телефона или здесь. Каждая строка сохраняется сразу. «На полке должно быть» уже учитывает выданное, брони по календарю, мастерскую и потеряшки.",
  },
  {
    title: "Решаем",
    text: "По каждой недостаче и излишку: «Пропало → потеряшки», «Ошибка учёта» с причиной или «Пересчитать». «Как пропало» покажет брони с позицией и то, как их принимали.",
  },
  {
    title: "Завершаем",
    text: "Всё записывается одной операцией: потеряшки, поправки учёта, отметки «сверено». Остаётся акт — PDF и XLSX. До завершения в учёт ничего не записано.",
  },
];

export function InventoryStartPage() {
  const router = useRouter();
  const { authorized, loading: authLoading } = useRequireRole(["SUPER_ADMIN", "WAREHOUSE"]);
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const checkActive = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      const { stockCount } = await inventoryApi.active();
      if (stockCount) {
        router.replace(`/warehouse/inventory/${stockCount.id}`);
        return;
      }
      setChecking(false);
    } catch (e) {
      setError(explainInventoryError(e, "Не удалось проверить, идёт ли инвентаризация"));
      setChecking(false);
    }
  }, [router]);

  useEffect(() => {
    if (authorized) void checkActive();
  }, [authorized, checkActive]);

  if (authLoading) return <p className="p-6 text-sm text-ink-3">Проверка доступа…</p>;
  if (!authorized) return null;

  return (
    <div className="mx-auto w-full max-w-[1240px] p-4 lg:p-6">
      <PageHead title="Инвентаризация" sub="пройти склад, пересчитать и узнать, что пропало и как" />
      <div className="mt-3">
        <WarehouseSubnav active="inventory" />
      </div>

      {checking ? (
        <div aria-busy="true" aria-label="Проверяем, идёт ли инвентаризация" className="mt-4 grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="h-56 animate-pulse rounded-lg bg-surface-subtle" />
          <div className="h-56 animate-pulse rounded-lg bg-surface-subtle" />
        </div>
      ) : error ? (
        <div className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-rose-border bg-rose-soft px-4 py-3 text-sm text-rose">
          <span>{error}</span>
          <button type="button" onClick={() => void checkActive()} className={LINK}>
            Повторить
          </button>
        </div>
      ) : (
        <div className="mt-4 grid items-start gap-3.5 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className={CARD} aria-labelledby="inventory-empty-title">
            <div className="border-b border-border px-4 py-3">
              <h2 id="inventory-empty-title" className="font-cond text-base font-bold text-ink">
                Сейчас инвентаризация не идёт
              </h2>
              <p className="text-[12.5px] text-ink-2">
                Пропажу на приёмке видно, только если бронь принимают с пересчётом. Инвентаризация пересчитывает полку
                целиком — и показывает, что пропало и с какой брони.
              </p>
            </div>
            <ol className="divide-y divide-border">
              {STEPS.map((step, i) => (
                <li key={step.title} className="grid grid-cols-[28px_minmax(0,1fr)] gap-3 px-4 py-3">
                  <span className="mono-num flex h-6 w-6 items-center justify-center rounded bg-inverse text-[11px] font-semibold text-on-inverse">
                    {i + 1}
                  </span>
                  <span>
                    <b className="block text-[13px] font-semibold text-ink">{step.title}</b>
                    <span className="block text-[12.5px] leading-relaxed text-ink-2">{step.text}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
          <StartInventoryPanel
            onStarted={(detail) => router.push(`/warehouse/inventory/${detail.id}`)}
            onAlreadyOpen={() => void checkActive()}
          />
        </div>
      )}
    </div>
  );
}
