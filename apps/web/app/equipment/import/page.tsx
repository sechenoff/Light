"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type PreviewResponse = {
  sheetName: string;
  headers: string[];
  sampleRows: Record<string, unknown>[];
  suggestedMapping: Record<string, string>;
};

const FIELD_KEYS = [
  "category",
  "name",
  "brand",
  "model",
  "quantity",
  "rentalRatePerShift",
  "comment",
  "serialNumber",
  "internalInventoryNumber",
] as const;

type MappingState = Partial<Record<(typeof FIELD_KEYS)[number], string>>;

function mappingValueOrEmpty(v: string | undefined) {
  return v ?? "";
}

export default function EquipmentImportPage() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [mapping, setMapping] = useState<MappingState>({});
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [commitResult, setCommitResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const canPreview = !!file;
  const headers = preview?.headers ?? [];

  async function handlePreview() {
    if (!file) return;
    setLoadingPreview(true);
    setError(null);
    setCommitResult(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/equipment/import/preview`, {
        method: "POST",
        body: form,
        credentials: "include",
      }).then((r) => r.json());

      setPreview(res as PreviewResponse);
      const suggested = (res as PreviewResponse).suggestedMapping ?? {};
      setMapping((prev) => {
        const next: MappingState = { ...prev };
        for (const k of Object.keys(suggested)) {
          next[k as keyof MappingState] = suggested[k];
        }
        return next;
      });
    } catch (e: any) {
      setError(e?.message ?? "Ошибка предпросмотра");
    } finally {
      setLoadingPreview(false);
    }
  }

  async function handleCommit() {
    if (!file || !preview) return;
    setError(null);
    setCommitResult(null);

    const mappingPayload: any = {};
    // The backend expects only fields present in mapping schema.
    for (const key of FIELD_KEYS) {
      const v = mapping[key];
      if (v && v.trim()) mappingPayload[key] = v;
    }

    // For count-based imports we need quantity; for unit-based it's optional.
    const body = mappingPayload;
    const form = new FormData();
    form.append("file", file);
    form.append("mapping", JSON.stringify(body));

    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000"}/api/equipment/import/commit`, {
        method: "POST",
        body: form,
        credentials: "include",
      }).then((r) => r.json());
      setCommitResult(res);
    } catch (e: any) {
      setError(e?.message ?? "Ошибка импорта");
    }
  }

  const samplePreview = useMemo(() => preview?.sampleRows?.slice(0, 8) ?? [], [preview]);

  return (
    <div className="p-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-xl font-semibold">Импорт парка техники (Excel)</h1>
        <button className="text-sm text-slate-600 hover:text-slate-900" onClick={() => router.push("/equipment")}>
          Назад к списку
        </button>
      </div>

      <div className="mt-4 rounded border border-slate-200 bg-white overflow-hidden">
        <div className="p-3 border-b border-slate-200">
          <div className="flex items-center gap-4 flex-wrap">
            <input
              type="file"
              accept=".xlsx,.xls"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setFile(f);
                setPreview(null);
                setCommitResult(null);
              }}
            />
            <button className="rounded bg-slate-900 text-white px-4 py-2 hover:bg-slate-800 disabled:opacity-50" disabled={!canPreview || loadingPreview} onClick={handlePreview}>
              {loadingPreview ? "Читаю..." : "Прочитать и предложить сопоставление"}
            </button>
          </div>
        </div>

        {preview ? (
          <div className="p-3 grid grid-cols-1 lg:grid-cols-12 gap-4">
            <div className="lg:col-span-7">
              <div className="text-sm text-slate-700 font-semibold">Сопоставление колонок</div>
              <div className="mt-2 space-y-2">
                {FIELD_KEYS.map((k) => (
                  <div key={k} className="flex items-center gap-3">
                    <div className="w-[180px] text-xs text-slate-600">{k}</div>
                    <select
                      className="flex-1 rounded border border-slate-300 px-2 py-1 bg-white"
                      value={mappingValueOrEmpty(mapping[k])}
                      onChange={(e) => setMapping((prev) => ({ ...prev, [k]: e.target.value || undefined }))}
                    >
                      <option value="">(не используется)</option>
                      {headers.map((h) => (
                        <option value={h} key={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
                <div className="text-sm font-semibold text-slate-700">Предпросмотр строк</div>
                <div className="text-xs text-slate-500 mt-1">Показываем первые строки из файла, чтобы было легче проверить соответствие.</div>
                <div className="mt-2 overflow-auto max-h-[260px] border rounded border-slate-200 bg-white">
                  <table className="min-w-[680px] w-full text-xs">
                    <thead className="bg-slate-50">
                      <tr>
                        {(preview.headers ?? []).slice(0, 8).map((h) => (
                          <th key={h} className="text-left px-2 py-2 border-b border-slate-200">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {samplePreview.map((row, idx) => (
                        <tr key={idx} className="border-t border-slate-100">
                          {(preview.headers ?? []).slice(0, 8).map((h) => (
                            <td key={h} className="px-2 py-1">
                              {String(row[h] ?? "")}
                            </td>
                          ))}
                        </tr>
                      ))}
                      {samplePreview.length === 0 ? (
                        <tr>
                          <td className="px-2 py-3 text-center text-slate-500" colSpan={8}>
                            Нет данных
                          </td>
                        </tr>
                      ) : null}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>

            <div className="lg:col-span-5">
              <div className="text-sm font-semibold text-slate-700">Запуск импорта</div>
              <div className="mt-2 text-sm text-slate-600">
                Импорт создаст новые позиции или обновит существующие по ключу <span className="font-mono">категория+наименование+бренд+модель</span>.
              </div>
              <div className="mt-3">
                <button className="w-full rounded bg-emerald-600 text-white px-4 py-3 hover:bg-emerald-500 disabled:opacity-50" onClick={handleCommit}>
                  Импортировать в базу
                </button>
              </div>

              {error ? <div className="mt-3 rounded border border-rose-200 bg-rose-50 text-rose-700 p-3 text-sm">{error}</div> : null}
              {commitResult ? (
                <div className="mt-3 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 space-y-1">
                  <div className="font-semibold">Готово</div>
                  <div>Создано: {commitResult.created}</div>
                  <div>Обновлено: {commitResult.updated}</div>
                  <div>Добавлено единиц (если serial): {commitResult.unitsAdded}</div>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="p-3 text-sm text-slate-600">Загрузите Excel-файл, чтобы увидеть предпросмотр и сопоставить колонки.</div>
        )}
      </div>
    </div>
  );
}

