// src/components/Kpi.tsx
import { t } from "../theme";

/**
 * A KPI tile carries four things, and the scope line is the one that stops it
 * from lying. "$412.6B" alone invites the reader to assume it is the funds' AUM;
 * "13F equity longs only" makes the denominator part of the number.
 */
export function Kpi({
  label, value, delta, deltaTone = "neutral", scope, muted,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  scope?: string;
  muted?: boolean;
}) {
  const toneColor =
    deltaTone === "up" ? "#059669" : deltaTone === "down" ? "#dc2626" : t.textMuted;

  return (
    <div
      className="widget-card"
      style={{
        background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 16,
        padding: "12px 16px", display: "flex", flexDirection: "column", gap: 2,
        backdropFilter: "blur(8px)", boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
        opacity: muted ? 0.55 : 1,
      }}
    >
      <div
        style={{
          fontSize: 10, fontWeight: 600, letterSpacing: "0.05em",
          textTransform: "uppercase", color: t.textHint,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22, fontWeight: 700, color: t.textPrimary, lineHeight: 1.15,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {delta && (
        <div style={{ fontSize: 11.5, fontWeight: 600, color: toneColor, fontVariantNumeric: "tabular-nums" }}>
          {delta}
        </div>
      )}
      {scope && <div style={{ fontSize: 10.5, color: t.textHint, lineHeight: 1.35 }}>{scope}</div>}
    </div>
  );
}

/** auto-fit, not auto-fill: five tiles stretch to fill the row rather than
 *  leaving a dead track at the end. */
export function KpiRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="stagger"
      style={{ display: "grid", gap: 20, gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))" }}
    >
      {children}
    </div>
  );
}
