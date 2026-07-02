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

    const scanner = new Html5Qrcode(containerId.current, {
      formatsToSupport: formatsRef.current,
      useBarCodeDetectorIfSupported: true,
      verbose: undefined,
    });
    scannerRef.current = scanner;

    // Dynamic qrbox: 85% width, 25% height of viewfinder
    const qrboxFunction = (viewfinderWidth: number, viewfinderHeight: number) => ({
      width: Math.floor(viewfinderWidth * 0.85),
      height: Math.floor(viewfinderHeight * 0.25),
    });

    scanner
      .start(
        { facingMode: "environment" },
        { fps: fpsRef.current, qrbox: qrboxFunction },
        (decodedText) => onScanRef.current(decodedText),
        () => {},
      )
      .catch(() => {
        setCameraError(true);
      });

    return () => {
      scannerRef.current = null;
      scanner.stop().catch(() => {});
    };
    // Стартуем камеру один раз на маунт; formats/fps — через ref (см. выше).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTorch = useCallback(() => {
    const next = !torchOn;
    setTorchOn(next);
    scannerRef.current
      ?.applyVideoConstraints({ advanced: [{ torch: next } as any] })
      .catch(() => {});
  }, [torchOn]);

  // Flash border animation
  const borderColor =
    flashColor === "green"
      ? "border-green-500"
      : flashColor === "red"
        ? "border-red-500"
        : flashColor === "amber"
          ? "border-amber-500"
          : "border-transparent";

  if (cameraError) {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-slate-50 rounded-lg border border-slate-200">
        <p className="text-slate-600 text-center mb-2">📷 Нет доступа к камере</p>
        <p className="text-slate-400 text-sm text-center">
          Разрешите доступ к камере в настройках браузера или используйте ручной ввод
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div
        className={`relative rounded-lg overflow-hidden border-4 transition-colors duration-300 ${borderColor}`}
      >
        <div id={containerId.current} ref={containerRef} />
      </div>
      {enableTorch && (
        <button
          type="button"
          onClick={toggleTorch}
          className="mt-2 w-full py-2 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50 transition-colors"
        >
          {torchOn ? "🔦 Фонарик вкл." : "🔦 Фонарик"}
        </button>
      )}
    </div>
  );
}
