// src/components/WidgetCard.tsx
import type { ReactNode } from "react";
import { t } from "../theme";

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
  title, subtitle, category, actions, caveat, span = 1, bodyMinHeight, refreshing, children,
}: {
  title: string;
  subtitle?: string;
  category?: Category;
  actions?: ReactNode;
  caveat?: ReactNode;
  span?: 1 | 2 | 3;
  bodyMinHeight?: number;
  refreshing?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="widget-card"
      style={{
        gridColumn: span > 1 ? `span ${span}` : undefined,
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
          display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
          padding: "10px 16px", borderBottom: `1px solid ${t.border}`,
          background: t.cardHeader, backdropFilter: "blur(8px)", flexShrink: 0,
          position: "relative", overflow: "hidden",
        }}
      >
        {/* Refreshing keeps the card mounted and shows progress in the chrome, so
            the previous quarter's numbers stay readable while the next load runs. */}
        {refreshing && <span className="refresh-bar" />}
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: t.textPrimary }}>{title}</h3>
          {subtitle && (
            <p style={{ margin: "2px 0 0", fontSize: 11, color: t.textHint, lineHeight: 1.3 }}>{subtitle}</p>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {actions}
          {category && <CategoryBadge category={category} />}
        </div>
      </div>

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

/** Chart | Table style toggle for a card header. */
export function ViewToggle<T extends string>({
  options, value, onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div style={{ display: "inline-flex", background: "#f3f4f6", borderRadius: 8, padding: 2, gap: 2 }}>
      {options.map((opt) => {
        const active = opt === value;
        return (
          <button
            key={opt}
            className="pressable"
            onClick={() => onChange(opt)}
            aria-pressed={active}
            style={{
              border: "none", cursor: "pointer", borderRadius: 6,
              padding: "3px 9px", fontSize: 11, fontWeight: 600,
              background: active ? "#fff" : "transparent",
              color: active ? t.textPrimary : t.textMuted,
              boxShadow: active ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
              fontFamily: "inherit",
            }}
          >
            {opt}
          </button>
        );
      })}
    </div>
  );
}
