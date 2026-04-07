"use client";

import { useRouter } from "next/navigation";

export default function WarehouseLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  function handleLogout() {
    sessionStorage.removeItem("warehouse_token");
    router.push("/warehouse/scan");
  }

  return (
    <div className="min-h-screen bg-white flex flex-col w-full">
      {/* Header */}
      <header className="bg-slate-800 text-white flex items-center justify-between px-4 py-3 sticky top-0 z-10">
        <h1 className="text-lg font-semibold">Склад</h1>
        <button
          onClick={handleLogout}
          className="text-slate-300 hover:text-white text-sm px-3 py-1.5 rounded-md border border-slate-600 hover:border-slate-400 transition-colors"
        >
          Выйти
        </button>
      </header>

      {/* Main content */}
      <main className="flex-1 w-full">
        {children}
      </main>
    </div>
  );
}
