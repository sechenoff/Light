import nodemailer from "nodemailer";

type Transport = ReturnType<typeof nodemailer.createTransport>;

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

let cachedTransport: Transport | null = null;

function getTransport(): Transport | null {
  if (cachedTransport) return cachedTransport;
  if (!process.env.SMTP_HOST) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SMTP_HOST не настроен в production");
    }
    return null;
  }
  cachedTransport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    auth: process.env.SMTP_USER
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
  });
  return cachedTransport;
}

function baseUrl(): string {
  return process.env.PUBLIC_BASE_URL || "http://localhost:3000";
}

function from(): string {
  return process.env.SMTP_FROM || '"Светобаза" <noreply@svetobazarent.ru>';
}

async function send(opts: { to: string; subject: string; html: string; text: string }) {
  const tr = getTransport();
  if (!tr) {
    // Dev fallback — log to console
    // eslint-disable-next-line no-console
    console.log("[LK MAILER dev] →", opts.to, "|", opts.subject);
    // eslint-disable-next-line no-console
    console.log(opts.text);
    return;
  }
  await tr.sendMail({ from: from(), to: opts.to, subject: opts.subject, html: opts.html, text: opts.text });
}

export async function sendInviteEmail(account: { email: string; clientName?: string | null }, rawToken: string) {
  const url = `${baseUrl()}/lk/verify?token=${encodeURIComponent(rawToken)}`;
  const textGreeting = account.clientName ? `Здравствуйте, ${account.clientName}!` : "Здравствуйте!";
  const htmlGreeting = account.clientName ? `Здравствуйте, ${escHtml(account.clientName)}!` : "Здравствуйте!";
  const text = `${textGreeting}

Вам открыт доступ в личный кабинет Светобазы. Откройте ссылку, чтобы войти:

${url}

Ссылка действительна 24 часа.

Если вы не ожидали это письмо — просто проигнорируйте его.
`;
  const html = `<p>${htmlGreeting}</p>
<p>Вам открыт доступ в личный кабинет Светобазы.</p>
<p><a href="${url}" style="background:#1d4ed8;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Войти в кабинет</a></p>
<p style="color:#666;font-size:13px">Ссылка действительна 24 часа.<br/>Если вы не ожидали это письмо — просто проигнорируйте его.</p>`;
  await send({ to: account.email, subject: "Доступ в личный кабинет — Светобаза", html, text });
}

export async function sendLoginEmail(account: { email: string }, rawToken: string) {
  const url = `${baseUrl()}/lk/verify?token=${encodeURIComponent(rawToken)}`;
  const text = `Здравствуйте!

Вход в личный кабинет Светобазы. Откройте ссылку:

${url}

Ссылка действительна 15 минут.

Если это были не вы — просто проигнорируйте письмо.
`;
  const html = `<p>Здравствуйте!</p>
<p>Откройте ссылку, чтобы войти в личный кабинет Светобазы:</p>
<p><a href="${url}" style="background:#1d4ed8;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">Войти в кабинет</a></p>
<p style="color:#666;font-size:13px">Ссылка действительна 15 минут.<br/>Если это были не вы — просто проигнорируйте письмо.</p>`;
  await send({ to: account.email, subject: "Вход в личный кабинет — Светобаза", html, text });
}
