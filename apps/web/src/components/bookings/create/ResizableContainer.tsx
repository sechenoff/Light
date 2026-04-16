"use client";

import { useCallback, useRef, useState, type ReactNode } from "react";

type ResizableContainerProps = {
  children: ReactNode;
  defaultHeight?: number;
  minHeight?: number;
};

export function ResizableContainer({
  children,
  defaultHeight = 280,
  minHeight = 180,
}: ResizableContainerProps) {
  const [maxH, setMaxH] = useState(defaultHeight);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      dragging.current = true;
      startY.current = e.clientY;
      startH.current = maxH;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [maxH],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging.current) return;
      const delta = e.clientY - startY.current;
      setMaxH(Math.max(minHeight, startH.current + delta));
    },
    [minHeight],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  const isClipped =
    containerRef.current
      ? containerRef.current.scrollHeight > maxH
      : false;

  return (
    <div className="mx-5">
      <div
        ref={containerRef}
        className="overflow-hidden transition-[max-height] duration-100"
        style={{ maxHeight: `${maxH}px` }}
      >
        {children}
      </div>

      {/* Clip hint */}
      {isClipped && (
        <div className="pointer-events-none -mt-6 h-6 bg-gradient-to-t from-surface to-transparent" />
      )}

      {/* Resize handle */}
      <div
        className="flex cursor-ns-resize justify-center py-1.5 select-none touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        role="separator"
        aria-label="Изменить высоту области"
      >
        <div className="h-[5px] w-9 rounded-full bg-border-strong" />
      </div>
    </div>
  );
}
