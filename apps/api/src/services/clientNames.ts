/**
 * Имя клиента и его написания.
 *
 * Один и тот же человек попадал в справочник несколько раз: «Петя Куб»,
 * «петя куб», «Петя  Куб». Причина — SQLite сравнивает кириллицу с учётом
 * регистра: `contains` в поиске не находил «Петя Куб» по «петя», окно выбора
 * предлагало «создать нового», а бронь заводила клиента по точному имени.
 *
 * Здесь — одно правило «это то же имя» (`normalizeClientName`) для поиска,
 * для защиты от новых дублей и для подсказки «похожие имена» при объединении.
 */
import type { Prisma } from "@prisma/client";

import { prisma } from "../prisma";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Ключ сравнения имён: без регистра, «ё» = «е», без кавычек, пробелы
 * схлопнуты. «ООО «Сфера»» и «ооо сфера» — одно имя.
 */
export function normalizeClientName(name: string): string {
  return name
    .normalize("NFC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[«»„“”"'`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

type ClientRef = { id: string; name: string };

/**
 * Существующий клиент с этим именем: сначала точное совпадение, потом то же
 * имя в другом написании. Если таких карточек уже несколько (дубли до
 * объединения) — та, у которой больше броней, при равенстве — старшая.
 */
export async function findClientByName(db: Db, name: string, opts: { excludeId?: string } = {}): Promise<ClientRef | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const exact = await db.client.findUnique({ where: { name: trimmed }, select: { id: true, name: true } });
  if (exact && exact.id !== opts.excludeId) return exact;
  const key = normalizeClientName(trimmed);
  if (!key) return null;
  const all = await db.client.findMany({
    select: { id: true, name: true, createdAt: true, _count: { select: { bookings: true } } },
  });
  const matches = all
    .filter((c) => c.id !== opts.excludeId && normalizeClientName(c.name) === key)
    .sort((a, b) => b._count.bookings - a._count.bookings || a.createdAt.getTime() - b.createdAt.getTime());
  return matches[0] ? { id: matches[0].id, name: matches[0].name } : null;
}

/**
 * Найти клиента брони по имени или завести нового. Телефон существующему
 * только дозаполняется (не перетирается); почта и комментарий пишутся, только
 * если их прислали явно, — та же семантика, что была у upsert по имени.
 */
export async function resolveClientForBooking(
  db: Db,
  args: { name: string; phone?: string | null; email?: string | null; comment?: string | null },
): Promise<{ id: string; name: string }> {
  const name = args.name.trim();
  const phone = args.phone?.trim() || null;
  const existing = await findClientByName(db, name);
  if (existing) {
    const current = await db.client.findUnique({ where: { id: existing.id }, select: { phone: true } });
    const data = {
      ...(phone && !current?.phone ? { phone } : {}),
      ...(args.email !== undefined ? { email: args.email } : {}),
      ...(args.comment !== undefined ? { comment: args.comment } : {}),
    };
    return Object.keys(data).length === 0
      ? existing
      : db.client.update({ where: { id: existing.id }, data, select: { id: true, name: true } });
  }
  // Гонка двух броней с новым именем: upsert по уникальному имени не даст
  // завести одного клиента дважды.
  return db.client.upsert({
    where: { name },
    update: {},
    create: { name, phone, email: args.email ?? null, comment: args.comment ?? null },
    select: { id: true, name: true },
  });
}

/** Сходство Дайса по парам букв: 1 — одинаковые строки, 0 — ничего общего. */
function diceSimilarity(a: string, b: string): number {
  const x = a.replace(/\s+/g, "");
  const y = b.replace(/\s+/g, "");
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const pairs = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i += 1) {
    const p = x.slice(i, i + 2);
    pairs.set(p, (pairs.get(p) ?? 0) + 1);
  }
  let common = 0;
  for (let i = 0; i < y.length - 1; i += 1) {
    const p = y.slice(i, i + 2);
    const n = pairs.get(p) ?? 0;
    if (n > 0) {
      common += 1;
      pairs.set(p, n - 1);
    }
  }
  return (2 * common) / (x.length - 1 + y.length - 1);
}

/** Насколько два имени похожи на одно (0…1). Порядок слов не важен. */
export function clientNameSimilarity(a: string, b: string): number {
  const na = normalizeClientName(a);
  const nb = normalizeClientName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const sorted = (s: string) => s.split(" ").sort().join(" ");
  if (sorted(na) === sorted(nb)) return 0.95;
  const words = (s: string) => new Set(s.split(" "));
  const wa = words(na);
  const wb = words(nb);
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  // «Петя Куб» внутри «Петя Куб гаффер» — то же лицо с уточнением.
  if (small.size >= 2 && [...small].every((w) => big.has(w))) return 0.9;
  return Math.max(diceSimilarity(na, nb), diceSimilarity(sorted(na), sorted(nb)));
}

/** С какого сходства имя считается «похожим» в подсказке объединения. */
export const SIMILAR_NAME_THRESHOLD = 0.6;

/** Клиенты с похожими именами — кандидаты в дубли, самые похожие первыми. */
export async function findSimilarClients(
  db: Db,
  clientId: string,
  limit = 8,
): Promise<Array<{ id: string; score: number }> | null> {
  const self = await db.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
  if (!self) return null;
  const others = await db.client.findMany({ where: { id: { not: clientId } }, select: { id: true, name: true } });
  return others
    .map((c) => ({ id: c.id, name: c.name, score: clientNameSimilarity(self.name, c.name) }))
    .filter((c) => c.score >= SIMILAR_NAME_THRESHOLD)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ru"))
    .slice(0, limit)
    .map(({ id, score }) => ({ id, score }));
}

/**
 * Поиск по имени для селектов: подстрока без учёта регистра и «ё/е».
 * Сначала имена, у которых с введённого начинается имя или слово, потом
 * остальные; внутри — по алфавиту.
 */
export async function searchClientIds(db: Db, search: string, limit: number): Promise<string[]> {
  const q = normalizeClientName(search);
  if (!q) return [];
  const all = await db.client.findMany({ select: { id: true, name: true } });
  const rank = (name: string): number | null => {
    const n = normalizeClientName(name);
    if (!n.includes(q)) return null;
    if (n.startsWith(q)) return 0;
    return n.split(" ").some((w) => w.startsWith(q)) ? 1 : 2;
  };
  return all
    .map((c) => ({ ...c, rank: rank(c.name) }))
    .filter((c): c is ClientRef & { rank: number } => c.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name, "ru"))
    .slice(0, limit)
    .map((c) => c.id);
}
