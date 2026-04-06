#!/usr/bin/env npx tsx

import * as readline from "readline";

const CUPS = ["🥤", "🥤", "🥤"];
const BALL = "⚽";
const EMPTY = "  ";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function shuffle(): number {
  return Math.floor(Math.random() * 3);
}

function renderCups(revealed: boolean, ballIndex: number, guess?: number): string {
  const lines: string[] = [];

  // Top row: cup numbers
  lines.push("   1️⃣      2️⃣      3️⃣  ");

  if (!revealed) {
    // Cups closed
    lines.push("  🥤     🥤     🥤  ");
    lines.push("  ━━     ━━     ━━  ");
  } else {
    // Cups revealed
    const contents = [EMPTY, EMPTY, EMPTY];
    contents[ballIndex] = BALL;

    const markers = ["  ", "  ", "  "];
    if (guess !== undefined) {
      markers[guess] = "👆";
    }

    lines.push(`  ${contents[0]}     ${contents[1]}     ${contents[2]}  `);
    lines.push(`  ${markers[0]}     ${markers[1]}     ${markers[2]}  `);
  }

  return lines.join("\n");
}

function showMixAnimation(): string {
  const frames = ["🔀 Перемешиваем...", "🔀 Перемешиваем... 🥤↔🥤", "🔀 Перемешиваем... 🥤↔🥤↔🥤"];
  return frames[Math.floor(Math.random() * frames.length)];
}

async function playRound(roundNum: number, score: { wins: number; total: number }): Promise<boolean> {
  console.clear();
  console.log("╔══════════════════════════════╗");
  console.log("║     🎩 НАПЕРСТКИ 🎩         ║");
  console.log("╚══════════════════════════════╝");
  console.log(`\n📊 Счёт: ${score.wins}/${score.total} | Раунд ${roundNum}\n`);

  const ballIndex = shuffle();

  // Show ball placement
  console.log("🔎 Смотри внимательно, где мяч!\n");
  console.log(renderCups(true, ballIndex));
  await ask("\n[Нажми Enter, чтобы перемешать]");

  // Shuffle
  console.clear();
  console.log("╔══════════════════════════════╗");
  console.log("║     🎩 НАПЕРСТКИ 🎩         ║");
  console.log("╚══════════════════════════════╝");
  console.log(`\n📊 Счёт: ${score.wins}/${score.total} | Раунд ${roundNum}\n`);

  const newBallIndex = shuffle();
  console.log(showMixAnimation());
  console.log("\n" + renderCups(false, newBallIndex));

  // Player's guess
  let guess = -1;
  while (guess < 0 || guess > 2) {
    const input = await ask("\n👉 Под каким стаканом мяч? (1, 2 или 3): ");
    const num = parseInt(input.trim(), 10);
    if (num >= 1 && num <= 3) {
      guess = num - 1;
    } else {
      console.log("❌ Введи число от 1 до 3!");
    }
  }

  // Reveal
  const won = guess === newBallIndex;

  console.log("\n" + renderCups(true, newBallIndex, guess));

  if (won) {
    console.log("\n🎉 УГАДАЛ! Молодец! 🏆");
  } else {
    console.log(`\n😔 Мимо! Мяч был под стаканом ${newBallIndex + 1}`);
  }

  return won;
}

async function main() {
  const score = { wins: 0, total: 0 };

  console.clear();
  console.log("╔══════════════════════════════╗");
  console.log("║     🎩 НАПЕРСТКИ 🎩         ║");
  console.log("║                              ║");
  console.log("║  Угадай, под каким стаканом   ║");
  console.log("║  спрятан мяч!                ║");
  console.log("╚══════════════════════════════╝");
  await ask("\n[Нажми Enter, чтобы начать]");

  let playing = true;
  let round = 1;

  while (playing) {
    const won = await playRound(round, score);
    score.total++;
    if (won) score.wins++;
    round++;

    const answer = await ask("\n🔄 Ещё раунд? (д/н): ");
    playing = answer.trim().toLowerCase() !== "н";
  }

  console.log("\n╔══════════════════════════════╗");
  console.log("║        ИТОГИ ИГРЫ            ║");
  console.log("╚══════════════════════════════╝");
  console.log(`\n🏆 Угадал: ${score.wins} из ${score.total}`);
  const pct = score.total > 0 ? Math.round((score.wins / score.total) * 100) : 0;
  console.log(`📊 Точность: ${pct}%`);

  if (pct >= 50) {
    console.log("🎉 Неплохо! У тебя глаз-алмаз!");
  } else if (pct > 0) {
    console.log("😅 Бывает! Попробуй ещё разок!");
  } else {
    console.log("🤔 Не расстраивайся, удача — дело случая!");
  }

  console.log("\nСпасибо за игру! 👋\n");
  rl.close();
}

main().catch((err) => {
  console.error(err);
  rl.close();
  process.exit(1);
});
