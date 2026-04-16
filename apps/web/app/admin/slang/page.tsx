"use client";

import { useState, useEffect } from "react";
import { AdminTabNav } from "@/components/admin/AdminTabNav";
import { useRequireRole } from "@/hooks/useRequireRole";
import { apiFetch } from "@/lib/api";

// ── Types ─────────────────────────────────────────────────────────────────────

type SlangAlias = {
  id: string;
  phraseNormalized: string;
  phraseOriginal: string;
  equipmentId: string;
  confidence: number;
  source: string;
  createdAt: string;
  usageCount: number;
  lastUsedAt: string;
  equipment: { name: string; category: string };
};

type DictionaryGroup = {
  equipment: { id: string; name: string; category: string };
  aliases: SlangAlias[];
  aliasCount: number;
};

type SlangCandidate = {
  id: string;
  rawPhrase: string;
  normalizedPhrase: string;
  proposedEquipmentId: string | null;
  proposedEquipmentName: string | null;
  confidence: number;
  contextJson: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
};

type FilterKey = "all" | "confirmed" | "pending" | "auto" | "manual";

// ── Pure helpers ──────────────────────────────────────────────────────────────

function flattenGroups(groups: DictionaryGroup[]): SlangAlias[] {
  return groups.flatMap((g) => g.aliases);
}

function filterAliases(
  aliases: SlangAlias[],
  filter: FilterKey,
  search: string,
): SlangAlias[] {
  let result = aliases;

  if (filter === "confirmed") {
    result = result.filter(
      (a) => a.source === "manual" || a.source === "confirmed",
    );
  } else if (filter === "auto") {
    result = result.filter((a) => a.source === "auto");
  } else if (filter === "manual") {
    result = result.filter((a) => a.source === "manual");
  }

  if (search.trim()) {
    const q = search.toLowerCase();
    result = result.filter(
      (a) =>
        a.phraseNormalized.toLowerCase().includes(q) ||
        a.phraseOriginal.toLowerCase().includes(q) ||
        a.equipment.name.toLowerCase().includes(q),
    );
  }

  return result;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ── Source pill ───────────────────────────────────────────────────────────────

function SourcePill({ source }: { source: string }) {
  if (source === "auto") {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-teal-soft text-teal border border-teal-border">
        🤖 авто
      </span>
    );
  }
  if (source === "manual") {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-slate-soft text-slate border border-slate-border">
        ✋ вручную
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-xs px-1.5 py-0.5 rounded-full bg-amber-soft text-amber border border-amber-border">
      🟡 на ревью
    </span>
  );
}

// ── KPI Card ──────────────────────────────────────────────────────────────────

function KpiCard({
  eyebrow,
  value,
  hint,
  className = "",
}: {
  eyebrow: string;
  value: string | number;
  hint?: string;
  className?: string;
}) {
  return (
    <div
      className={`bg-surface border border-border rounded-lg p-3 ${className}`}
    >
      <p className="eyebrow">{eyebrow}</p>
      <p className="mono-num text-xl font-medium text-ink mt-0.5">{value}</p>
      {hint && <p className="text-xs text-ink-2 mt-0.5">{hint}</p>}
    </div>
  );
}

// ── Filter Pills ──────────────────────────────────────────────────────────────

