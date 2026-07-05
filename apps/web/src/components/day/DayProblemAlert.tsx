"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { toMoscowDateString } from "../../lib/moscowDate";
import { pluralize } from "../../lib/format";
import { DayAlert } from "./DayAlert";

interface ProblemItemRow {
  id: string;
  status: string;
  expectedBackDate: string | null;
}

/**
 * MD-6: rose-алерт на «Моём дне» (SA/WAREHOUSE) о просроченных потеряшках —
 * карточках EXPECTED («остался на площадке, ждём досдачу»), у которых
 * expectedBackDate уже прошёл по Москве. Просроченный срок досдачи — сигнал
 * «нужно действие», поэтому rose (не amber): единица зависла сверх обещанного.
 *
 * NB: /api/problem-items не умеет фильтровать по expectedBackDate, поэтому
 * считаем на клиенте по первой странице реестра (limit 200 — максимум API).
 * При > 200 открытых EXPECTED-карточек счётчик может быть занижен —
 * осознанный trade-off, серверный фильтр — отдельная задача.
 */
export function DayProblemAlert() {
  const [overdueCount, setOverdueCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: ProblemItemRow[] }>("/api/problem-items?status=EXPECTED&limit=200")
      .then((d) => {
        if (cancelled) return;
        const today = toMoscowDateString(new Date());
        const overdue = d.items.filter(
          (i) =>
            i.expectedBackDate &&
            toMoscowDateString(new Date(i.expectedBackDate)) < today,
        );
        setOverdueCount(overdue.length);
      })
      .catch(() => { /* не блокируем первый экран */ });
    return () => { cancelled = true; };
  }, []);

  if (overdueCount === 0) return null;

  return (
    <DayAlert
      variant="rose"
      count={overdueCount}
      title={`⏳ Потеряшки: ${pluralize(
        overdueCount,
        "единица просрочила",
        "единицы просрочили",
        "единиц просрочили",
      )} срок досдачи`}
      linkHref="/warehouse/problems"
      linkLabel="Реестр →"
    />
  );
}
