"use client";

export function HowItWorks() {
  const steps = [
    { icon: "📝", num: "01", title: "Гаффер пишет список", desc: "произвольный текст в бронировании" },
    { icon: "🤖", num: "02", title: "AI распознаёт", desc: "ищет в словаре + каталоге" },
    { icon: "👤", num: "03", title: "Кладовщик проверяет", desc: "подтверждает или исправляет" },
    { icon: "💾", num: "04", title: "Словарь учится", desc: "новая связь сохраняется навсегда" },
  ];

  return (
    <details className="bg-surface border border-border rounded-lg px-5 py-4 mt-6">
      <summary className="text-sm font-medium text-ink-2 cursor-pointer list-none flex items-center gap-2 [&::marker]:hidden">
        <span className="text-[11px] transition-transform group-open:rotate-90">▸</span>
        Как работает авто-обучение
      </summary>
      <div className="grid grid-cols-4 gap-4 mt-4 pt-4 border-t border-border">
        {steps.map((s) => (
          <div key={s.num} className="text-center text-xs text-ink-2">
            <div className="text-2xl mb-2">{s.icon}</div>
            <div className="mono-num text-[10px] text-ink-3 mb-1">{s.num}</div>
            <p><strong className="text-ink font-medium">{s.title}</strong><br />{s.desc}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
