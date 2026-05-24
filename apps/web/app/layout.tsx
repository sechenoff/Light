import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "../src/components/AppShell";
import { ToastProvider } from "../src/components/ToastProvider";
import { FeedbackWidget } from "../src/components/feedback/FeedbackWidget";

export const metadata: Metadata = {
  title: "Light Rental System",
  description: "Бронирования и сметы киносвета",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="bg-slate-50 text-slate-900">
        <AppShell>{children}</AppShell>
        <ToastProvider />
        <FeedbackWidget />
      </body>
    </html>
  );
}
