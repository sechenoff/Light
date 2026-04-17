"use client";

type ClientProjectCardProps = {
  clientName: string;
  onClientNameChange: (v: string) => void;
  projectName: string;
  onProjectNameChange: (v: string) => void;
  /** When true, the client name field is read-only (edit mode — client cannot be changed after creation). */
  clientReadOnly?: boolean;
};

export function ClientProjectCard({
  clientName,
  onClientNameChange,
  projectName,
  onProjectNameChange,
  clientReadOnly = false,
}: ClientProjectCardProps) {
  const initials = clientName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="bg-surface border border-border rounded-md shadow-xs overflow-hidden mb-3.5">
      <div className="px-5 py-3 border-b border-border bg-surface-muted">
        <h3 className="eyebrow text-ink">1. Клиент и проект</h3>
      </div>
      <div className="p-5 space-y-3">
        {/* Client field */}
        <div>
          <label className="flex justify-between text-[11.5px] text-ink-2 mb-1.5">
            <span>Клиент</span>
          </label>
          {clientReadOnly ? (
            <div className="inline-flex items-center gap-2.5 px-1.5 py-1.5 pr-2.5 bg-surface-muted border border-border rounded">
              <span className="w-6 h-6 rounded-sm bg-ink text-white text-[11px] font-semibold font-mono flex items-center justify-center">
                {initials || "?"}
              </span>
              <span className="text-[13px] text-ink font-medium">{clientName.trim()}</span>
              <span className="text-xs text-ink-3 italic ml-1">нельзя изменить</span>
            </div>
          ) : (
            <>
              {clientName.trim() ? (
                <div className="inline-flex items-center gap-2.5 px-1.5 py-1.5 pr-2.5 bg-surface-muted border border-border rounded mb-2">
                  <span className="w-6 h-6 rounded-sm bg-ink text-white text-[11px] font-semibold font-mono flex items-center justify-center">
                    {initials || "?"}
                  </span>
                  <span className="text-[13px] text-ink font-medium">{clientName.trim()}</span>
                  <button
                    type="button"
                    className="text-ink-3 hover:text-ink text-sm leading-none px-1"
                    onClick={() => onClientNameChange("")}
                    aria-label="Очистить клиента"
                  >
                    x
                  </button>
                </div>
              ) : null}
              <input
                className="w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
                value={clientName}
                onChange={(e) => onClientNameChange(e.target.value)}
                placeholder="Название компании / заказчика"
              />
            </>
          )}
        </div>

        {/* Project name field */}
        <div>
          <label className="flex justify-between text-[11.5px] text-ink-2 mb-1.5">
            <span>Название проекта</span>
            <span className="text-ink-3 italic text-[11px]">опционально</span>
          </label>
          <input
            className="w-full rounded border border-border-strong px-3 py-2 text-[13.5px] text-ink bg-surface focus:outline-none focus:border-accent-bright focus:ring-[3px] focus:ring-accent-soft"
            value={projectName}
            onChange={(e) => onProjectNameChange(e.target.value)}
            placeholder="Клип «Лето» · Артист Иванов"
          />
        </div>
      </div>
    </div>
  );
}
