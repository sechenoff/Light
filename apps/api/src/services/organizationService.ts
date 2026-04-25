import type { OrganizationSettings, Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { writeAuditEntry, diffFields } from "./audit";

type TxClient = Omit<
  Prisma.TransactionClient,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends" | "$use"
>;

const SINGLETON_ID = "singleton";

/**
 * Получает настройки организации (синглтон).
 * При первом обращении создаёт запись с дефолтами.
 */
export async function getSettings(): Promise<OrganizationSettings> {
  return prisma.organizationSettings.upsert({
    where: { id: SINGLETON_ID },
    create: {
      id: SINGLETON_ID,
      legalName: "",
      inn: "",
      invoiceNumberPrefix: "LR",
      migrationCutoffAt: new Date(),
    },
    update: {},
  });
}

export type UpdateSettingsInput = Partial<
  Pick<
    OrganizationSettings,
    | "legalName"
    | "inn"
    | "kpp"
    | "bankName"
    | "bankBik"
    | "rschet"
    | "kschet"
    | "address"
    | "phone"
    | "email"
    | "invoiceNumberPrefix"
    | "migrationCutoffAt"
  >
>;

/**
 * Обновляет настройки организации (partial update).
 * Пишет аудит INVOICE_ORG_SETTINGS_UPDATE.
 *
 * M4: read + update выполняются в одной $transaction для защиты от race conditions
 * при одновременном обновлении из нескольких вкладок/запросов.
 */
export async function updateSettings(
  data: UpdateSettingsInput,
  userId: string,
): Promise<OrganizationSettings> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.organizationSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, legalName: "", inn: "" },
      update: {},
    });

    const updated = await tx.organizationSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, legalName: "", inn: "", ...data },
      update: data as Prisma.OrganizationSettingsUpdateInput,
    });

    // D11: Пишем полный diff всех полей (было только 3 из 12)
    await writeAuditEntry({
      tx: tx as TxClient,
      userId,
      action: "ORG_SETTINGS_UPDATE",
      entityType: "OrgSettings", // L4: правильный тип сущности
      entityId: SINGLETON_ID,
      before: diffFields({
        legalName: before.legalName,
        inn: before.inn,
        kpp: before.kpp,
        bankName: before.bankName,
        bankBik: before.bankBik,
        rschet: before.rschet,
        kschet: before.kschet,
        address: before.address,
        phone: before.phone,
        email: before.email,
        invoiceNumberPrefix: before.invoiceNumberPrefix,
        migrationCutoffAt: before.migrationCutoffAt?.toISOString() ?? null,
      } as Record<string, unknown>),
      after: diffFields({
        legalName: updated.legalName,
        inn: updated.inn,
        kpp: updated.kpp,
        bankName: updated.bankName,
        bankBik: updated.bankBik,
        rschet: updated.rschet,
        kschet: updated.kschet,
        address: updated.address,
        phone: updated.phone,
        email: updated.email,
        invoiceNumberPrefix: updated.invoiceNumberPrefix,
        migrationCutoffAt: updated.migrationCutoffAt?.toISOString() ?? null,
      } as Record<string, unknown>),
    });

    return updated;
  });
}
