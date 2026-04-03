/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /** Прокси /api → бэкенд: app/api/[...path]/route.ts (понятный JSON при ECONNREFUSED). Rewrites убраны — иначе Next обходит route и отдаёт голый «Internal Server Error». */
  transpilePackages: ['@light-rental/shared'],
};

export default nextConfig;

