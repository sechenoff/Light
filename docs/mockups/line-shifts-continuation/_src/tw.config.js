// Tailwind проекта: те же токены и темы, что в apps/web. Контент — только мокапы.
const path = require("path");
const base = require(path.resolve(__dirname, "../../../../apps/web/tailwind.config.js"));
module.exports = { ...base, content: [path.join(__dirname, "*.html")] };
