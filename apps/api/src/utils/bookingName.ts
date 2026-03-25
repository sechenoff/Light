export function buildBookingHumanName(args: {
  startDate: Date;
  clientName: string;
  totalAfterDiscount: string | number;
}): string {
  const date = args.startDate.toLocaleDateString("ru-RU");
  const totalInt = Math.round(Number(args.totalAfterDiscount) || 0);
  return `${date} ${args.clientName} ${totalInt}`;
}

export function safeFileName(base: string): string {
  return base.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
}
