// src/components/Hint.tsx
//
// A plain-English explanation of a control, on hover and on keyboard focus.
//
// WHY NOT THE `title` ATTRIBUTE
// -----------------------------
// The browser's native tooltip waits about a second, renders in the OS style at
// the pointer rather than against the control, cannot be styled to match the
// page, and never appears for keyboard users at all. This dashboard is dense
// with three- and four-option toggles whose labels are necessarily terse
// ("Unanimous", "Net move", "Has EXIT"); the whole point is that the meaning
// arrives in the same glance as the label, which a one-second delay defeats.
//
// WHY A PORTAL
// ------------
// Every card is `overflow: hidden` (WidgetCard) and the header is a sticky
// stacking context. A bubble positioned inside either one is clipped or lands
// under the next card. Rendering into <body> with fixed coordinates read off
// the trigger sidesteps both, and costs nothing while closed — no portal exists
// until something is hovered.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

type Rect = { top: number; bottom: number; left: number; width: number };

// Long enough that sweeping the pointer across a row of chips does not strobe a
// bubble per chip; short enough to feel like an answer rather than a wait.
const OPEN_DELAY_MS = 130;

export function Hint({
  text, children, side = "bottom",
}: {
  /** One sentence, in the words a reader already has. No jargon it must define. */
  text: string;
  children: ReactNode;
  side?: "bottom" | "top";
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);

  const close = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    setRect(null);
  }, []);

  const open = useCallback((delay: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = ref.current?.firstElementChild ?? ref.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setRect({ top: r.top, bottom: r.bottom, left: r.left, width: r.width });
    }, delay);
  }, []);

  // A tooltip must never outlive the thing it describes, or the reason it is on
  // screen. Scrolling and Escape both close it, and so does unmounting.
  useEffect(() => {
    if (!rect) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [rect, close]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  return (
    <>
      <span
        ref={ref}
        style={{ display: "inline-flex" }}
        onPointerEnter={(e) => { if (e.pointerType === "mouse") open(OPEN_DELAY_MS); }}
        onPointerLeave={close}
        onPointerDown={close}
        // Keyboard users get the same explanation, with no delay — they have
        // already committed to the control by tabbing to it.
        onFocusCapture={() => open(0)}
        onBlurCapture={close}
      >
        {children}
      </span>
      {rect && createPortal(<Bubble text={text} rect={rect} side={side} />, document.body)}
    </>
  );
}

function Bubble({ text, rect, side }: { text: string; rect: Rect; side: "bottom" | "top" }) {
  const MAX = 260;
  // Clamp into the viewport so a chip at either end of a scrolling row still
  // gets a fully readable bubble rather than one running off the edge.
  const half = Math.min(MAX, 240) / 2;
  const centre = rect.left + rect.width / 2;
  const left = Math.max(8 + half, Math.min(centre, window.innerWidth - 8 - half));

  return (
    <div
      role="tooltip"
      className="hint-bubble"
      style={{
        position: "fixed",
        left,
        transform: "translateX(-50%)",
        ...(side === "top"
          ? { top: rect.top - 8, translate: "0 -100%" }
          : { top: rect.bottom + 8 }),
        maxWidth: MAX,
        // Above the sticky header (z-index 30) and the drawer scrim.
        zIndex: 90,
        pointerEvents: "none",
        background: "#111827",
        color: "#f9fafb",
        fontSize: 11.5,
        lineHeight: 1.45,
        padding: "7px 10px",
        borderRadius: 8,
        boxShadow: "0 4px 14px rgba(0,0,0,0.18)",
      }}
    >
      {text}
    </div>
  );
}
