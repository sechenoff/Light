/**
 * Id платежа от ключа отправки (`requestKey`): повтор той же отправки после
 * сбоя сети находит уже записанный платёж, а не создаёт второй.
 *
 * Одиночный платёж и платёж «Разнести по продолжениям» строят id по-разному
 * (у разнесённого — по части). Поэтому каждый путь проверяет и чужую схему:
 * окно оплаты могло отправить один и тот же ключ сначала одиночным платежом,
 * а после сбоя — разнесённым (или наоборот), и без этой проверки клиент
 * заплатил бы дважды.
 */
import { createHash } from "node:crypto";

export function singlePaymentId(createdBy: string, requestKey: string): string {
  return `idem_${createHash("sha256").update(`${createdBy}:${requestKey}`).digest("hex")}`;
}

export function familyPaymentPartId(createdBy: string, requestKey: string, index: number): string {
  return `idem_${createHash("sha256").update(`${createdBy}:${requestKey}:family:${index}`).digest("hex")}`;
}
