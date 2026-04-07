"use client";

import { useEffect, useRef } from "react";
import { Html5Qrcode } from "html5-qrcode";

export default function Html5QrcodePlugin({ onScan }: { onScan: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) return;
    const scanner = new Html5Qrcode(ref.current.id);
    scanner
      .start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        (decodedText) => onScan(decodedText),
        () => {},
      )
      .catch(console.error);
    return () => {
      scanner.stop().catch(() => {});
    };
  }, [onScan]);

  return <div id="qr-reader" ref={ref} />;
}
