import type { MetadataRoute } from "next";

/** Only the stable surfaces; per-address pages are excluded in robots.ts. */
const routes = ["/", "/swap", "/pools", "/tokens", "/analytics", "/docs", "/docs/contracts", "/docs/integration"];

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ?? "";
  const lastModified = new Date();

  return routes.map((route) => ({
    url: `${base}${route}`,
    lastModified,
    changeFrequency: route === "/" ? "weekly" : "daily",
    priority: route === "/" ? 1 : 0.7,
  }));
}
