"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { completeOnboarding } from "../../../src/lib/gafferApi";
import { useGafferUser } from "../../../src/components/gaffer/GafferUserContext";

export default function GafferWelcomePage() {
  const { user, loading, refresh } = useGafferUser();
  const router = useRouter();

  // If already onboarded — skip to dashboard
  useEffect(() => {
    if (!loading && user?.onboardingCompletedAt) {
      router.replace("/gaffer");
    }
  }, [loading, user, router]);

  async function handleStart() {
    await completeOnboarding();
    await refresh();
    router.push("/gaffer/projects");
  }

  async function handleSkip() {
    await completeOnboarding();
    await refresh();
    router.push("/gaffer");
  }

  return (
    <div className="min-h-screen bg-surface">
      {/* Hero */}
      <div
        className="bg-accent text-white text-center px-6 pt-11 pb-8"
      >
        <div className="text-[40px] leading-none mb-[14px]">👋</div>
        <h2
          className="text-[22px] font-semibold text-white tracking-tight mb-1.5"
          style={{ fontFamily: "'IBM Plex Sans', sans-serif" }}
        >
          Привет, {user?.name || user?.email?.split("@")[0] || "Гаффер"}!
        </h2>
        <p className="text-accent-border text-[13px] leading-relaxed m-0">
          Это простой учёт съёмок, долгов и выплат.<br />
          Разберёмся за минуту — три шага ниже.
        </p>
      </div>

      {/* Steps */}
      <div className="px-5 pt-[22px] pb-4 grid gap-[14px]">
        {[
          {
            n: "1",
            title: "Заведите первый проект",
            desc: "Название, заказчик, дата, сумма от клиента. Добавьте участников команды — вся съёмка на одной карточке.",
          },
          {
            n: "2",
            title: "Записывайте поступления и выплаты",
            desc: "Пришёл перевод от заказчика — нажали «+ поступление». Выплатили команде — отметили «+ выплата».",
          },
          {
            n: "3",
            title: "Смотрите долги на дашборде",
            desc: "Два больших числа: сколько вам должны и сколько должны вы. Кликаете — видите список проектов и людей.",
          },
        ].map((step) => (
          <div key={step.n} className="grid gap-3" style={{ gridTemplateColumns: "36px 1fr" }}>
            <div
              className="w-8 h-8 rounded-full bg-accent-soft border border-accent-border text-accent flex items-center justify-center font-mono font-semibold text-[13px] shrink-0"
            >
              {step.n}
            </div>
            <div>
              <h4 className="text-[14px] font-semibold text-ink mt-1 mb-0.5">{step.title}</h4>
              <p className="text-[12.5px] text-ink-2 m-0 leading-relaxed">{step.desc}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Tip */}
      <div className="mx-5 mb-[18px] px-[14px] py-3 bg-emerald-soft border border-emerald-border rounded-lg text-[12px] text-emerald leading-relaxed">
        <b className="font-semibold">Совет:</b> начни с заказчика в Контактах — потом прикрепишь его к проекту одним кликом.
      </div>

      {/* CTA */}
      <div className="px-5 pb-[22px] grid gap-2">
        <button
          onClick={handleStart}
          className="w-full bg-accent-bright hover:bg-accent text-white font-medium rounded px-4 py-[12px] text-[14px] transition-colors flex items-center justify-center"
        >
          Создать первый проект
        </button>
      </div>

      {/* Skip */}
      <div className="text-center pb-[22px] text-[12px] text-ink-3">
        <button
          onClick={handleSkip}
          className="text-accent-bright hover:text-accent transition-colors"
        >
          Пропустить и открыть дашборд
        </button>
      </div>
    </div>
  );
}
