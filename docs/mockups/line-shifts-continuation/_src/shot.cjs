// Снимки мокапов во всю страницу + проверка горизонтального переполнения.
//   node _src/shot.cjs <worktree с node_modules> <папка снимков> <a.html> [<b.html> …]
// Ширины 375 / 768 / 1024 / 1440 в светлой теме и 1440 в ночной.
// TILES=<папка> — дополнительно режет каждый снимок на куски по 1400 px для осмотра.
const fs = require("fs");
const path = require("path");
const [W, OUT, ...files] = process.argv.slice(2);
const { chromium } = require(W + "/node_modules/playwright");
const TILES = process.env.TILES || "";
const WIDTHS = [
  [375, "light"],
  [768, "light"],
  [1024, "light"],
  [1440, "light"],
  [1440, "dark"],
];
const TILE_H = 1400;

// Элементы, вылезающие за правый край, — кроме тех, что живут внутри явного скроллера.
function auditOverflow() {
  const vw = document.documentElement.clientWidth;
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll" || ox === "hidden" || ox === "clip") return true;
    }
    return false;
  };
  const bad = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 && !inScroller(el)) {
      bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)} → ${Math.round(r.right)}`);
    }
  }
  return { page: document.documentElement.scrollWidth, vw, bad: bad.slice(0, 8), total: bad.length };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  if (TILES) fs.mkdirSync(TILES, { recursive: true });
  const browser = await chromium.launch();
  for (const file of files) {
    const base = path.basename(file, ".html");
    for (const [width, theme] of WIDTHS) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
      await page.goto("file://" + path.resolve(file));
      await page.evaluate((t) => {
        document.documentElement.dataset.theme = t;
      }, theme);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);
      const a = await page.evaluate(auditOverflow);
      const flag = a.page > a.vw || a.total ? "  ПЕРЕПОЛНЕНИЕ" : "";
      console.log(`${base} ${width} ${theme}: ширина ${a.page}/${a.vw}${flag}`);
      a.bad.forEach((b) => console.log("   ", b));
      const shot = path.join(OUT, `${base}-${width}-${theme}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      if (TILES) {
        const h = await page.evaluate(() => document.documentElement.scrollHeight);
        for (let y = 0, k = 1; y < h; y += TILE_H, k++) {
          await page.screenshot({
            path: path.join(TILES, `${base}-${width}-${theme}-${k}.png`),
            fullPage: true,
            clip: { x: 0, y, width, height: Math.min(TILE_H, h - y) },
          });
        }
      }
      await page.close();
    }
  }
  await browser.close();
})();
