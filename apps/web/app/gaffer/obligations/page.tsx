"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  listObligations,
  type GafferObligationView,
  type GafferObligationsFilter,
  type ObligationsSummary,
} from "../../../src/lib/gafferApi";
import { formatRub } from "../../../src/lib/format";
import {
  Panel,
  KPI,
  Segmented,
  Tag,
  Eyebrow,
  H1Title,
  H1Subtitle,
} from "../../../src/components/gaffer/designSystem";

// ── Helpers ──────────────────────────────────────────────────────────────────

type DirectionFilter = "all" | "IN" | "OUT";
type CategoryFilter = "all" | "client" | "crew" | "rental";
type StatusFilter = "active" | "overdue" | "all";

function formatAmount(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0 ₽";
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 0,
  }).format(Math.floor(n)) + " ₽";
}

function formatDate(isoStr: string): string {
  return format(new Date(isoStr), "dd.MM.yyyy");
}

// ── Local progress bar (2-segment, replaces BalanceBar for mobile cards) ─────

function ProgressBar({
  percent,
  ariaLabel,
}: {
  percent: number;
  ariaLabel: string;
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div
      className="h-1.5 w-full bg-border rounded overflow-hidden"
      role="progressbar"
      aria-label={ariaLabel}
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full bg-gaffer-pos rounded"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

// ── Skeleton ─────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="animate-pulse space-y-4 p-6">
      <div className="h-6 bg-gaffer-bg-sub rounded w-1/2" />
      <div className="h-10 bg-gaffer-bg-sub rounded w-2/3" />
      <div className="h-20 bg-gaffer-bg-sub rounded" />
    </div>
  );
}

// ── Category label/tone ───────────────────────────────────────────────────────

const CATEGORY_META: Record<
  "client" | "crew" | "rental",
  { label: string; tone: "pos" | "neg" | "warn" | "info" | "neutral" }
> = {
  client: { label: "Клиент", tone: "info" },
  rental: { label: "Рентал", tone: "neutral" },
  crew: { label: "Осветитель", tone: "neutral" },
};

const STATUS_META: Record<
  "open" | "partial" | "paid" | "overdue",
  { label: string; tone: "pos" | "neg" | "warn" | "info" | "neutral" }
> = {
  open: { label: "Открыт", tone: "neutral" },
  partial: { label: "Частично", tone: "info" },
  paid: { label: "Оплачен", tone: "pos" },
  overdue: { label: "Просрочен", tone: "warn" },
};

// ── Desktop table row ─────────────────────────────────────────────────────────

