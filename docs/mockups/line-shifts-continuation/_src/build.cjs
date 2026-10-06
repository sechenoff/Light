// Сборка мокапов: Tailwind по классам всех _src/*.html → стили встраиваются в каждый файл.
//   node _src/build.cjs <worktree с node_modules> <источник.html> <итог.html> [<источник> <итог> …]
// В источнике: /*__TAILWIND__*/ — место для CSS, <!--@include имя--> — вставка _src/_part-имя.html.
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const S = __dirname;
const [W, ...pairs] = process.argv.slice(2);
if (!W || pairs.length < 2 || pairs.length % 2) {
  console.error("usage: node build.cjs <W> <src.html> <out.html> [<src> <out> …]");
  process.exit(1);
}

execFileSync(
  process.execPath,
  [W + "/node_modules/tailwindcss/lib/cli.js", "-c", S + "/tw.config.js", "-i", S + "/in.css", "-o", S + "/out.css", "--minify"],
  { stdio: "inherit", cwd: S },
);
const css = fs.readFileSync(S + "/out.css", "utf8");

const include = (html) =>
  html.replace(/<!--@include ([\w-]+)-->/g, (_, name) => fs.readFileSync(path.join(S, `_part-${name}.html`), "utf8"));

for (let i = 0; i < pairs.length; i += 2) {
  const src = path.resolve(pairs[i]);
  const out = path.resolve(pairs[i + 1]);
  const html = include(fs.readFileSync(src, "utf8"));
  if (!html.includes("/*__TAILWIND__*/")) throw new Error(`${src}: нет /*__TAILWIND__*/`);
  fs.writeFileSync(out, html.replace("/*__TAILWIND__*/", () => css));
  console.log(path.basename(src), "→", path.basename(out), `(${Math.round(fs.statSync(out).size / 1024)} КБ)`);
}
