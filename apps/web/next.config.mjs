/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /** Прокси /api → бэкенд: app/api/[...path]/route.ts (понятный JSON при ECONNREFUSED). Rewrites убраны — иначе Next обходит route и отдаёт голый «Internal Server Error». */
  transpilePackages: ['@light-rental/shared'],
  async redirects() {
    return [
      {
        source: '/finance/payments-overview',
        destination: '/finance/payments',
        permanent: false,
      },
    ];
  },
};

export default nextConfig;

