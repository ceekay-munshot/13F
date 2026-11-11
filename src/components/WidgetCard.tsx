// src/components/WidgetCard.tsx
import type { ReactNode } from "react";
import { t } from "../theme";
import { Hint } from "./Hint";

export type Category = "markets" | "crypto" | "analytics" | "tools" | "india" | "heatmaps" | "sector";

const CATEGORY_COLORS: Record<Category, { bg: string; text: string; border: string }> = {
  markets: { bg: "#eff6ff", text: "#2563eb", border: "#dbeafe" },
  crypto: { bg: "#fff7ed", text: "#ea580c", border: "#fed7aa" },
  analytics: { bg: "#f5f3ff", text: "#7c3aed", border: "#ede9fe" },
  tools: { bg: "#f0fdf4", text: "#16a34a", border: "#bbf7d0" },
  india: { bg: "#fffbeb", text: "#d97706", border: "#fde68a" },
  heatmaps: { bg: "#fff1f2", text: "#e11d48", border: "#fecdd3" },
  sector: { bg: "#f0fdfa", text: "#0d9488", border: "#99f6e4" },
};

export function CategoryBadge({ category }: { category: Category }) {
  const c = CATEGORY_COLORS[category];
  return (
    <span
      style={{
        fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em",
        padding: "2px 8px", borderRadius: 6, border: `1px solid ${c.border}`,
        background: c.bg, color: c.text, whiteSpace: "nowrap",
      }}
    >
      {category}
    </span>
  );
}

/**
 * A one-line caveat strip that sits directly under a card header.
 *
 * Used where the data is real but a number would mislead — a pro-rata
 * reduction, a confidential omission, a units restatement. The point is that a
 * withheld number is explained in place, next to the gap it left, rather than
 * in a footnote nobody reads or a modal everyone dismisses.
 */
export function CaveatStrip({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        padding: "7px 16px", background: t.warnBg, borderBottom: `1px solid ${t.warnBorder}`,
        fontSize: 11.5, color: "#92400e", lineHeight: 1.4, flexShrink: 0,
      }}
    >
      <span>{children}</span>
      {action}
    </div>
  );
}

export function WidgetCard({
  title, subtitle, category, actions, toolbar, caveat, span = 1, bodyMinHeight, refreshing, children,
}: {
  title: string;
  subtitle?: string;
  category?: Category;
  /** Small controls that sit beside the title — a two-way toggle, a count. */
  actions?: ReactNode;
  /**
   * A full row of controls under the title. For a card with more filters than
   * fit beside its own name: put there, they crushed the title into a column
   * one word wide ("Consensus / matrix / Comparing / 14 / active ...").
   */
  toolbar?: ReactNode;
  caveat?: ReactNode;
  /** 1 = half the page on a wide screen; 2 = the full width, always. */
  span?: 1 | 2;
  bodyMinHeight?: number;
  refreshing?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={span > 1 ? "widget-card card-full" : "widget-card"}
      style={{
        // minWidth 0: a grid item's default minimum is its content, so one wide
        // table inside would otherwise push the card — and the page — sideways.
        minWidth: 0,
        background: t.cardBg,
        border: `1px solid ${t.border}`,
        borderRadius: 16,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        backdropFilter: "blur(8px)",
        boxShadow: "0 1px 4px rgba(0,0,0,0.04)",
        position: "relative",
      }}
    >
      <div
        style={{
          // WRAP, NEVER SQUEEZE. The title used to be the only thing allowed to
          // shrink, so a wide set of controls beside it squashed the heading
          // into a one-word-per-line column. Now the title keeps a readable
          // minimum and the controls drop onto their own line when they will not
          // fit beside it.
          display: "flex", alignItems: "center", justifyContent: "space-between",
          flexWrap: "wrap", columnGap: 12, rowGap: 8,
          padding: "10px 16px", borderBottom: toolbar ? "none" : `1px solid ${t.border}`,
          background: t.cardHeader, backdropFilter: "blur(8px)", flexShrink: 0,
          position: "relative", overflow: "hidden",
        }}
      >
        {/* Refreshing keeps the card mounted and shows progress in the chrome, so
            the previous quarter's numbers stay readable while the next load runs. */}
        {refreshing && <span className="refresh-bar" />}
        <div style={{ minWidth: 0, flex: "1 1 240px" }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: t.textPrimary }}>{title}</h3>
          {subtitle && (
            <p style={{ margin: "2px 0 0", fontSize: 11, color: t.textHint, lineHeight: 1.35 }}>{subtitle}</p>
          )}
        </div>
        {(actions || category) && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0, maxWidth: "100%" }}>
            {actions}
            {category && <CategoryBadge category={category} />}
          </div>
        )}
      </div>

      {toolbar && (
        <div
          style={{
            display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8,
            padding: "0 16px 10px", borderBottom: `1px solid ${t.border}`,
            background: t.cardHeader, flexShrink: 0,
          }}
        >
          {toolbar}
        </div>
      )}

      {caveat}

      <div
        className={refreshing ? "is-refreshing" : undefined}
        style={{
          flex: 1, position: "relative", overflow: "hidden",
          background: t.cardBodyBg, minHeight: bodyMinHeight,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Chart | Table style toggle for a card header.
 *
 * `hints` maps an option's label to a plain-English sentence shown on hover and
 * on focus. Every toggle in this product is necessarily terse — "Unanimous",
 * "Net move", "Δ Weight" — because it has to fit in a card header, and terse
 * labels are exactly the ones a reader has to guess at. Passing the hints here
 * rather than at each call site means one toggle component explains itself
 * everywhere it is used.
 */
export function ViewToggle<T extends string>({
  options, value, onChange, hints,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  hints?: Partial<Record<T, string>>;
}) {
  return (
    <div style={{ display: "inline-flex", flexWrap: "wrap", maxWidth: "100%", background: "#f3f4f6", borderRadius: 8, padding: 2, gap: 2 }}>
      {options.map((opt) => {
        const active = opt === value;
        const button = (
          <button
            className="pressable"
            onClick={() => onChange(opt)}
            aria-pressed={active}
            style={{
              border: "none", cursor: "pointer", borderRadius: 6,
              padding: "3px 9px", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap",
              background: active ? "#fff" : "transparent",
              color: active ? t.textPrimary : t.textMuted,
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
              fontFamily: "inherit",
            }}
          >
            {opt}
          </button>
        );
        const hint = hints?.[opt];
        return hint ? <Hint key={opt} text={hint}>{button}</Hint> : <span key={opt} style={{ display: "inline-flex" }}>{button}</span>;
      })}
    </div>
  );
}
