import Link from "next/link";

export default function GafferDashboardPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <div className="text-5xl mb-4">📊</div>
      <h2 className="text-[18px] font-semibold text-ink mb-2">Дашборд</h2>
      <p className="text-[13px] text-ink-2 mb-5 leading-relaxed max-w-xs">
        Скоро — будет доступно после запуска модуля проектов. Здесь появятся долги заказчиков и команды.
      </p>
      <Link
        href="/gaffer/contacts"
        className="text-accent-bright hover:text-accent transition-colors text-[13px] font-medium"
      >
        → Контакты
      </Link>
    </div>
  );
}
