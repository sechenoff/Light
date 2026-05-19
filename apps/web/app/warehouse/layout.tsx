/**
 * Warehouse route group is a standalone kiosk surface — NO chrome here.
 *
 * The frame (dark canon header, worker name, logout) lives in
 * `src/components/warehouse/ScanShell.tsx`, which every warehouse screen
 * renders. A wrapper header at this layer produced a non-canon double
 * header over the redesigned kiosk page, so this layout is intentionally
 * a transparent passthrough. Keep it minimal — do not reintroduce chrome.
 */

export default function WarehouseLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
