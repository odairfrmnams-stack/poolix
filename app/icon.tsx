import { ImageResponse } from "next/og";

export const size = { width: 32, height: 32 };
export const contentType = "image/png";

/** The Poolix mark: two assets overlapping, with the shared area picked out. */
export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#08090a",
          borderRadius: 6,
        }}
      >
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
          <circle cx="9" cy="12" r="6.25" stroke="#e7eaec" strokeWidth="1.6" opacity="0.55" />
          <circle cx="15" cy="12" r="6.25" stroke="#e7eaec" strokeWidth="1.6" opacity="0.55" />
          <path d="M12 6.517A6.25 6.25 0 0 1 12 17.483 6.25 6.25 0 0 1 12 6.517Z" fill="#10b981" />
        </svg>
      </div>
    ),
    size,
  );
}
