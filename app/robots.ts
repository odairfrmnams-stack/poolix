import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Per-address pages are generated on demand from chain data; there are tens of
        // thousands of them and none carry content worth indexing on its own.
        disallow: ["/pools/", "/token/", "/dashboard"],
      },
    ],
  };
}
