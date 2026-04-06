"use client";

import { useState, useCallback } from "react";

type GameState = "start" | "show" | "hidden" | "result";

export default function ShellGamePage() {
  const [state, setState] = useState<GameState>("start");
  const [ballIndex, setBallIndex] = useState(0);
  const [guess, setGuess] = useState<number | null>(null);
  const [wins, setWins] = useState(0);
  const [total, setTotal] = useState(0);
  const [shuffling, setShuffling] = useState(false);

  const startRound = useCallback(() => {
    const idx = Math.floor(Math.random() * 3);
    setBallIndex(idx);
    setGuess(null);
    setState("show");

    // Показываем мяч 1.5 сек, потом перемешиваем
    setTimeout(() => {
      setShuffling(true);
      // Новая позиция после перемешивания
      setTimeout(() => {
        const newIdx = Math.floor(Math.random() * 3);
        setBallIndex(newIdx);
        setShuffling(false);
        setState("hidden");
      }, 1200);
    }, 1500);
  }, []);

  const makeGuess = (idx: number) => {
    if (state !== "hidden") return;
    setGuess(idx);
    setTotal((t) => t + 1);
    if (idx === ballIndex) setWins((w) => w + 1);
    setState("result");
  };

  const won = guess === ballIndex;
  const pct = total > 0 ? Math.round((wins / total) * 100) : 0;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 select-none">
      <h1 className="text-3xl font-bold mb-2">🎩 Наперстки</h1>

      {total > 0 && (
        <p className="text-lg text-slate-600 mb-4">
          Счёт: {wins}/{total} ({pct}%)
        </p>
      )}

      {state === "start" && (
        <div className="text-center">
          <p className="text-lg mb-6 text-slate-600">
            Угадай, под каким стаканом спрятан мяч!
          </p>
          <button
            onClick={startRound}
            className="px-8 py-4 bg-indigo-600 text-white text-xl rounded-2xl shadow-lg active:scale-95 transition-transform"
          >
            Играть
          </button>
        </div>
      )}

      {(state === "show" || state === "hidden" || state === "result") && (
        <>
          {state === "show" && !shuffling && (
            <p className="text-lg mb-4 text-amber-600 animate-pulse">
              🔎 Запомни, где мяч!
            </p>
          )}
          {shuffling && (
            <p className="text-lg mb-4 text-indigo-600 animate-bounce">
              🔀 Перемешиваем...
            </p>
          )}
          {state === "hidden" && (
            <p className="text-lg mb-4 text-slate-600">
              👉 Выбери стакан!
            </p>
          )}
          {state === "result" && (
            <p className={`text-xl mb-4 font-bold ${won ? "text-green-600" : "text-red-500"}`}>
              {won ? "🎉 Угадал!" : `😔 Мимо! Мяч был под стаканом ${ballIndex + 1}`}
            </p>
          )}

          <div className="flex gap-4 sm:gap-8 mb-8">
            {[0, 1, 2].map((i) => {
              const showBall =
                (state === "show" && !shuffling && i === ballIndex) ||
                (state === "result" && i === ballIndex);
              const isGuess = state === "result" && i === guess && !won;
              const isCorrectGuess = state === "result" && i === guess && won;

              return (
                <button
                  key={i}
                  onClick={() => makeGuess(i)}
                  disabled={state !== "hidden"}
                  className={`
                    flex flex-col items-center justify-end
                    w-24 h-32 sm:w-28 sm:h-36
                    rounded-2xl border-2 transition-all duration-300
                    ${state === "hidden" ? "cursor-pointer active:scale-95 hover:border-indigo-400 border-slate-300 bg-white shadow-md" : "cursor-default border-slate-200 bg-slate-50"}
                    ${isCorrectGuess ? "border-green-500 bg-green-50 ring-4 ring-green-200" : ""}
                    ${isGuess ? "border-red-400 bg-red-50 ring-4 ring-red-200" : ""}
                    ${shuffling ? "animate-pulse" : ""}
                  `}
                >
                  <span className="text-4xl sm:text-5xl mb-1">
                    {showBall ? "⚽" : ""}
                  </span>
                  <span className="text-5xl sm:text-6xl">🥤</span>
                  <span className="text-sm text-slate-500 mt-1">{i + 1}</span>
                </button>
              );
            })}
          </div>

          {state === "result" && (
            <button
              onClick={startRound}
              className="px-8 py-4 bg-indigo-600 text-white text-xl rounded-2xl shadow-lg active:scale-95 transition-transform"
            >
              🔄 Ещё раз
            </button>
          )}
        </>
      )}
    </div>
  );
}
