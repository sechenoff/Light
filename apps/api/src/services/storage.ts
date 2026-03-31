import fs from "fs/promises";
import path from "path";

// ── Интерфейс ─────────────────────────────────────────────────────────────────

export interface StorageService {
  /**
   * Сохраняет файл и возвращает storagePath — стабильный путь для последующего чтения.
   * @param filename — желаемое имя файла (без директории)
   * @param data     — бинарные данные
   */
  save(filename: string, data: Buffer): Promise<string>;

  /**
   * Читает ранее сохранённый файл по storagePath.
   */
  read(storagePath: string): Promise<Buffer>;
}

// ── Валидация изображений (по магическим байтам) ──────────────────────────────

/** Разрешённые MIME-типы для загрузки изображений */
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

/** Максимальный размер загружаемого файла: 20 МБ */
const MAX_FILE_SIZE = 20 * 1024 * 1024;

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageValidationError";
  }
}

/**
 * Проверяет буфер по магическим байтам и размеру.
 * Бросает ImageValidationError при невалидном файле.
 */
export function validateImageBuffer(buffer: Buffer, declaredMimeType?: string): void {
  if (buffer.length === 0) {
    throw new ImageValidationError("Файл пустой");
  }

  if (buffer.length > MAX_FILE_SIZE) {
    const mb = (buffer.length / 1024 / 1024).toFixed(1);
    throw new ImageValidationError(`Файл слишком большой: ${mb} МБ (максимум 20 МБ)`);
  }

  const detected = detectMimeByMagicBytes(buffer);
  if (!detected) {
    throw new ImageValidationError("Не удалось определить формат изображения");
  }

  if (!ALLOWED_MIME_TYPES.has(detected)) {
    throw new ImageValidationError(
      `Неподдерживаемый формат: ${detected}. Разрешены: JPEG, PNG, WEBP, GIF`,
    );
  }

  // Если клиент заявил MIME-тип — он должен совпадать с реальным
  if (declaredMimeType && declaredMimeType !== detected) {
    throw new ImageValidationError(
      `MIME-тип не совпадает: заявлен ${declaredMimeType}, реальный ${detected}`,
    );
  }
}

/** Определяет MIME-тип по первым байтам файла */
function detectMimeByMagicBytes(buf: Buffer): string | null {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "image/png";
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return "image/webp";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return "image/gif";
  }
  return null;
}

// ── Local Storage ─────────────────────────────────────────────────────────────

/**
 * Сохраняет файлы в директорию на диске.
 * По умолчанию: ./storage/analyses/<YYYY-MM>/<filename>
 */
export class LocalStorageService implements StorageService {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? path.resolve(process.cwd(), "storage", "analyses");
  }

  async save(filename: string, data: Buffer): Promise<string> {
    const monthDir = currentMonthDir();
    const dir = path.join(this.baseDir, monthDir);
    await fs.mkdir(dir, { recursive: true });

    const fullPath = path.join(dir, filename);
    await fs.writeFile(fullPath, data);

    // storagePath — относительный путь (начинается с YYYY-MM/) для переносимости
    return path.join(monthDir, filename);
  }

  async read(storagePath: string): Promise<Buffer> {
    return fs.readFile(this.fullPath(storagePath));
  }

  fullPath(storagePath: string): string {
    return path.join(this.baseDir, storagePath);
  }
}

/** Возвращает строку вида "2026-03" для организации файлов по месяцам */
function currentMonthDir(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/**
 * Активный экземпляр storage service.
 * Для смены провайдера (S3, GCS и т.д.) — заменить реализацию здесь.
 */
export const storageService: StorageService = new LocalStorageService(
  process.env.STORAGE_DIR
    ? path.resolve(process.env.STORAGE_DIR)
    : undefined,
);
