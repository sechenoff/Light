"use client";

/**
 * RepairPanel — the AMBER «🔧 Ремонт» expanded panel inside a RETURN row.
 *
 * Visual source of truth: docs/mockups/warehouse-scan/01-return-checklist.html
 * `.row.exp-fix` / `.exp-body` — an amber-tinted block containing:
 *  - a comment <textarea> («Что сломалось?»),
 *  - a strip of photo thumbnails + a «📷 Фото» camera button,
 *  - the note line «→ создаст карточку ремонта, фото видны руководителю».
 *
 * CONTROLLED: the parent (ReturnChecklist, Task 7.2) owns the comment state
 * (`comment` / `onCommentChange`) so it can validate "comment required per
 * flagged row" before POSTing /complete. This panel does NOT call /complete —
 * it only (a) edits the controlled comment and (b) STAGES photos against the
 * session via `api.uploadPhoto` (an inherently server-side side effect: the
 * backend stores them so they can attach to the repair card on completion).
 *
 * Photo thumbnails — important limitation (per Task 7.1 reading note):
 *  There is NO endpoint to stream a *staged* (pre-complete) photo back as an
 *  image. `GET /api/repairs/:id/photos/:photoId` only exists AFTER completion.
 *  So we can only render a real <img> preview for photos captured THIS mount,
 *  using an in-memory object URL (`URL.createObjectURL`, revoked on
 *  unmount/removal). Photos returned by `listPhotos` without an in-memory blob
 *  (e.g. the row was re-opened) render as a neutral canon placeholder thumb
 *  with the filename — we deliberately do NOT fabricate a streaming URL.
 *
 * Never renders a barcode (product rule: hidden barcode IDs). Real
 * <button>/<textarea> semantics; Russian aria-labels; emoji aria-hidden;
 * touch targets ≥ 40px. Semantic canon tokens only (no hex / no raw slate-###).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { scanApi } from "./api";
import { isScanApiError } from "./types";

/**
 * A staged photo as the panel tracks it locally. `objectUrl` is present only
 * for blobs captured during THIS mount (it is what we can actually preview);
 * `null` means the name came back from `listPhotos` with no in-memory blob, so
 * it renders as a placeholder thumb (see file header note).
 */
interface StagedPhoto {
  name: string;
  objectUrl: string | null;
}

