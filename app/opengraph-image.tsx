import { ImageResponse } from "next/og";

import { poolixConfig } from "@/config/poolix";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const alt = "Poolix — Liquidity Infrastructure for Robinhood Chain";

export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#08090a",
          padding: 72,
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <svg width="44" height="44" viewBox="0 0 24 24" fill="none">
            <circle cx="9" cy="12" r="6.25" stroke="#e7eaec" strokeWidth="1.5" opacity="0.55" />
            <circle cx="15" cy="12" r="6.25" stroke="#e7eaec" strokeWidth="1.5" opacity="0.55" />
            <path d="M12 6.517A6.25 6.25 0 0 1 12 17.483 6.25 6.25 0 0 1 12 6.517Z" fill="#10b981" />
          </svg>
          <div style={{ fontSize: 30, fontWeight: 600, color: "#e7eaec", letterSpacing: 2 }}>POOLIX</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 68, fontWeight: 600, color: "#e7eaec", lineHeight: 1.1, letterSpacing: -2 }}>
            Liquidity infrastructure
          </div>
          {/* One text node per element: satori rejects an element with several children
              unless it declares a display mode. */}
          <div style={{ fontSize: 68, fontWeight: 600, color: "#e7eaec", lineHeight: 1.1, letterSpacing: -2 }}>
            {`for ${poolixConfig.chain.name}.`}
          </div>
          <div style={{ fontSize: 26, color: "#939ba1", marginTop: 28 }}>
            Swap, provide liquidity, and explore onchain markets from one interface.
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 20, color: "#646c72" }}>
          <div style={{ width: 8, height: 8, borderRadius: 99, background: "#10b981" }} />
          <div>{`Chain ${poolixConfig.chain.id}`}</div>
        </div>
      </div>
    ),
    size,
  );
}
