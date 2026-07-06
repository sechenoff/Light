/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /** Прокси /api → бэкенд: app/api/[...path]/route.ts (понятный JSON при ECONNREFUSED). Rewrites убраны — иначе Next обходит route и отдаёт голый «Internal Server Error». */
  transpilePackages: ['@light-rental/shared'],
  async redirects() {
    // Легаси-маршруты: страницы-редиректы (app/*/page.tsx с redirect()) убраны,
    // их поведение перенесено сюда — фреймворковый редирект вместо осиротевшего файла.
    return [
      {
        source: '/finance/payments-overview',
        destination: '/finance/payments',
        permanent: false,
      },
      { source: '/dashboard', destination: '/day', permanent: false },
      { source: '/equipment/import', destination: '/admin/more', permanent: false },
      { source: '/tasks/history', destination: '/tasks/archive', permanent: false },
      { source: '/admin/settings', destination: '/settings/organization', permanent: false },
      { source: '/settings', destination: '/settings/organization', permanent: false },
    ];
  },
};

export default nextConfig;

