// src/components/FavouritesBar.tsx
//
// One-click access to the managers this dashboard is about.
//
// The fund picker searches 9,272 filers, which is right for finding anyone and
// wrong for the dozen you look at every day: three interactions (open, type,
// select) to reach a fund you named yourself. This is the shortcut — the set is
// always on screen and always one click away.
//
// The star is the whole "add any fund" affordance. It acts on the fund you are
// ALREADY looking at, so adding one is: find it once the slow way, star it,
// and it is a click away forever after. No separate manage-favourites screen,
// no drag targets, no second mental model.

import { t } from "../theme";
import { codeFor, labelFor } from "../lib/favourites";
import type { Filer } from "../lib/data";

export function FavouritesBar({
  favourites, filers, cik, onCik, onToggle, onReset, canReset,
}: {
  favourites: string[];
  filers: Filer[];
  cik: string | null;
  onCik: (cik: string) => void;
  onToggle: (cik: string) => void;
  onReset: () => void;
  canReset: boolean;
}) {
  const byCik = new Map(filers.map((f) => [f.cik, f]));
  const current = cik ? byCik.get(cik) : null;
  const starred = Boolean(cik && favourites.includes(cik));

  return (
    <div
      style={{
        display: "flex", alignItems: "center", gap: 8, marginTop: 10,
        // The row scrolls rather than wrapping. Wrapping would change the
        // page's height as the set grows, pushing the KPIs and chart down by a
        // line — the content below should not move because someone starred a
        // fund.
        overflowX: "auto", overflowY: "hidden", paddingBottom: 2,
        scrollbarWidth: "thin",
      }}
    >
      <span
        style={{
          fontSize: 10, fontWeight: 700, letterSpacing: "0.06em", color: t.textHint,
          flexShrink: 0, paddingRight: 2,
        }}
      >
        FAVOURITES
      </span>

      {favourites.map((c) => {
        const f = byCik.get(c);
        // A favourite that is not in the index at all — a CIK that stopped
        // filing, say — still renders. Dropping it silently would leave the
        // user unable to remove something they can no longer see.
        const name = f ? labelFor(c, f.name) : c;
        const active = c === cik;
        return (
          <button
            key={c}
            className="pressable fav-chip"
            data-active={active || undefined}
            onClick={() => onCik(c)}
            title={f ? f.name : `${c} — not in the current index`}
            style={{
              display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
              padding: "5px 10px", borderRadius: 8, cursor: "pointer",
              fontFamily: "inherit", fontSize: 11.5, fontWeight: 600,
              border: `1px solid ${active ? t.primaryBorder : t.border}`,
              background: active ? t.primaryLight : "#fff",
              color: active ? t.primaryText : t.textSecondary,
              whiteSpace: "nowrap",
            }}
          >
            <span
              style={{
                fontSize: 9.5, fontWeight: 800, letterSpacing: "0.04em",
                color: active ? t.primaryText : t.textHint,
              }}
            >
              {f ? codeFor(c, f.name) : "—"}
            </span>
            {name}
          </button>
        );
      })}

      {/* The star sits at the END of the row, not the start: it acts on the
          current fund, so it belongs after the set it modifies rather than
          in front of it competing for the first position. */}
      {current && (
        <button
          className="pressable fav-star"
          onClick={() => onToggle(current.cik)}
          aria-pressed={starred}
          title={starred ? `Remove ${current.name} from favourites` : `Add ${current.name} to favourites`}
          style={{
            display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0,
            padding: "5px 10px", borderRadius: 8, cursor: "pointer",
            fontFamily: "inherit", fontSize: 11.5, fontWeight: 600,
            border: `1px dashed ${starred ? t.primaryBorder : t.border}`,
            background: "transparent",
            color: starred ? t.primaryText : t.textMuted,
            whiteSpace: "nowrap",
          }}
        >
          <span aria-hidden="true" style={{ fontSize: 12, lineHeight: 1 }}>{starred ? "★" : "☆"}</span>
          {starred ? "Starred" : "Star this fund"}
        </button>
      )}

      {canReset && (
        <button
          className="pressable"
          onClick={onReset}
          title="Restore the original comparison set"
          style={{
            flexShrink: 0, padding: "5px 8px", borderRadius: 8, cursor: "pointer",
            fontFamily: "inherit", fontSize: 11, fontWeight: 600,
            border: "none", background: "transparent", color: t.textHint, whiteSpace: "nowrap",
          }}
        >
          Reset
        </button>
      )}
    </div>
  );
}
