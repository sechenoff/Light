"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";

export interface BarcodeScannerProps {
  onScan: (value: string) => void;
  /** Supported barcode formats. Default: [CODE_128] */
  formats?: Html5QrcodeSupportedFormats[];
  /** Frames per second. Default: 5 */
  fps?: number;
  /** Enable torch toggle button. Default: true */
  enableTorch?: boolean;
  /** Flash border color on scan result: "green" | "red" | "amber" | null */
  flashColor?: "green" | "red" | "amber" | null;
}

const DEFAULT_FORMATS = [Html5QrcodeSupportedFormats.CODE_128];

export default function BarcodeScanner({
  onScan,
  formats = DEFAULT_FORMATS,
  fps = 5,
  enableTorch = true,
  flashColor = null,
}: BarcodeScannerProps) {
  const containerId = useRef(`barcode-scanner-${Math.random().toString(36).slice(2, 8)}`);
  const containerRef = useRef<HTMLDivElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  // formats/fps читаем через ref: иначе, если родитель передаёт formats инлайн-
  // литералом (новый массив каждый рендер), камера-useEffect с deps [formats,fps]
  // перезапускался на КАЖДОМ рендере — это ловило «Maximum update depth exceeded»
  // (мигание камеры, теринг). Стартуем камеру один раз на маунт (deps []).
  const formatsRef = useRef(formats);
  formatsRef.current = formats;
  const fpsRef = useRef(fps);
  fpsRef.current = fps;
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [torchOn, setTorchOn] = useState(false);
  const [cameraError, setCameraError] = useState(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Wake Lock management
  useEffect(() => {
    async function requestWakeLock() {
      try {
        if ("wakeLock" in navigator) {
          wakeLockRef.current = await navigator.wakeLock.request("screen");
          wakeLockRef.current.addEventListener("release", () => {
            wakeLockRef.current = null;
          });
        }
      } catch {
        // Wake Lock not available or denied — not critical
      }
    }

    requestWakeLock();

    return () => {
      wakeLockRef.current?.release().catch(() => {});
    };
  }, []);

  // Camera scanner
  useEffect(() => {
    if (!containerRef.current) return;

    // Dynamic qrbox: 85% width, 25% height of viewfinder
    const qrboxFunction = (viewfinderWidth: number, viewfinderHeight: number) => ({
      width: Math.floor(viewfinderWidth * 0.85),
      height: Math.floor(viewfinderHeight * 0.25),
    });

    let scanner: Html5Qrcode | null = null;
    let started: Promise<null> | null = null;
    // Старт — отдельной макрозадачей: StrictMode в dev сразу размонтирует эффект
    // и монтирует заново, отменённый таймер не запускает вторую камеру в тот же
    // контейнер. То же при уходе со страницы до старта.
    const startTimer = setTimeout(() => {
      const instance = new Html5Qrcode(containerId.current, {
        formatsToSupport: formatsRef.current,
        useBarCodeDetectorIfSupported: true,
        verbose: undefined,
      });
      scanner = instance;
      scannerRef.current = instance;
      started = instance.start(
        { facingMode: "environment" },
        { fps: fpsRef.current, qrbox: qrboxFunction },
        (decodedText) => onScanRef.current(decodedText),
        () => {},
      );
      started.catch(() => {
        setCameraError(true);
      });
    }, 0);

    return () => {
      clearTimeout(startTimer);
      scannerRef.current = null;
      const instance = scanner;
      // stop() бросает СИНХРОННО, пока старт не завершён (библиотека ещё в
      // NOT_STARTED) — исключение из cleanup роняло страницу (смена режима,
      // «Закрыть» до старта камеры). Останавливаем только после успешного старта:
      // камеру, стартовавшую уже после размонтирования, всё равно закроем, а
      // упавший старт stop() не вызывает.
      started?.then(() => instance?.stop()).catch(() => {});
    };
    // Стартуем камеру один раз на маунт; formats/fps — через ref (см. выше).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = useCallback(() => {
    const scanner = scannerRef.current;
    if (!scanner) return;
    const next = !torchOn;
    try {
      scanner.applyVideoConstraints({ advanced: [{ torch: next } as any] }).catch(() => {});
      setTorchOn(next);
    } catch {
      // Камера ещё не запущена: applyVideoConstraints бросает синхронно.
    }
  }, [torchOn]);

  // Flash border animation
  const borderColor =
    flashColor === "green"
      ? "border-emerald"
      : flashColor === "red"
        ? "border-rose"
        : flashColor === "amber"
          ? "border-amber"
          : "border-transparent";

  // Сканер живёт в зоне камеры с фоном bg-black в обеих темах — отсюда on-inverse.
  if (cameraError) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-8 text-center">
        <p className="text-on-inverse mb-2">📷 Нет доступа к камере</p>
        <p className="text-on-inverse/70 text-sm">
          Разрешите доступ к камере в настройках браузера или используйте ручной ввод
        </p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* html5-qrcode ставит <video> inline-ширину в px и высоту по пропорциям
          потока — растягиваем его на зону камеры (!important перебивает inline).
          Область распознавания при object-cover остаётся центрированной и не
          меньше видимой рамки: библиотека пересчитывает её через videoWidth. */}
      <div
        className={`relative h-full rounded-lg overflow-hidden border-4 transition-colors duration-300 [&_video]:!h-full [&_video]:!w-full [&_video]:object-cover ${borderColor}`}
      >
        <div id={containerId.current} ref={containerRef} className="h-full" />
      </div>
      {enableTorch && (
        <button
          type="button"
          onClick={toggleTorch}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 inline-flex h-10 items-center gap-1.5 whitespace-nowrap rounded bg-inverse/80 px-4 text-sm font-medium text-on-inverse hover:bg-inverse transition-colors"
        >
          {torchOn ? "🔦 Фонарик вкл." : "🔦 Фонарик"}
        </button>
      )}
    </div>
  );
}
