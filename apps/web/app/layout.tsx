import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Light Rental System",
  description: "Бронирование и сметы киносвета",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body className="bg-slate-50 text-slate-900">
        <div className="min-h-screen">{children}</div>
      </body>
    </html>
  );
}

