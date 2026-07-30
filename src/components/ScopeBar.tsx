// src/components/ScopeBar.tsx
//
// Row 1 of Zone 2, not the header. The mandated content order puts filters and
// context first, and at 48px the header has room for a title, a pill and four
// controls — not a searchable picker over thousands of filers plus a quarter
// stepper.
//
// Deliberately a bare 36px control row rather than a WidgetCard: WidgetCard is
// for DATA widgets, and wrapping two controls in a 16-radius card wastes ~60px
// of vertical space and creates a card-then-cards stutter at the top of every
// view.

import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../theme";
import { periodLabel } from "../lib/format";
import type { Filer } from "../lib/data";

function Chip({
  active, onClick, children, title,
}: {
  active?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      className="pressable"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      style={{
        height: 28, padding: "0 10px", borderRadius: 8, cursor: "pointer",
        fontSize: 11.5, fontWeight: 600, fontFamily: "inherit", whiteSpace: "nowrap",
        border: `1px solid ${active ? t.primaryBorder : t.borderSolid}`,
        background: active ? t.primaryLight : "#fff",
        color: active ? t.primaryText : t.textMuted,
      }}
    >
      {children}
    </button>
  );
}

export function FundPicker({
  filers, value, onChange,
}: {
  filers: Filer[];
  value: string | null;
  onChange: (cik: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = filers.find((f) => f.cik === value);

  // Search runs entirely in the browser against a file downloaded once. No
  // request per keystroke, no debounce needed, no server to rate-limit.
  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return filers.slice(0, 60);
    return filers.filter((f) => f.name.toLowerCase().includes(needle)).slice(0, 60);
  }, [filers, q]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="pressable"
        onClick={() => setOpen((v) => !v)}
        style={{
          height: 28, padding: "0 10px", borderRadius: 8, cursor: "pointer",
          fontSize: 11.5, fontWeight: 600, fontFamily: "inherit",
          border: `1px solid ${t.borderSolid}`, background: "#fff", color: t.textPrimary,
          display: "inline-flex", alignItems: "center", gap: 6, maxWidth: 260,
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.name ?? "Select a fund"}
        </span>
        <span style={{ color: t.textHint, fontSize: 9 }}>▼</span>
      </button>

      <div
        className="popover"
        data-state={open ? "open" : "closed"}
        // Origin-aware: scales from the trigger it is anchored to, not from the
        // middle of the viewport.
        style={{
          ["--popover-origin" as string]: "top left",
          position: "absolute", top: 34, left: 0, zIndex: 40, width: 320,
          background: "#fff", border: `1px solid ${t.borderSolid}`, borderRadius: 12,
          boxShadow: "0 12px 32px rgba(0,0,0,0.12)", overflow: "hidden",
        }}
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search funds…"
          style={{
            width: "100%", border: "none", borderBottom: `1px solid ${t.border}`,
            padding: "9px 12px", fontSize: 12.5, outline: "none", fontFamily: "inherit",
          }}
        />
        <div style={{ maxHeight: 280, overflow: "auto" }}>
          {results.length === 0 && (
            <div style={{ padding: "14px 12px", fontSize: 12, color: t.textHint }}>No funds match “{q}”.</div>
          )}
          {results.map((f) => (
            <button
              key={f.cik}
              onClick={() => { onChange(f.cik); setOpen(false); setQ(""); }}
              style={{
                display: "flex", width: "100%", alignItems: "center", justifyContent: "space-between",
                gap: 10, padding: "7px 12px", border: "none", cursor: "pointer", textAlign: "left",
                background: f.cik === value ? t.primaryLight : "transparent",
                fontSize: 12, fontFamily: "inherit",
                color: f.cik === value ? t.primaryText : t.textSecondary,
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{f.name}</span>
              <span style={{ fontSize: 10.5, color: t.textHint, flexShrink: 0 }}>{f.periods}q</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export function ScopeBar({
  filers, cik, onCik, periods, period, onPeriod, longsOnly, onLongsOnly, right,
}: {
  filers: Filer[];
  cik: string | null;
  onCik: (c: string) => void;
  periods: string[];
  period: string;
  onPeriod: (p: string) => void;
  longsOnly: boolean;
  onLongsOnly: (v: boolean) => void;
  right?: React.ReactNode;
}) {
  const idx = periods.indexOf(period);
  const canNewer = idx > 0;
  const canOlder = idx >= 0 && idx < periods.length - 1;

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap",
        minHeight: 36, marginBottom: 4,
      }}
    >
      <FundPicker filers={filers} value={cik} onChange={onCik} />

      {/* The quarter stepper IS the lag disclosure. "Q2 2026 · as filed" on the
          control the user is already looking at does the work a banner would,
          without a banner. */}
      <div
        style={{
          display: "inline-flex", alignItems: "center", height: 28, borderRadius: 8,
          border: `1px solid ${t.borderSolid}`, background: "#fff", overflow: "hidden",
        }}
      >
        <button
          className="pressable"
          onClick={() => canOlder && onPeriod(periods[idx + 1])}
          disabled={!canOlder}
          aria-label="Older quarter"
          style={{
            border: "none", background: "transparent", cursor: canOlder ? "pointer" : "default",
            padding: "0 9px", height: "100%", color: canOlder ? t.textMuted : "#d1d5db",
            fontSize: 11, fontFamily: "inherit",
          }}
        >
          ◀
        </button>
        <span
          style={{
            fontSize: 11.5, fontWeight: 600, color: t.textPrimary, padding: "0 4px",
            whiteSpace: "nowrap", borderLeft: `1px solid ${t.border}`, borderRight: `1px solid ${t.border}`,
            height: "100%", display: "inline-flex", alignItems: "center", paddingInline: 10,
          }}
        >
          {periodLabel(period)}
          <span style={{ color: t.textHint, fontWeight: 400, marginLeft: 6 }}>· as filed</span>
        </span>
        <button
          className="pressable"
          onClick={() => canNewer && onPeriod(periods[idx - 1])}
          disabled={!canNewer}
          aria-label="Newer quarter"
          style={{
            border: "none", background: "transparent", cursor: canNewer ? "pointer" : "default",
            padding: "0 9px", height: "100%", color: canNewer ? t.textMuted : "#d1d5db",
            fontSize: 11, fontFamily: "inherit",
          }}
        >
          ▶
        </button>
      </div>

      {/* Longs-only is the DEFAULT and the honest one. "13F portfolio value"
          universally means long equity, and an option row's value is notional
          rather than exposure — for a manager like Citadel including it would
          more than quadruple the apparent book. */}
      <Chip
        active={longsOnly}
        onClick={() => onLongsOnly(!longsOnly)}
        title="Option values are notional, not exposure. Long equity only is the honest default."
      >
        {longsOnly ? "Longs only ✓" : "+ Options"}
      </Chip>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>{right}</div>
    </div>
  );
}
