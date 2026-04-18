import Link from "next/link";

export default function GafferProjectsPage() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] px-6 text-center">
      <div className="text-5xl mb-4">▤</div>
      <h2 className="text-[18px] font-semibold text-ink mb-2">Проекты</h2>
      <p className="text-[13px] text-ink-2 mb-5 leading-relaxed max-w-xs">
        Проекты — в разработке. Появятся в следующем спринте.
      </p>
      <Link
        href="/gaffer/contacts"
        className="text-accent-bright hover:text-accent transition-colors text-[13px] font-medium"
      >
        → Перейти к контактам
      </Link>
    </div>
  );
}