export function RepairPanel({
  sessionId,
  unitId,
  comment,
  onCommentChange,
  disabled = false,
}: {
  sessionId: string;
  unitId: string;
  comment: string;
  onCommentChange: (s: string) => void;
  disabled?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<StagedPhoto[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track every object URL we mint so we can revoke them on unmount (avoids
  // leaking blob: URLs). Keyed by photo name.
  const objectUrlsRef = useRef<Map<string, string>>(new Map());

  const revokeAll = useCallback(() => {
    for (const url of objectUrlsRef.current.values()) {
      URL.revokeObjectURL(url);
    }
    objectUrlsRef.current.clear();
  }, []);

  // On mount, pull already-staged photos so a re-opened panel shows them.
  // No in-memory blob exists for these → placeholder thumb + filename.
  // Cancellation pattern (sibling canon: AddonSearch / DayTechnician).
  useEffect(() => {
    let cancelled = false;
    scanApi
      .listPhotos(sessionId, unitId)
      .then((res) => {
        if (cancelled) return;
        setPhotos((prev) => {
          const known = new Set(prev.map((p) => p.name));
          const extra = res.photos
            .filter((name) => !known.has(name))
            .map((name) => ({ name, objectUrl: null }));
          return [...prev, ...extra];
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          isScanApiError(err)
            ? err.message
            : "Не удалось загрузить ранее снятые фото",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, unitId]);

  // Revoke all minted object URLs on unmount.
  useEffect(() => revokeAll, [revokeAll]);

  function openCamera() {
    fileInputRef.current?.click();
  }

  async function handleFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const list = e.target.files;
    if (!list || list.length === 0) return;
    const files = Array.from(list);
    // Reset the input so picking the same file again still fires `change`.
    e.target.value = "";

    setBusy(true);
    setError(null);
    // Resilient: upload EVERY selected file. A failed upload (e.g. one bad
    // photo in a multi-shot capture) must NOT abort the rest — losing damage
    // photos silently is a real data-loss risk. We try/catch PER FILE,
    // continue past failures, and report a partial-failure summary at the end.
    const failed: string[] = [];
    let succeeded = 0;
    try {
      for (const file of files) {
        try {
          const res = await scanApi.uploadPhoto(sessionId, unitId, file);
          // Mint + track the object URL ONLY after a successful upload, so a
          // failed file never leaks a blob: URL.
          const objectUrl = URL.createObjectURL(file);
          // The server response (`res.photos`) is authoritative for names;
          // pair the freshly returned name(s) with our in-memory blob
          // preview. We use the last returned name as this file's name (the
          // API appends).
          const newName = res.photos[res.photos.length - 1] ?? file.name;
          objectUrlsRef.current.set(newName, objectUrl);
          setPhotos((prev) => {
            const merged = res.photos.map((name) => {
              const existing = prev.find((p) => p.name === name);
              if (existing) return existing;
              return {
                name,
                objectUrl: name === newName ? objectUrl : null,
              };
            });
            // Preserve any locally-known previews not echoed (defensive).
            const carried = prev.filter(
              (p) => p.objectUrl && !merged.some((m) => m.name === p.name),
            );
            return [...merged, ...carried];
          });
          succeeded += 1;
        } catch {
          // Swallow per-file so the loop continues; record the filename so
          // the operator knows exactly which photos to re-take.
          failed.push(file.name);
        }
      }
      if (failed.length > 0) {
        setError(
          `Загружено ${succeeded} из ${files.length}. Не удалось: ${failed.join(", ")}`,
        );
      } else {
        setError(null);
      }
    } finally {
      setBusy(false);
    }
  }

  async function deletePhoto(name: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await scanApi.deletePhoto(sessionId, unitId, name);
      const removed = objectUrlsRef.current.get(name);
      if (removed) {
        URL.revokeObjectURL(removed);
        objectUrlsRef.current.delete(name);
      }
      setPhotos(
        res.photos.map((n) => ({
          name: n,
          objectUrl: objectUrlsRef.current.get(n) ?? null,
        })),
      );
    } catch (err: unknown) {
      setError(
        isScanApiError(err) ? err.message : "Не удалось удалить фото",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="rounded-lg border border-amber-border bg-amber-soft px-3 py-3"
      aria-label="Ремонт — комментарий и фото поломки"
    >
      <label className="sr-only" htmlFor={`repair-comment-${unitId}`}>
        Что сломалось
      </label>
      <textarea
        id={`repair-comment-${unitId}`}
        rows={2}
        value={comment}
        disabled={disabled}
        onChange={(e) => onCommentChange(e.target.value)}
        placeholder="Что сломалось?"
        aria-label="Что сломалось — описание поломки"
        className="block w-full resize-none rounded-md border border-amber-border bg-surface px-2.5 py-2 text-[13px] text-ink outline-none placeholder:text-ink-3 focus:border-amber disabled:opacity-50"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {photos.map((p) => (
          <div
            key={p.name}
            className="relative h-12 w-12 shrink-0 overflow-hidden rounded-md border border-amber-border bg-surface"
          >
            {p.objectUrl ? (
              <img
                src={p.objectUrl}
                alt={`Фото поломки: ${p.name}`}
                className="h-full w-full object-cover"
              />
            ) : (
              // No in-memory blob & no staged-photo stream endpoint → neutral
              // canon placeholder with the filename (see file header note).
              <span
                className="flex h-full w-full flex-col items-center justify-center px-0.5 text-center text-ink-3"
                title={p.name}
              >
                <span aria-hidden="true" className="text-base leading-none">
                  🖼
                </span>
                <span className="mt-0.5 w-full truncate text-[8px] leading-tight">
                  {p.name}
                </span>
              </span>
            )}
            <button
              type="button"
              onClick={() => void deletePhoto(p.name)}
              disabled={disabled || busy}
              aria-label={`Удалить фото ${p.name}`}
              className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-bl-md bg-rose text-[11px] leading-none text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <span aria-hidden="true">✕</span>
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={openCamera}
          disabled={disabled || busy}
          aria-label="Сфотографировать поломку камерой"
          className="flex h-12 w-12 shrink-0 flex-col items-center justify-center rounded-md bg-accent text-[11px] font-semibold leading-tight text-white transition-opacity hover:opacity-95 disabled:opacity-60"
        >
          <span aria-hidden="true" className="text-base leading-none">
            📷
          </span>
          <span>{busy ? "…" : "Фото"}</span>
        </button>

        {/* Native phone camera capture. `capture="environment"` opens the rear
            camera directly on mobile; falls back to a file picker elsewhere. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          hidden
          aria-hidden="true"
          tabIndex={-1}
          onChange={handleFiles}
        />
      </div>

      {error && (
        <p
          role="alert"
          className="mt-2 rounded-md border border-rose-border bg-rose-soft px-2.5 py-1.5 text-[12px] text-rose"
        >
          {error}
        </p>
      )}

      <p className="mt-2 text-[11px] leading-snug text-amber">
        → создаст карточку ремонта, фото видны руководителю
      </p>
    </div>
  );
}
