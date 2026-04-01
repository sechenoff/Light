import type { Metadata } from "next";
import "./globals.css";
import { AppShell } from "../src/components/AppShell";

export const metadata: Metadata = {
  title: "Light Rental System",
  description: "Бронирование и сметы киносвета",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="bg-slate-50 text-slate-900">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
