/*
  The backdrop behind the swap card: concentric rings, a few curves feeding the centre,
  and a handful of nodes sitting on them.

  It is drawn rather than generated. Every coordinate below is fixed, so the composition
  is the same on every render and on every machine — no randomised particles, nothing that
  reflows between server and client.

  Contrast is the whole design constraint. The group sits at 55% opacity and its strokes
  run from 0.10 to 0.22, which puts every mark between roughly 5% and 12% against the
  #070908 canvas: enough to register as structure in peripheral vision, not enough to
  compete with the card in front of it. There is no blur filter and no large colour wash,
  because both are what make a background read as decoration instead of diagram.

  The curves all terminate just under the card's footprint, so they appear to run into the
  pool rather than past it — the card itself is the thing they converge on.
*/

/** Fixed node positions, each sitting on or near one of the rings. */
const NODES = [
  { cx: 152, cy: 262, r: 2.5, halo: 9 },
  { cx: 648, cy: 258, r: 2, halo: 0 },
  { cx: 168, cy: 556, r: 2, halo: 0 },
  { cx: 634, cy: 566, r: 2.5, halo: 8 },
  { cx: 400, cy: 74, r: 2, halo: 0 },
] as const;

/** Curves that run inward and stop beneath the card. */
const FLOWS = [
  { d: "M 38 268 C 190 176, 300 252, 396 394", slow: false, mobile: true },
  { d: "M 762 256 C 616 164, 502 250, 404 394", slow: true, mobile: true },
  { d: "M 64 556 C 212 648, 312 540, 396 406", slow: true, mobile: false },
  { d: "M 742 572 C 598 664, 500 548, 404 406", slow: false, mobile: false },
  { d: "M 400 26 C 472 148, 432 282, 401 392", slow: true, mobile: false },
] as const;

export function LiquidityField() {
  /*
    The page container has to clip horizontally so the rings never widen the document on
    a narrow viewport, but a clip alone leaves the arcs ending on a straight line at the
    container's edge. Fading the field out before it reaches that edge means the boundary
    is never the thing you notice.
  */
  const falloff =
    "radial-gradient(66% 62% at 50% 50%, #000 45%, rgba(0,0,0,0.55) 80%, transparent 100%)";

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
      style={{ maskImage: falloff, WebkitMaskImage: falloff }}
    >
      <svg
        viewBox="0 0 800 800"
        fill="none"
        // Scales with the viewport rather than sitting at a fixed size, so the rings keep
        // their relationship to the card from a phone up to a wide desktop.
        className="absolute top-1/2 left-1/2 w-[min(760px,175vw)] -translate-x-1/2 -translate-y-1/2 opacity-40 sm:w-[min(980px,140vw)] sm:opacity-50 lg:w-[min(1180px,120vw)] lg:opacity-55"
      >
        {/* Rings. The outermost is dropped on small screens, where it would only crowd
            the edges of a narrow viewport. */}
        <g stroke="var(--poolix-accent)" className="poolix-ring">
          <circle cx="400" cy="400" r="150" strokeWidth="1" strokeOpacity="0.18" />
          <circle cx="400" cy="400" r="236" strokeWidth="1" strokeOpacity="0.14" />
        </g>
        <g stroke="var(--poolix-accent)" className="poolix-ring poolix-ring--offset">
          <circle cx="400" cy="400" r="322" strokeWidth="1" strokeOpacity="0.11" />
          <circle
            cx="400"
            cy="400"
            r="398"
            strokeWidth="1"
            strokeOpacity="0.09"
            className="hidden sm:block"
          />
        </g>

        {/* A dotted ring, which reads as measurement rather than ornament. */}
        <circle
          cx="400"
          cy="400"
          r="193"
          stroke="var(--poolix-accent)"
          strokeWidth="1"
          strokeOpacity="0.16"
          strokeDasharray="1 9"
          strokeLinecap="round"
        />

        {/* Flow curves. Two carry a brighter leading dash; the rest stay flat so the
            movement reads as a current in the field, not as five racing lines. */}
        {FLOWS.map((flow) => (
          <g key={flow.d} className={flow.mobile ? undefined : "hidden md:block"}>
            <path
              d={flow.d}
              stroke="var(--poolix-accent)"
              strokeWidth="1"
              strokeOpacity="0.12"
              strokeLinecap="round"
            />
            <path
              d={flow.d}
              stroke="var(--poolix-accent)"
              strokeWidth="1.25"
              strokeOpacity="0.22"
              strokeLinecap="round"
              className={`poolix-flow-line${flow.slow ? " poolix-flow-line--slow" : ""}`}
            />
          </g>
        ))}

        {/* Nodes. Two carry a halo; the others are plain dots, so the halos read as
            emphasis rather than as a uniform effect applied to everything. */}
        {NODES.map((node) => (
          <g key={`${node.cx}-${node.cy}`}>
            {node.halo > 0 ? (
              <circle
                cx={node.cx}
                cy={node.cy}
                r={node.halo}
                fill="var(--poolix-accent)"
                fillOpacity="0.07"
                className={`poolix-node-halo${node.cx > 400 ? " poolix-node-halo--offset" : ""}`}
              />
            ) : null}
            <circle
              cx={node.cx}
              cy={node.cy}
              r={node.r}
              fill="var(--poolix-accent)"
              fillOpacity="0.28"
            />
          </g>
        ))}
      </svg>
    </div>
  );
}
