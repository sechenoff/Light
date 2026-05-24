export default function LkToolsPage() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-medium">Инструменты</h1>

      <section className="bg-surface-2 border border-border rounded-lg p-4 max-w-xl">
        <p className="eyebrow">Калькулятор электрической нагрузки</p>
        <p className="text-ink-2 mt-1 mb-3 text-sm">
          Внешний инструмент Светобазы: расчёт потребления (W) и тока (A), режимы 1 фаза / 3 фазы.
        </p>
        <a
          href="https://calc.svetobazarent.ru/"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block px-4 py-2 bg-accent-bright text-surface rounded-md"
        >
          Открыть калькулятор ↗
        </a>
      </section>
    </div>
  );
}