function FilterPills({
  filter,
  onChange,
  counts,
}: {
  filter: FilterKey;
  onChange: (f: FilterKey) => void;
  counts: {
    all: number;
    confirmed: number;
    pending: number;
    auto: number;
    manual: number;
  };
}) {
  const pills: { key: FilterKey; label: string; icon: string }[] = [
    { key: "all", label: "Все", icon: "" },
    { key: "confirmed", label: "Подтверждённые", icon: "🟢" },
    { key: "pending", label: "На ревью", icon: "🟡" },
    { key: "auto", label: "Авто-обучение", icon: "🤖" },
    { key: "manual", label: "Вручную", icon: "✋" },
  ];

  return (
    <div className="flex gap-1 p-1 bg-surface-2 rounded-lg w-fit flex-wrap">
      {pills.map(({ key, label, icon }) => {
        const active = filter === key;
        const count = counts[key];
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={[
              "px-3 py-1.5 text-xs rounded cursor-pointer flex items-center gap-1.5 transition-colors",
              active
                ? "bg-surface text-ink shadow-xs"
                : "text-ink-2 hover:text-ink",
            ].join(" ")}
          >
            {icon && <span>{icon}</span>}
            {label}
            <span
              className={[
                "mono-num text-[10.5px] px-1.5 py-0.5 rounded-full",
                active
                  ? "bg-accent-soft text-accent"
                  : "bg-border text-ink-2",
              ].join(" ")}
            >
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ── Detail Sidebar ────────────────────────────────────────────────────────────

function DetailSidebar({
  alias,
  onDelete,
  onClose,
}: {
  alias: SlangAlias;
  onDelete: (id: string) => void;
  onClose: () => void;
}) {
  const [deleting, setDeleting] = useState(false);

  async function handleDelete() {
    if (!confirm(`Удалить алиас «${alias.phraseOriginal}»?`)) return;
    setDeleting(true);
    try {
      await apiFetch(`/api/admin/slang-learning/aliases/${alias.id}`, {
        method: "DELETE",
      });
      onDelete(alias.id);
    } catch (e: unknown) {
      alert(e instanceof Error ? e.message : "Ошибка удаления");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="w-[360px] shrink-0 sticky top-5 self-start bg-surface border border-border rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="eyebrow">Выбрано</p>
          <h3 className="text-base font-semibold text-ink mt-0.5">
            «{alias.phraseOriginal}»
          </h3>
        </div>
        <button
          onClick={onClose}
          aria-label="Закрыть панель"
          className="text-ink-3 hover:text-ink text-lg leading-none mt-0.5"
        >
          ×
        </button>
      </div>

      {/* Canonical link */}
      <div className="bg-surface-2 rounded p-3 text-sm flex items-center gap-2">
        <span className="text-ink-3">→</span>
        <div>
          <p className="font-medium text-ink">{alias.equipment.name}</p>
          <p className="text-xs text-ink-3">{alias.equipment.category}</p>
        </div>
      </div>

      {/* Key-value list */}
      <dl className="space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-ink-2">Использований</dt>
          <dd className="mono-num text-ink font-medium">
            {alias.usageCount} раза
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-2">Последний раз</dt>
          <dd className="mono-num text-ink">{formatDate(alias.lastUsedAt)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-2">Первое появление</dt>
          <dd className="mono-num text-ink">{formatDate(alias.createdAt)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-2">Источник</dt>
          <dd>
            <SourcePill source={alias.source} />
          </dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-ink-2">Клиенты-источники</dt>
          <dd className="text-ink-3 text-xs">—</dd>
        </div>
      </dl>

      {/* Actions */}
      <div className="flex flex-col gap-2 pt-2 border-t border-border">
        <button className="w-full px-3 py-1.5 text-sm border border-border rounded hover:bg-surface-2 text-ink transition-colors">
          Изменить связь
        </button>
        <button className="w-full px-3 py-1.5 text-sm border border-border rounded hover:bg-surface-2 text-ink transition-colors">
          Смотреть контексты
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="w-full px-3 py-1.5 text-sm border border-rose-border rounded bg-rose-soft text-rose hover:opacity-80 transition-opacity disabled:opacity-50"
        >
          {deleting ? "Удаление…" : "Удалить"}
        </button>
      </div>
    </div>
  );
}

// ── Table row ─────────────────────────────────────────────────────────────────

function AliasRow({
  alias,
  selected,
  onClick,
}: {
  alias: SlangAlias;
  selected: boolean;
  onClick: () => void;
}) {
  const isPending = alias.source === "pending";

  return (
    <div
      onClick={onClick}
      className={[
        "grid gap-2.5 px-4 py-2.5 border-b border-border text-sm items-center cursor-pointer",
        "grid-cols-[1.4fr_24px_1.2fr_90px_120px_28px]",
        selected
          ? "bg-accent-soft shadow-[inset_2px_0_0_theme(colors.accent)]"
          : isPending
            ? "bg-amber-soft hover:bg-amber-soft/70"
            : "hover:bg-surface-2",
      ].join(" ")}
    >
      {/* Alias phrase */}
      <span className="font-mono text-ink truncate">
        {alias.phraseOriginal}
      </span>

      {/* Arrow */}
      <span className="text-ink-3 text-center">→</span>

      {/* Canonical name + category */}
      <div className="min-w-0">
        <p className="font-medium text-ink truncate">{alias.equipment.name}</p>
        <p className="text-xs text-ink-3 truncate">{alias.equipment.category}</p>
      </div>

      {/* Usage count */}
      <span className="mono-num text-xs text-ink-2 text-right">
        {alias.usageCount}×
      </span>

      {/* Source */}
      <div className="flex items-center">
        <SourcePill source={alias.source} />
      </div>

      {/* Actions placeholder */}
      <button
        onClick={(e) => e.stopPropagation()}
        aria-label="Действия с алиасом"
        className="text-ink-3 hover:text-ink text-base leading-none"
      >
        ⋯
      </button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function SlangPage() {
  useRequireRole(["SUPER_ADMIN"]);

  const [groups, setGroups] = useState<DictionaryGroup[]>([]);
  const [pendingCandidates, setPendingCandidates] = useState<SlangCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useState<FilterKey>("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [dictData, pendingData] = await Promise.all([
          apiFetch<DictionaryGroup[]>("/api/admin/slang-learning/dictionary"),
          apiFetch<SlangCandidate[]>(
            "/api/admin/slang-learning?status=PENDING",
          ),
        ]);
        if (!cancelled) {
          setGroups(dictData);
          setPendingCandidates(pendingData);
        }
      } catch (e: unknown) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Ошибка загрузки");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const allAliases = flattenGroups(groups);

  // For "pending" filter, show pending candidates as pseudo-aliases
  const pendingAsPseudo: SlangAlias[] = pendingCandidates.map((c) => ({
    id: c.id,
    phraseNormalized: c.normalizedPhrase,
    phraseOriginal: c.rawPhrase,
    equipmentId: c.proposedEquipmentId ?? "",
    confidence: c.confidence,
    source: "pending",
    createdAt: c.createdAt,
    usageCount: 0,
    lastUsedAt: c.createdAt,
    equipment: {
      name: c.proposedEquipmentName ?? "—",
      category: "—",
    },
  }));

  const displayList =
    filter === "pending"
      ? pendingAsPseudo.filter((a) => {
          const q = search.toLowerCase();
          if (!q) return true;
          return (
            a.phraseOriginal.toLowerCase().includes(q) ||
            a.equipment.name.toLowerCase().includes(q)
          );
        })
      : filterAliases(allAliases, filter, search);

  const selectedAlias =
    selectedId != null
      ? (displayList.find((a) => a.id === selectedId) ?? null)
      : null;

  const counts = {
    all: allAliases.length,
    confirmed: allAliases.filter(
      (a) => a.source === "manual" || a.source === "confirmed",
    ).length,
    pending: pendingCandidates.length,
    auto: allAliases.filter((a) => a.source === "auto").length,
    manual: allAliases.filter((a) => a.source === "manual").length,
  };

  function handleDelete(id: string) {
    setGroups((prev) =>
      prev.map((g) => ({
        ...g,
        aliases: g.aliases.filter((a) => a.id !== id),
        aliasCount: g.aliases.filter((a) => a.id !== id).length,
      })),
    );
    if (selectedId === id) setSelectedId(null);
  }

  return (
    <div className="p-4 md:p-6 max-w-6xl">
      <AdminTabNav counts={{ slang: counts.all }} />

      {/* Header */}
      <div className="mt-4 mb-5">
        <h1 className="text-xl font-semibold tracking-tight text-ink">
          Словарь сленга
        </h1>
        <p className="text-sm text-ink-2 mt-1">
          AI учится понимать, как гафферы называют оборудование. Здесь можно
          проверить, исправить или удалить выученные связи.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
        <KpiCard
          eyebrow="Всего алиасов"
          value={counts.all}
          hint="в словаре"
        />
        <KpiCard
          eyebrow="Покрытие AI"
          value="89%"
          hint="фраз распознаётся"
          className="[&_.mono-num]:text-teal"
        />
        <KpiCard
          eyebrow="На ревью"
          value={counts.pending}
          hint="требуют проверки"
          className={
            counts.pending > 0
              ? "border-amber-border bg-amber-soft"
              : ""
          }
        />
        <KpiCard
          eyebrow="За неделю"
          value={`+${counts.auto}`}
          hint="новых авто-алиасов"
        />
      </div>

      {/* Filter pills + search */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4 items-start">
        <FilterPills filter={filter} onChange={setFilter} counts={counts} />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по фразе или оборудованию…"
          className="border border-border rounded px-3 py-1.5 text-sm text-ink bg-surface placeholder-ink-3 focus:outline-none focus:border-accent-bright w-full sm:w-64"
        />
      </div>

      {/* Error */}
      {error && (
        <div className="bg-rose-soft border border-rose-border text-rose text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {/* Main two-column layout */}
      <div className="flex gap-4 items-start">
        {/* Table */}
        <div className="flex-1 bg-surface border border-border rounded-lg overflow-hidden min-w-0">
          {/* Header row */}
          <div className="grid gap-2.5 px-4 py-2 border-b border-border bg-surface-2 text-[10.5px] uppercase tracking-wider text-ink-3 font-semibold grid-cols-[1.4fr_24px_1.2fr_90px_120px_28px]">
            <span>Фраза</span>
            <span />
            <span>Оборудование</span>
            <span className="text-right">Использ.</span>
            <span>Источник</span>
            <span />
          </div>

          {/* Loading state */}
          {loading && (
            <div className="py-10 text-center text-sm text-ink-3">
              Загрузка…
            </div>
          )}

          {/* Empty state */}
          {!loading && displayList.length === 0 && (
            <div className="py-10 text-center text-sm text-ink-3">
              {search ? "Ничего не найдено" : "Словарь пуст"}
            </div>
          )}

          {/* Rows */}
          {!loading &&
            displayList.map((alias) => (
              <AliasRow
                key={alias.id}
                alias={alias}
                selected={alias.id === selectedId}
                onClick={() =>
                  setSelectedId(alias.id === selectedId ? null : alias.id)
                }
              />
            ))}
        </div>

        {/* Detail sidebar */}
        {selectedAlias && (
          <DetailSidebar
            alias={selectedAlias}
            onDelete={handleDelete}
            onClose={() => setSelectedId(null)}
          />
        )}
      </div>
    </div>
  );
}
