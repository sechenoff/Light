import Link from "next/link";

export const metadata = {
  title: "Svetobaza Rental",
};

export default function LandingPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl">
        {/* Header */}
        <div className="text-center mb-10 lg:mb-14">
          <h1 className="text-3xl lg:text-5xl font-bold text-white mb-3 tracking-tight">
            Svetobaza Rental
          </h1>
          <p className="text-slate-400 text-sm lg:text-base">
            Аренда кинооборудования — сервис для осветителей и администрации
          </p>
        </div>

        {/* Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 lg:gap-6">
          {/* Калькулятор осветителей */}
          <Link
            href="/crew-calculator"
            className="group relative bg-white rounded-2xl p-8 lg:p-10 shadow-lg hover:shadow-2xl transition-all hover:-translate-y-1"
          >
            <div className="flex flex-col h-full">
              <div className="mb-5 inline-flex items-center justify-center w-14 h-14 rounded-xl bg-amber-100 text-amber-600 group-hover:bg-amber-500 group-hover:text-white transition-colors">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="w-7 h-7"
                >
                  <path d="M12 2a1 1 0 0 1 1 1v1.06a8.001 8.001 0 0 1 6.94 6.94H21a1 1 0 1 1 0 2h-1.06a8.001 8.001 0 0 1-6.94 6.94V21a1 1 0 1 1-2 0v-1.06a8.001 8.001 0 0 1-6.94-6.94H3a1 1 0 1 1 0-2h1.06A8.001 8.001 0 0 1 11 4.06V3a1 1 0 0 1 1-1Zm0 4a6 6 0 1 0 0 12 6 6 0 0 0 0-12Zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
                </svg>
              </div>
              <h2 className="text-xl lg:text-2xl font-semibold text-slate-900 mb-2">
                Калькулятор осветителей
              </h2>
              <p className="text-slate-600 text-sm lg:text-base flex-1">
                Рассчитать состав бригады и стоимость работ для вашей смены
              </p>
              <div className="mt-5 inline-flex items-center text-amber-600 font-medium text-sm group-hover:text-amber-700">
                Открыть калькулятор
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform"
                >
                  <path
                    fillRule="evenodd"
                    d="M12.97 3.97a.75.75 0 0 1 1.06 0l7.5 7.5a.75.75 0 0 1 0 1.06l-7.5 7.5a.75.75 0 1 1-1.06-1.06l6.22-6.22H3a.75.75 0 0 1 0-1.5h16.19l-6.22-6.22a.75.75 0 0 1 0-1.06Z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            </div>
          </Link>

          {/* Вход в CRM */}
          <Link
            href="/dashboard"
            className="group relative bg-white rounded-2xl p-8 lg:p-10 shadow-lg hover:shadow-2xl transition-all hover:-translate-y-1"
          >
            <div className="flex flex-col h-full">
              <div className="mb-5 inline-flex items-center justify-center w-14 h-14 rounded-xl bg-sky-100 text-sky-600 group-hover:bg-sky-500 group-hover:text-white transition-colors">
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="w-7 h-7"
                >
                  <path d="M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3H3V5Zm0 5h18v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9Zm4 3a1 1 0 1 0 0 2h4a1 1 0 1 0 0-2H7Z" />
                </svg>
              </div>
              <h2 className="text-xl lg:text-2xl font-semibold text-slate-900 mb-2">
                Вход в CRM Svetobaza Rental
              </h2>
              <p className="text-slate-600 text-sm lg:text-base flex-1">
                Бронирования, оборудование, склад, календарь и аналитика
              </p>
              <div className="mt-5 inline-flex items-center text-sky-600 font-medium text-sm group-hover:text-sky-700">
                Войти в систему
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  className="w-4 h-4 ml-1 group-hover:translate-x-1 transition-transform"
                >
                  <path
                    fillRule="evenodd"
                    d="M12.97 3.97a.75.75 0 0 1 1.06 0l7.5 7.5a.75.75 0 0 1 0 1.06l-7.5 7.5a.75.75 0 1 1-1.06-1.06l6.22-6.22H3a.75.75 0 0 1 0-1.5h16.19l-6.22-6.22a.75.75 0 0 1 0-1.06Z"
                    clipRule="evenodd"
                  />
                </svg>
              </div>
            </div>
          </Link>
        </div>

        {/* Footer */}
        <div className="text-center mt-10 text-slate-500 text-xs">
          © {new Date().getFullYear()} Svetobaza Rental
        </div>
      </div>
    </main>
  );
}
