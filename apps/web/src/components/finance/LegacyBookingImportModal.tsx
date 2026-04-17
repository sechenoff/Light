"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../lib/api";
import { parseLegacyFilename } from "../../lib/legacyBookingParser";
import { parseLegacyExcelAmount } from "../../lib/legacyBookingExcel";

type Props = {
  open: boolean;
  onClose: () => void;
  onImported: () => void;
};

type RowStatus = "ready" | "from-excel" | "needs-amount" | "error";

interface PreviewRow {
  /** Оригинальное имя файла */
  filename: string;
  date: string; // YYYY-MM-DD для input[type=date]
  clientName: string;
  amount: string; // строка для input, конвертируем при отправке
  status: RowStatus;
  isDuplicate: boolean;
  /** Для input[type=date] минимальный формат */
  _file: File;
}

function rowStatusLabel(status: RowStatus): string {
  switch (status) {
    case "ready": return "готов";
    case "from-excel": return "из Excel";
    case "needs-amount": return "нужна ₽";
    case "error": return "ошибка";
  }
}

function rowStatusCls(status: RowStatus): string {
  switch (status) {
    case "ready":
    case "from-excel":
      return "bg-emerald-soft text-emerald border border-emerald-border";
    case "needs-amount":
      return "bg-amber-soft text-amber border border-amber-border";
    case "error":
      return "bg-rose-soft text-rose border border-rose-border";
  }
}

function computeStatus(row: Omit<PreviewRow, "status">): RowStatus {
  const hasDate = row.date.length > 0;
  const hasClient = row.clientName.trim().length > 0;
  const hasAmount = row.amount.trim().length > 0 && Number(row.amount) > 0;
  if (!hasDate || !hasClient) return "error";
  if (!hasAmount) return "needs-amount";
  return "ready";
}

function toIsoDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function LegacyBookingImportModal({ open, onClose, onImported }: Props) {
  const [step, setStep] = useState<"files" | "preview" | "submitting" | "done">("files");
  const [rows, setRows] = useState<PreviewRow[]>([]);
  const [result, setResult] = useState<{ created: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setStep("files");
      setRows([]);
      setResult(null);
      setError(null);
    }
  }, [open]);

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step !== "submitting") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step, onClose]);

  if (!open) return null;

  const currentYear = new Date().getFullYear();

  async function processFiles(files: File[]) {
    const validFiles = files.filter((f) => /\.(xlsx?|xls)$/i.test(f.name));
    if (validFiles.length === 0) return;

    const newRows: PreviewRow[] = await Promise.all(
      validFiles.map(async (file) => {
        const parsed = parseLegacyFilename(file.name, currentYear);

        let amount = parsed.amount !== null ? String(parsed.amount) : "";
        let status: RowStatus;

        // Если суммы нет в имени — парсим Excel
        if (parsed.amount === null) {
          try {
            const excelResult = await parseLegacyExcelAmount(file);
            if (excelResult.amount !== null) {
              amount = String(excelResult.amount);
              status = "from-excel";
            } else {
              status = "needs-amount";
            }
          } catch {
            status = "needs-amount";
          }
        } else {
          status = "ready";
        }

        const dateStr = parsed.date ? toIsoDate(parsed.date) : "";

        // Перепроверяем статус с учётом наличия клиента и даты
        const partialRow = {
          filename: file.name,
          date: dateStr,
          clientName: parsed.clientName,
          amount,
          isDuplicate: parsed.isDuplicate,
          _file: file,
        };
        if (!dateStr || !parsed.clientName) {
          status = "error";
        }

        return { ...partialRow, status };
      }),
    );

    setRows((prev) => {
      const combined = [...prev, ...newRows];
      return combined;
    });
    setStep("preview");
  }

  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    void processFiles(files);
  }

  function handleFileInput(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    void processFiles(files);
  }

  function updateRow(index: number, patch: Partial<Pick<PreviewRow, "date" | "clientName" | "amount">>) {
    setRows((prev) => {
      const next = [...prev];
      const row = { ...next[index], ...patch };
      row.status = computeStatus(row);
      next[index] = row;
      return next;
    });
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  const validRows = rows.filter((r) => r.status === "ready" || r.status === "from-excel");
  const errorRows = rows.filter((r) => r.status === "error" || r.status === "needs-amount");

  async function handleSubmit() {
    setStep("submitting");
    setError(null);
    try {
      const payload = {
        rows: validRows.map((r) => ({
          filename: r.filename,
          clientName: r.clientName.trim(),
          date: new Date(`${r.date}T00:00:00.000Z`).toISOString(),
          amount: Number(r.amount),
        })),
      };
      const res = await apiFetch<{ created: number }>("/api/finance/import-legacy-bookings", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setResult(res);
      setStep("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Ошибка импорта");
      setStep("preview");
    }
  }

  function handleDone() {
    onImported();
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => {
        if (e.target === e.currentTarget && step !== "submitting") onClose();
      }}
    >
      <div className="bg-surface border border-border rounded-lg shadow-xl w-full max-w-3xl mx-4 flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div>
            <p className="eyebrow text-ink-3 mb-0.5">Финансы</p>
            <h2 className="text-[16px] font-semibold text-ink">Импорт прошедших съёмок</h2>
          </div>
          <button
            aria-label="Закрыть"
            onClick={onClose}
            disabled={step === "submitting"}
            className="w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:bg-surface-subtle text-lg disabled:opacity-40"
          >
            ×
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {step === "files" || (step === "preview" && rows.length === 0) ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleFileDrop}
              className={`flex flex-col items-center justify-center border-2 border-dashed rounded-lg py-12 cursor-pointer transition-colors ${
                dragging ? "border-accent bg-accent-soft" : "border-border hover:border-accent-border"
              }`}
              onClick={() => fileInputRef.current?.click()}
            >
              <p className="text-[15px] font-medium text-ink mb-1">Перетащите файлы сюда</p>
              <p className="text-xs text-ink-3">Поддерживаются .xlsx и .xls · несколько файлов</p>
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls"
                multiple
                className="hidden"
                onChange={handleFileInput}
              />
            </div>
          ) : step === "preview" || step === "submitting" ? (
            <>
              {/* Add more files button */}
              <div className="flex items-center justify-between mb-3">
                <p className="text-xs text-ink-2">
                  {rows.length} {rows.length === 1 ? "файл" : rows.length < 5 ? "файла" : "файлов"}
                </p>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="text-xs text-accent-bright hover:underline"
                >
                  + Добавить файлы
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls"
                  multiple
                  className="hidden"
                  onChange={handleFileInput}
                />
              </div>

              {/* Preview table */}
              <div className="border border-border rounded overflow-hidden">
                <table className="w-full text-[12px] border-collapse">
                  <thead>
                    <tr className="bg-surface-subtle">
                      <th className="text-left px-3 py-2 eyebrow border-b border-border">Файл</th>
                      <th className="text-left px-3 py-2 eyebrow border-b border-border">Дата</th>
                      <th className="text-left px-3 py-2 eyebrow border-b border-border">Клиент</th>
                      <th className="text-right px-3 py-2 eyebrow border-b border-border">Сумма ₽</th>
                      <th className="text-center px-3 py-2 eyebrow border-b border-border">Статус</th>
                      <th className="w-6 border-b border-border" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={i} className="border-b border-border last:border-0">
                        <td className="px-3 py-2 text-ink-2 max-w-[160px] truncate" title={row.filename}>
                          {row.filename}
                          {row.isDuplicate && (
                            <span className="ml-1 text-[10px] text-ink-3">(дубль)</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="date"
                            value={row.date}
                            onChange={(e) => updateRow(i, { date: e.target.value })}
                            className="border border-border rounded px-1.5 py-0.5 text-xs text-ink bg-surface w-[120px]"
                          />
                        </td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={row.clientName}
                            onChange={(e) => updateRow(i, { clientName: e.target.value })}
                            placeholder="Имя клиента"
                            className="border border-border rounded px-1.5 py-0.5 text-xs text-ink bg-surface w-[120px]"
                          />
                        </td>
                        <td className="px-3 py-2 text-right">
                          <input
                            type="number"
                            value={row.amount}
                            onChange={(e) => updateRow(i, { amount: e.target.value })}
                            placeholder="0"
                            min={0}
                            className="border border-border rounded px-1.5 py-0.5 text-xs text-ink bg-surface w-[90px] text-right"
                          />
                        </td>
                        <td className="px-3 py-2 text-center">
                          <span className={`inline-block text-[10.5px] font-semibold px-2 py-0.5 rounded-full ${rowStatusCls(row.status)}`}>
                            {rowStatusLabel(row.status)}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <button
                            aria-label="Удалить строку"
                            onClick={() => removeRow(i)}
                            className="w-5 h-5 flex items-center justify-center rounded text-ink-3 hover:text-rose hover:bg-rose-soft text-sm"
                          >
                            ×
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {error && (
                <p className="mt-3 text-xs text-rose bg-rose-soft border border-rose-border rounded px-3 py-2">
                  {error}
                </p>
              )}
            </>
          ) : step === "done" ? (
            <div className="flex flex-col items-center py-8 gap-3">
              <div className="w-12 h-12 rounded-full bg-emerald-soft flex items-center justify-center text-emerald text-2xl">
                ✓
              </div>
              <p className="text-[16px] font-semibold text-ink">Импорт завершён</p>
              <p className="text-sm text-ink-2">
                {result?.created ?? 0}{" "}
                {(result?.created ?? 0) === 1 ? "бронь" : (result?.created ?? 0) < 5 ? "брони" : "броней"} добавлено в систему
              </p>
            </div>
          ) : null}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border flex items-center justify-between">
          {step === "preview" || step === "submitting" ? (
            <p className="text-xs text-ink-3">
              <span className="text-emerald font-medium">{validRows.length}</span> готово к импорту
              {errorRows.length > 0 && (
                <>, <span className="text-rose font-medium">{errorRows.length}</span> с ошибкой</>
              )}
            </p>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            {step !== "done" && (
              <button
                type="button"
                onClick={onClose}
                disabled={step === "submitting"}
                className="px-4 py-1.5 text-sm border border-border rounded text-ink-2 hover:bg-surface-subtle disabled:opacity-40"
              >
                Отмена
              </button>
            )}
            {(step === "preview" || step === "submitting") && (
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={step === "submitting" || validRows.length === 0}
                className="px-4 py-1.5 text-sm bg-accent text-white rounded border border-accent hover:bg-accent-bright disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {step === "submitting"
                  ? "Импортируется…"
                  : `Импортировать ${validRows.length} ${validRows.length === 1 ? "бронь" : validRows.length < 5 ? "брони" : "броней"}`}
              </button>
            )}
            {step === "done" && (
              <button
                type="button"
                onClick={handleDone}
                className="px-4 py-1.5 text-sm bg-accent text-white rounded border border-accent hover:bg-accent-bright"
              >
                Готово
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
