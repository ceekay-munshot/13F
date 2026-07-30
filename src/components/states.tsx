// src/components/states.tsx
//
// Every widget ships all five states. The interesting ones here are the ones
// that carry a fact rather than an apology: 13F data is legitimately absent,
// legitimately incomplete, and legitimately stale, and saying so precisely is
// more useful than a generic "no data".

import type { ReactNode } from "react";
import { t } from "../theme";

const centered: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
  gap: 8, minHeight: 160, padding: 24, textAlign: "center",
};

/** Shimmer skeleton shaped like the widget it replaces — never a spinner. */
export function ChartSkeleton({ bars = 7, height = 180 }: { bars?: number; height?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height, padding: 20 }}>
      {Array.from({ length: bars }, (_, i) => (
        <div
          key={i}
          className="shimmer"
          style={{ flex: 1, height: `${35 + ((i * 37) % 60)}%` }}
        />
      ))}
    </div>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 9 }}>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: "flex", gap: 10 }}>
          {Array.from({ length: cols }, (_, c) => (
            <div key={c} className="shimmer" style={{ height: 13, flex: c === 0 ? 2.4 : 1 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

/** Matrix skeleton: real fund codes render immediately — they are known before
 *  any data arrives, so showing them costs nothing and steadies the layout. */
export function MatrixSkeleton({ funds, rows = 8 }: { funds: string[]; rows?: number }) {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 10, paddingLeft: 172 }}>
        {funds.map((f) => (
          <div key={f} style={{ width: 56, fontSize: 10, fontWeight: 700, color: t.textHint, textAlign: "center" }}>
            {f}
          </div>
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
          <div className="shimmer" style={{ width: 164, height: 22 }} />
          {funds.map((f) => (
            <div key={f} className="shimmer" style={{ width: 56, height: 22 }} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ icon = "▦", message, hint }: { icon?: string; message: string; hint?: string }) {
  return (
    <div style={centered}>
      <div
        style={{
          width: 36, height: 36, borderRadius: 10, background: t.primaryLight,
          color: t.primary, display: "grid", placeItems: "center", fontSize: 16,
        }}
      >
        {icon}
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: t.textSecondary }}>{message}</div>
      {hint && <div style={{ fontSize: 12, color: t.textHint, maxWidth: 320 }}>{hint}</div>}
    </div>
  );
}

export function ErrorState({ message = "Couldn't load this widget." }: { message?: string }) {
  return (
    <div style={centered}>
      <div
        style={{
          width: 36, height: 36, borderRadius: 10, background: t.errorBg,
          color: t.errorRed, display: "grid", placeItems: "center", fontSize: 16,
        }}
      >
        !
      </div>
      {/* Never a stack trace: it tells the reader nothing they can act on and
          makes a transient blip look like a broken product. */}
      <div style={{ fontSize: 13, fontWeight: 600, color: t.textSecondary }}>{message}</div>
      <div style={{ fontSize: 12, color: t.textHint }}>Please try again later.</div>
    </div>
  );
}

/**
 * No host session. Scoped to the widget, never a full-page error — the rest of
 * the dashboard renders fine from public SEC data, and blanking all of it
 * because one authenticated call has no token would be a worse experience than
 * the missing call itself.
 */
export function WaitingForSession() {
  return (
    <div style={centered}>
      <div className="shimmer" style={{ width: 120, height: 13 }} />
      <div style={{ fontSize: 12, color: t.textHint }}>Waiting for your Munshot session…</div>
    </div>
  );
}

/**
 * Inside an iframe but the SDK never loaded. This is a production auth failure,
 * and it must NOT look like "there is no data" — that reading sends the user
 * hunting for a data problem that does not exist.
 */
export function SdkMissingState() {
  return (
    <div style={{ ...centered, minHeight: 240 }}>
      <div
        style={{
          width: 40, height: 40, borderRadius: 12, background: t.errorBg,
          color: t.errorRed, display: "grid", placeItems: "center", fontSize: 18,
        }}
      >
        !
      </div>
      <div style={{ fontSize: 14, fontWeight: 600, color: t.textPrimary }}>Dashboard could not connect to Munshot</div>
      <div style={{ fontSize: 12.5, color: t.textMuted, maxWidth: 380, lineHeight: 1.5 }}>
        The Munshot Dashboard SDK did not load, so this dashboard has no session. This is a
        loading problem, not a data problem — reloading the page usually fixes it.
      </div>
    </div>
  );
}

/** Dev-only banner when running outside the host. */
export function StandaloneBanner() {
  return (
    <div
      style={{
        padding: "5px 12px", background: t.primaryLight, color: t.primaryText,
        fontSize: 11, fontWeight: 600, borderBottom: `1px solid ${t.primaryBorder}`,
        textAlign: "center", flexShrink: 0,
      }}
    >
      Standalone dev mode — no Munshot host session
    </div>
  );
}

/**
 * Partial data. The most valuable state in this product: a dashboard that tells
 * you what is MISSING cannot go silently stale, and "3 of 7 funds have filed"
 * is a real answer rather than a caveat.
 */
export function PartialNotice({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        padding: "6px 16px", background: t.primaryLight, color: t.primaryText,
        fontSize: 11.5, borderBottom: `1px solid ${t.primaryBorder}`, flexShrink: 0,
      }}
    >
      <span>{children}</span>
      {action}
    </div>
  );
}
