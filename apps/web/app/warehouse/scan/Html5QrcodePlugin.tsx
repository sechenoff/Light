"use client";

import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";

export default function Html5QrcodePlugin({ onScan }: { onScan: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [torchOn, setTorchOn] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    const scanner = new Html5Qrcode(ref.current.id);
    scannerRef.current = scanner;
    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 280, height: 100 } },
        (decodedText) => onScanRef.current(decodedText),
        () => {},
      )
      .catch(console.error);
    return () => {
      scannerRef.current = null;
      scanner.stop().catch(() => {});
    };
  }, []);

  function toggleTorch() {
    const next = !torchOn;
    setTorchOn(next);
    scannerRef.current?.applyVideoConstraints({ advanced: [{ torch: next } as any] }).catch(() => {});
  }

  return (
    <div>
      <div id="qr-reader" ref={ref} />
      <button
        type="button"
        onClick={toggleTorch}
        className="mt-2 w-full py-2 text-sm font-medium rounded-lg border border-slate-300 hover:bg-slate-50 transition-colors"
      >
        {torchOn ? "🔦 Фонарик вкл." : "🔦 Фонарик"}
      </button>
    </div>
  );
}
