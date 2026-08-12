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
import { Hint } from "./Hint";
import { periodLabel, usd } from "../lib/format";
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

/** Highlight the matched run so it is obvious WHY a row matched. */
function Highlight({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const i = text.toLowerCase().indexOf(needle.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark style={{ background: "#fde68a", color: "inherit", borderRadius: 2, padding: "0 1px" }}>
        {text.slice(i, i + needle.length)}
      </mark>
      {text.slice(i + needle.length)}
    </>
  );
}

/**
 * Fund search. Built as a search FIELD rather than a select, because the universe
 * is thousands of managers — a dropdown arrow implies "pick from a short list"
 * and reads as the wrong affordance entirely.
 *
 * Search runs against a file downloaded once, so there is no request per
 * keystroke, no debounce, and nothing to rate-limit. That is what makes it
 * feel instant.
 */
export function FundPicker({
  filers, value, onChange, universeCount,
}: {
  filers: Filer[];
  value: string | null;
  onChange: (cik: string) => void;
  /** How many filers exist per the manifest. The index itself arrives after
      first paint, so `filers.length` is 0 for the first moment of every load —
      and "0 funds" on the control the user is looking at is a wrong number, not
      a loading state. The manifest count is the same build's answer and is what
      the header already displays. */
  universeCount?: number;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selected = filers.find((f) => f.cik === value);
  const needle = q.trim();

  /**
   * NOTHING IS COMPUTED UNTIL THE PICKER IS OPENED.
   *
   * The search ran, and the popover's whole result list was built into the DOM,
   * on every render whether or not it was open — 9,268 managers at roughly six
   * nodes each is ~55,000 elements, constructed synchronously, before the first
   * screen could paint. Measured on the production build: four seconds between
   * the filer index arriving and the Consensus view even being requested, all
   * of it spent building a list behind a closed popover.
   *
   * A closed picker now costs one button.
   */
  const results = useMemo(() => {
    if (!open) return [];
    const n = needle.toLowerCase();
    if (!n) return filers;
    // Rank prefix matches above substring matches: typing "co" should offer
    // Coatue before Renaissance Technologies.
    const starts: Filer[] = [];
    const contains: Filer[] = [];
    for (const f of filers) {
      const name = f.name.toLowerCase();
      if (name.startsWith(n)) starts.push(f);
      else if (name.includes(n) || (f.code ?? "").toLowerCase().includes(n)) contains.push(f);
    }
    return [...starts, ...contains];
  }, [open, filers, needle]);

  /**
   * And even open, only a readable slice is rendered.
   *
   * The list is a 380px scroller; past the first hundred rows the user is
   * scrolling, not reading, and the search box is the faster way to the other
   * nine thousand. Keyboard navigation and Enter both operate on THIS array, so
   * the cursor can never point at a row that is not on screen.
   */
  const MAX_ROWS = 100;
  const visible = useMemo(() => results.slice(0, MAX_ROWS), [results]);

  useEffect(() => setCursor(0), [needle]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Keep the keyboard cursor in view without animating — scroll-into-view on a
  // repeated keypress is exactly the kind of high-frequency action that should
  // never animate.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { setOpen(false); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, visible.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
    else if (e.key === "Enter") {
      e.preventDefault();
      const pick = visible[cursor];
      if (pick) { onChange(pick.cik); setOpen(false); setQ(""); }
    }
  }

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        className="pressable"
        onClick={() => setOpen((v) => !v)}
        title="Search funds"
        style={{
          height: 36, minWidth: 300, padding: "0 12px", borderRadius: 10, cursor: "text",
          fontSize: 13, fontFamily: "inherit", textAlign: "left",
          border: `1px solid ${open ? t.primary : t.borderSolid}`,
          boxShadow: open ? `0 0 0 3px ${t.primaryLight}` : "0 1px 2px rgba(0,0,0,0.04)",
          background: "#fff", color: t.textPrimary,
          display: "inline-flex", alignItems: "center", gap: 9,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
          <circle cx="6.8" cy="6.8" r="4.6" stroke={t.textMuted} strokeWidth="1.7" />
          <path d="M10.4 10.4 L14 14" stroke={t.textMuted} strokeWidth="1.7" strokeLinecap="round" />
        </svg>
        <span style={{ flex: 1, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected?.name ?? "Search funds…"}
        </span>
        <span style={{ fontSize: 10.5, color: t.textHint, flexShrink: 0 }}>
          {(filers.length || universeCount) ?? 0} funds
        </span>
      </button>

      <div
        className="popover"
        data-state={open ? "open" : "closed"}
        style={{
          ["--popover-origin" as string]: "top left",
          position: "absolute", top: 42, left: 0, zIndex: 40, width: 420, maxWidth: "92vw",
          background: "#fff", border: `1px solid ${t.borderSolid}`, borderRadius: 14,
          boxShadow: "0 18px 48px rgba(17,24,39,0.16)", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "11px 14px", borderBottom: `1px solid ${t.border}` }}>
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" style={{ flexShrink: 0 }} aria-hidden="true">
            <circle cx="6.8" cy="6.8" r="4.6" stroke={t.primary} strokeWidth="1.7" />
            <path d="M10.4 10.4 L14 14" stroke={t.primary} strokeWidth="1.7" strokeLinecap="round" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search by manager name…"
            style={{
              flex: 1, border: "none", padding: 0, fontSize: 14, outline: "none",
              fontFamily: "inherit", color: t.textPrimary, background: "transparent",
            }}
          />
          {q && (
            <button
              className="pressable"
              onClick={() => { setQ(""); inputRef.current?.focus(); }}
              aria-label="Clear"
              style={{ border: "none", background: "transparent", cursor: "pointer", color: t.textHint, fontSize: 14, padding: 0 }}
            >
              ✕
            </button>
          )}
        </div>

        <div
          style={{
            display: "flex", justifyContent: "space-between", padding: "6px 14px",
            fontSize: 10.5, color: t.textHint, background: "#fafafa", borderBottom: `1px solid ${t.border}`,
          }}
        >
          <span>
            {results.length} of {filers.length}{needle ? ` matching “${needle}”` : ""}
            {results.length > MAX_ROWS && ` · showing first ${MAX_ROWS}`}
          </span>
          <span>↑↓ navigate · ↵ select · esc close</span>
        </div>

        <div ref={listRef} style={{ maxHeight: 380, overflowY: "auto" }}>
          {visible.length === 0 ? (
            <div style={{ padding: "22px 14px", fontSize: 13, color: t.textHint, textAlign: "center" }}>
              {open ? `No manager matches “${needle}”.` : ""}
            </div>
          ) : (
            visible.map((f, i) => {
              const active = i === cursor;
              const isSel = f.cik === value;
              return (
                <button
                  key={f.cik}
                  data-idx={i}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => { onChange(f.cik); setOpen(false); setQ(""); }}
                  style={{
                    display: "flex", width: "100%", alignItems: "center", gap: 10,
                    padding: "9px 14px", border: "none", cursor: "pointer", textAlign: "left",
                    background: active ? t.primaryLight : "transparent",
                    fontFamily: "inherit",
                    borderLeft: `3px solid ${isSel ? t.primary : "transparent"}`,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: 13, fontWeight: 600, color: t.textPrimary,
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      }}
                    >
                      <Highlight text={f.name} needle={needle} />
                    </div>
                    <div style={{ fontSize: 10.5, color: t.textHint, marginTop: 1 }}>
                      {f.latestPeriod ? `latest ${periodLabel(f.latestPeriod)}` : "no filings"}
                      {f.state ? ` · ${f.state}` : ""}
                      {` · ${f.periods} quarter${f.periods === 1 ? "" : "s"}`}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 11.5, fontWeight: 600, color: t.textMuted,
                      fontVariantNumeric: "tabular-nums", flexShrink: 0,
                    }}
                  >
                    {usd(f.latestValueUsd)}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}

export function ScopeBar({
  filers, cik, onCik, periods, period, onPeriod, longsOnly, onLongsOnly, right, universeCount,
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
  /** Manifest filer count, used while the index is still in flight. */
  universeCount?: number;
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
      <FundPicker filers={filers} value={cik} onChange={onCik} universeCount={universeCount} />

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
      <Hint
        text={
          longsOnly
            ? "Counting shares only, which is the honest default. Click to also include options."
            : "Options are included. Their value is the notional size of the bet, not money invested, so totals can look far larger than the real book. Click to go back to shares only."
        }
      >
        <Chip active={longsOnly} onClick={() => onLongsOnly(!longsOnly)}>
          {longsOnly ? "Longs only ✓" : "+ Options"}
        </Chip>
      </Hint>

      <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>{right}</div>
    </div>
  );
}
