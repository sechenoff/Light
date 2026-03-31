import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";

const PRICELIST_DIR = path.resolve(process.env.PRICELIST_DIR ?? "./data/pricelist");
const META_FILE = path.join(PRICELIST_DIR, "meta.json");

type PricelistMeta = {
  filename: string;
  size: number;
  uploadedAt: string;
  filepath: string;
};

function getMeta(): PricelistMeta | null {
  try {
    if (!fs.existsSync(META_FILE)) return null;
    return JSON.parse(fs.readFileSync(META_FILE, "utf-8")) as PricelistMeta;
  } catch {
    return null;
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const router = express.Router();

/** GET /api/pricelist — метаданные текущего прайслиста */
router.get("/", (_req, res) => {
  const meta = getMeta();
  if (!meta || !fs.existsSync(meta.filepath)) {
    return res.json({ exists: false });
  }
  return res.json({
    exists: true,
    filename: meta.filename,
    size: meta.size,
    uploadedAt: meta.uploadedAt,
  });
});

/** POST /api/pricelist — загрузить новый прайслист */
router.post("/", upload.single("file"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ message: "Файл не передан" });

  fs.mkdirSync(PRICELIST_DIR, { recursive: true });

  // Удаляем старый файл
  const oldMeta = getMeta();
  if (oldMeta && fs.existsSync(oldMeta.filepath)) {
    try { fs.unlinkSync(oldMeta.filepath); } catch { /* ignore */ }
  }

  // Multer получает originalname в Latin-1, но браузеры кодируют UTF-8 байты в Latin-1.
  // Перекодируем обратно в UTF-8.
  const rawName = file.originalname;
  const filename = (() => {
    try {
      const decoded = Buffer.from(rawName, "latin1").toString("utf8");
      // Проверяем: если после декодирования строка стала валидной UTF-8 без мусора
      return /[\u0080-\u009F]/.test(decoded) ? rawName : decoded;
    } catch {
      return rawName;
    }
  })();

  const ext = path.extname(filename) || "";
  const filepath = path.join(PRICELIST_DIR, `pricelist${ext}`);
  fs.writeFileSync(filepath, file.buffer);

  const meta: PricelistMeta = {
    filename,
    size: file.size,
    uploadedAt: new Date().toISOString(),
    filepath,
  };
  fs.writeFileSync(META_FILE, JSON.stringify(meta, null, 2));

  res.json({ ok: true, filename: meta.filename, size: meta.size, uploadedAt: meta.uploadedAt });
});

/** GET /api/pricelist/file — скачать файл */
router.get("/file", (_req, res) => {
  const meta = getMeta();
  if (!meta || !fs.existsSync(meta.filepath)) {
    return res.status(404).json({ message: "Прайслист не найден" });
  }
  const encoded = encodeURIComponent(meta.filename);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encoded}`);
  res.setHeader("Content-Length", String(fs.statSync(meta.filepath).size));
  res.sendFile(path.resolve(meta.filepath));
});

/** DELETE /api/pricelist — удалить прайслист */
router.delete("/", (_req, res) => {
  const meta = getMeta();
  if (!meta) return res.status(404).json({ message: "Прайслист не найден" });
  if (fs.existsSync(meta.filepath)) {
    try { fs.unlinkSync(meta.filepath); } catch { /* ignore */ }
  }
  if (fs.existsSync(META_FILE)) {
    try { fs.unlinkSync(META_FILE); } catch { /* ignore */ }
  }
  res.json({ ok: true });
});

export { router as pricelistRouter };
