import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "../src/components/AppShell";
import { ToastProvider } from "../src/components/ToastProvider";
import { FeedbackWidget } from "../src/components/feedback/FeedbackWidget";

export const metadata: Metadata = {
  title: "Light Rental System",
  description: "Бронирования и сметы киносвета",
};

// Анти-FOUC: выставляем data-theme на <html> ДО первого кадра, читая тот же
// ключ localStorage, что и src/lib/theme.ts. Дефолт — светлая тема. Без этого
// при выбранной ночной теме страница мигнула бы белым до гидратации React.
const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem("lr:theme");var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme:dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light");}catch(e){document.documentElement.setAttribute("data-theme","light");}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="bg-surface-muted text-ink">
        <AppShell>{children}</AppShell>
        <ToastProvider />
        <FeedbackWidget />
      </body>
    </html>
  );
}
