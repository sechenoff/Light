"use client";

import { useEffect, useRef } from "react";

// Один замок на стек диалогов: закрытие вложенного окна не разблокирует фон.
const dialogs: symbol[] = [];
let restoreBody: (() => void) | undefined;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]';

export function useDialog<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose?: () => void) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open || !ref.current) return;
    const dialog = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const id = Symbol("dialog");
    if (!dialogs.length) {
      const body = document.body;
      const y = window.scrollY;
      const previous = { position: body.style.position, top: body.style.top, width: body.style.width, overflow: body.style.overflow };
      // position:fixed сохраняет блокировку и в мобильном Safari.
      Object.assign(body.style, { position: "fixed", top: `-${y}px`, width: "100%", overflow: "hidden" });
      restoreBody = () => { Object.assign(body.style, previous); if (window.scrollY !== y) window.scrollTo(0, y); };
    }
    dialogs.push(id);
    const controls = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => {
        for (let node: HTMLElement | null = el; node && node !== dialog; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || style.display === "none" || style.visibility === "hidden") return false;
        }
        return true;
      });
    const frame = requestAnimationFrame(() => {
      if (!dialog.contains(document.activeElement)) (controls()[0] ?? dialog).focus({ preventScroll: true });
    });
    const onKey = (event: KeyboardEvent) => {
      if (dialogs.at(-1) !== id || event.defaultPrevented) return;
      if (event.key === "Escape" && closeRef.current) {
        event.preventDefault();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const items = controls();
      const first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); dialog.focus(); return; }
      if (!dialog.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      dialogs.splice(dialogs.indexOf(id), 1);
      if (!dialogs.length) { restoreBody?.(); restoreBody = undefined; }
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [open]);
  return ref;
}
