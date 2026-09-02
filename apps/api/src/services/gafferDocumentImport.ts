import { prisma } from "../prisma";
import { HttpError } from "../utils/errors";
import {
  getLlmProvider,
  GAFFER_DOCUMENT_MIME_TYPES,
  type GafferDocumentExtraction,
  type GafferDocumentMeta,
  type GafferDocumentMimeType,
} from "./llm";

/**
 * Импорт заявки-документа: гаффер присылает PDF (или фото листка) со списком
 * приборов, шапкой проекта и своими контактами. Модель читает документ,
 * а здесь — проверка файла и подбор клиента из базы по контактам.
 */

/** PDF заявки с логотипами и фото бывает больше 5 МБ; лимит модели — 32 МБ, нам хватит 10. */
export const GAFFER_DOCUMENT_MAX_BYTES = 10 * 1024 * 1024;

type Signature = { mime: GafferDocumentMimeType; check: (buf: Buffer) => boolean };

const startsWith = (buf: Buffer, bytes: number[], offset = 0) =>
  bytes.every((b, i) => buf[offset + i] === b);

// Сигнатуры файлов — MIME из заголовка запроса подделать тривиально.
const SIGNATURES: Signature[] = [
  { mime: "application/pdf", check: (b) => startsWith(b, [0x25, 0x50, 0x44, 0x46]) }, // %PDF
  { mime: "image/jpeg", check: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  { mime: "image/png", check: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  // RIFF....WEBP
  { mime: "image/webp", check: (b) => startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8) },
];

export function isGafferDocumentMimeType(mime: string): mime is GafferDocumentMimeType {
  return (GAFFER_DOCUMENT_MIME_TYPES as readonly string[]).includes(mime);
}

/** Содержимое соответствует заявленному типу? */
export function validateGafferDocumentBytes(buffer: Buffer, mime: GafferDocumentMimeType): boolean {
  const sig = SIGNATURES.find((s) => s.mime === mime);
  return Boolean(sig && buffer.length >= 12 && sig.check(buffer));
}

export type MatchedClient = {
  id: string;
  name: string;
  phone: string | null;
  matchedBy: "phone" | "email" | "name";
};

/** Последние 10 цифр: «+7 981 790-34-51», «8 (981) 790 34 51» и «9817903451» — один номер. */
export function phoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return null;
  return digits.slice(-10);
}

/** Слова имени, по которым имеет смысл искать: не короче четырёх букв (отсекаем «и», «оглы»). */
function nameTokens(name: string): string[] {
  return name
    .toLocaleLowerCase("ru-RU")
    .split(/[\s,.;()"'«»-]+/)
    .filter((t) => t.length >= 4);
}

/**
 * Подбор клиента по шапке заявки. Телефон и почта — точное совпадение,
 * это надёжно. Имя — только если совпало ровно с одним клиентом:
 * «Белых Геннадий» в заявке и «Гена Белых» в базе — один человек, а вот
 * два «Иванова» — уже вопрос к менеджеру, и тогда честнее вернуть null.
 */
export async function findClientForGaffer(
  meta: Pick<GafferDocumentMeta, "gafferName" | "phone" | "email">,
): Promise<MatchedClient | null> {
  const wantPhone = phoneKey(meta.phone);
  const wantEmail = meta.email?.trim().toLowerCase() || null;
  const tokens = meta.gafferName ? nameTokens(meta.gafferName) : [];
  if (!wantPhone && !wantEmail && tokens.length === 0) return null;

  // Клиентов сотни, форматы телефонов разные — сравниваем в памяти, не в SQL.
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, phone: true, email: true },
  });

  if (wantPhone) {
    const byPhone = clients.find((c) => phoneKey(c.phone) === wantPhone);
    if (byPhone) return { id: byPhone.id, name: byPhone.name, phone: byPhone.phone, matchedBy: "phone" };
  }
  if (wantEmail) {
    const byEmail = clients.find((c) => c.email?.trim().toLowerCase() === wantEmail);
    if (byEmail) return { id: byEmail.id, name: byEmail.name, phone: byEmail.phone, matchedBy: "email" };
  }
  if (tokens.length > 0) {
    const byName = clients.filter((c) => {
      const own = nameTokens(c.name);
      return own.some((t) => tokens.includes(t));
    });
    if (byName.length === 1) {
      const c = byName[0];
      return { id: c.id, name: c.name, phone: c.phone, matchedBy: "name" };
    }
  }
  return null;
}

export type GafferDocumentImportResult = GafferDocumentExtraction & {
  client: MatchedClient | null;
};

/**
 * Прочитать документ моделью и подобрать клиента. Файл уже проверен
 * (тип/размер/сигнатура) — здесь только чтение и обогащение.
 */
export async function importGafferDocument(input: {
  buffer: Buffer;
  mimeType: GafferDocumentMimeType;
  fileName?: string;
}): Promise<GafferDocumentImportResult> {
  const provider = getLlmProvider();
  if (typeof provider.extractGafferDocument !== "function") {
    throw new HttpError(
      503,
      "Настроенный AI-провайдер не умеет читать документы — нужна нога anthropic или gemini в LLM_FALLBACK_CHAIN",
      "AI_DOCUMENTS_UNSUPPORTED",
    );
  }
  const extraction = await provider.extractGafferDocument({
    data: input.buffer,
    mimeType: input.mimeType,
    fileName: input.fileName,
  });
  const client = await findClientForGaffer(extraction.meta);
  return { ...extraction, client };
}