function DesktopRow({
  item,
  onClick,
}: {
  item: GafferObligationView;
  onClick: () => void;
}) {
  const cat = CATEGORY_META[item.category];
  const stat = STATUS_META[item.status];

  return (
    <tr
      className="border-b border-border/60 hover:bg-[#fafafa] cursor-pointer"
      onClick={onClick}
    >
      <td className="py-2 px-3 text-[13px] text-gaffer-fg font-medium">
        {item.counterpartyName}
      </td>
      <td className="py-2 px-3 text-[13px]">
        <span className="text-ink-3 font-mono text-[11px] mr-1">
          {item.projectCode}
        </span>
        {item.projectTitle}
      </td>
      <td className="py-2 px-3">
        <Tag tone={cat.tone}>{cat.label}</Tag>
      </td>
      <td className="py-2 px-3 text-[13px] text-gaffer-fg whitespace-nowrap">
        {item.dueAt ? (
          <>
            {formatDate(item.dueAt)}
            {item.overdueDays !== null && item.overdueDays > 0 && (
              <span className="ml-2 inline-flex">
                <Tag tone="warn">просрочено {item.overdueDays} дн.</Tag>
              </span>
            )}
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="py-2 px-3 text-[13px] text-gaffer-fg font-mono text-right whitespace-nowrap">
        {formatAmount(item.sum)}
      </td>
      <td className="py-2 px-3 text-[13px] font-mono text-right whitespace-nowrap">
        <span
          className={
            item.status === "paid"
              ? "text-gaffer-pos"
              : item.status === "overdue"
                ? "text-gaffer-warn"
                : "text-gaffer-fg"
          }
        >
          {formatAmount(item.remaining)}
        </span>
      </td>
      <td className="py-2 px-3">
        <Tag tone={stat.tone}>{stat.label}</Tag>
      </td>
      <td className="py-2 px-3 text-ink-3 text-[16px] text-center">›</td>
    </tr>
  );
}

// ── Mobile card ───────────────────────────────────────────────────────────────

function MobileCard({
  item,
  onClick,
}: {
  item: GafferObligationView;
  onClick: () => void;
}) {
  const cat = CATEGORY_META[item.category];
  const stat = STATUS_META[item.status];
  const sum = Number(item.sum);
  const paid = Number(item.paid);
  const remaining = Number(item.remaining);
  const hasProgress = remaining < sum && sum > 0;

  return (
    <div
      className="bg-white border border-border rounded-md px-3 py-3 space-y-2 cursor-pointer"
      onClick={onClick}
    >
      {/* Top row: name + status */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-[13px] text-gaffer-fg truncate flex-1">
          {item.counterpartyName}
        </span>
        <Tag tone={stat.tone}>{stat.label}</Tag>
      </div>

      {/* Project */}
      <div className="text-ink-2 text-[12px] font-mono">
        {item.projectCode}{" "}
        <span className="font-sans">{item.projectTitle}</span>
      </div>

      {/* Category + due date */}
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={cat.tone}>{cat.label}</Tag>
        {item.dueAt ? (
          <span className="text-[12px] text-gaffer-fg-muted">
            {formatDate(item.dueAt)}
          </span>
        ) : (
          <span className="text-[12px] text-gaffer-fg-muted">—</span>
        )}
        {item.overdueDays !== null && item.overdueDays > 0 && (
          <Tag tone="warn">просрочено {item.overdueDays} дн.</Tag>
        )}
      </div>

      {/* Остаток */}
      <div className="flex items-center justify-between">
        <span className="text-ink-3 text-[11px]">Остаток</span>
        <span
          className={`text-[15px] font-semibold font-mono ${
            item.status === "paid"
              ? "text-gaffer-pos"
              : item.status === "overdue"
                ? "text-gaffer-warn"
                : "text-gaffer-fg"
          }`}
        >
          {formatAmount(item.remaining)}
        </span>
      </div>

      {/* Progress bar */}
      {hasProgress && (
        <ProgressBar
          percent={sum > 0 ? (paid / sum) * 100 : 0}
          ariaLabel={
            item.direction === "IN"
              ? `Оплачено клиентом ${paid} из ${sum}, осталось ${remaining}`
              : `Выплачено ${paid} из ${sum}, осталось ${remaining}`
          }
        />
      )}
      {hasProgress && (
        <div className="text-[11px] text-gaffer-fg-muted">
          Остаток:{" "}
          <span className="font-semibold">{formatAmount(item.remaining)}</span>
        </div>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <Panel>
      <div className="py-12 flex flex-col items-center justify-center gap-2">
        <span className="text-4xl">⚖</span>
        <div className="text-ink-2 text-[14px] font-medium">
          Нет обязательств
        </div>
        <div className="text-ink-3 text-[12px]">
          Попробуйте изменить фильтры
        </div>
      </div>
    </Panel>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function ObligationsPage() {
  const router = useRouter();

  const [items, setItems] = useState<GafferObligationView[]>([]);
  const [summary, setSummary] = useState<ObligationsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [direction, setDirection] = useState<DirectionFilter>("all");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [status, setStatus] = useState<StatusFilter>("active");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    const filters: GafferObligationsFilter = {
      status: status === "all" ? undefined : status,
    };
    if (direction !== "all") filters.direction = direction;
    if (category !== "all") filters.category = category;

    listObligations(filters)
      .then((res) => {
        if (!controller.signal.aborted) {
          setItems(res.items);
          setSummary(res.summary);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          const msg =
            err instanceof Error ? err.message : "Не удалось загрузить данные";
          console.error("ObligationsPage fetch error:", err);
          setError(msg);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [direction, category, status]);

  // KPI values from global summary (unaffected by active filters)
  const summaryLine = `${summary?.openCount ?? 0} открытых · ${summary?.overdueCount ?? 0} просрочено`;

  function goToProject(projectId: string) {
    router.push("/gaffer/projects/" + projectId);
  }

  return (
    <div className="min-h-screen bg-gaffer-bg px-4 py-6 md:px-6">
      {/* Error banner */}
      {error && (
        <div className="mb-4 rounded-md bg-gaffer-neg-soft border border-gaffer-neg/20 px-4 py-3 text-[13px] text-gaffer-neg">
          {error}
        </div>
      )}

      {/* Header */}
      <div className="mb-6">
        <Eyebrow>Обязательства</Eyebrow>
        <H1Title>Реестр долгов</H1Title>
        <H1Subtitle>{summaryLine}</H1Subtitle>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-3 mb-6 max-[430px]:grid-cols-1">
        <KPI
          tone="pos"
          label="Мне должны"
          value={formatAmount(summary?.owedToMe ?? "0")}
        />
        <KPI
          tone="neg"
          label="Я должен"
          value={formatAmount(summary?.iOwe ?? "0")}
        />
        <KPI
          tone="warn"
          label="Просрочено"
          value={String(summary?.overdueCount ?? 0)}
        />
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 mb-6">
        <div className="w-full">
          <Segmented<DirectionFilter>
            options={[
              { id: "all", label: "Все" },
              { id: "IN", label: "Мне должны" },
              { id: "OUT", label: "Я должен" },
            ]}
            value={direction}
            onChange={setDirection}
            fullWidth
          />
        </div>
        <div className="w-full">
          <Segmented<CategoryFilter>
            options={[
              { id: "all", label: "Все" },
              { id: "client", label: "Клиенты" },
              { id: "rental", label: "Рентал" },
              { id: "crew", label: "Осветители" },
            ]}
            value={category}
            onChange={setCategory}
            fullWidth
          />
        </div>
        <div className="w-full">
          <Segmented<StatusFilter>
            options={[
              { id: "active", label: "Активные" },
              { id: "overdue", label: "Просрочено" },
              { id: "all", label: "Все" },
            ]}
            value={status}
            onChange={setStatus}
            fullWidth
          />
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <Skeleton />
      ) : items.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="text-ink-3 uppercase tracking-wide text-[11px] border-b border-border">
                  <th className="py-2 px-3 text-left font-medium">Контрагент</th>
                  <th className="py-2 px-3 text-left font-medium">Проект</th>
                  <th className="py-2 px-3 text-left font-medium">Категория</th>
                  <th className="py-2 px-3 text-left font-medium">Срок</th>
                  <th className="py-2 px-3 text-right font-medium">Сумма</th>
                  <th className="py-2 px-3 text-right font-medium">Остаток</th>
                  <th className="py-2 px-3 text-left font-medium">Статус</th>
                  <th className="py-2 px-3" />
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <DesktopRow
                    key={item.id}
                    item={item}
                    onClick={() => goToProject(item.projectId)}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {items.map((item) => (
              <MobileCard
                key={item.id}
                item={item}
                onClick={() => goToProject(item.projectId)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
