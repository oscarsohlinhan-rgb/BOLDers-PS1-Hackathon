/** @type {import('next').NextConfig} */
if (process.env.RAILWAY_PROJECT_ID && !process.env.API_INTERNAL_URL) {
  throw new Error("API_INTERNAL_URL is required for Railway builds");
}
const API = process.env.API_INTERNAL_URL || "http://localhost:8000";
module.exports = {
  async redirects() {
    return [{ source: "/", destination: "/mockup", permanent: false }];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API}/:path*` }];
  },
};
