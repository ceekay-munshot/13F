// src/components/ViewErrorBoundary.tsx
//
// The last line of defence against a WHITE PAGE.
//
// React unmounts the whole tree when a render throws and nothing catches it, so
// any error inside a view — a bad shape in an artifact, a chart given data it
// cannot plot, a lazy chunk that 404s after a deploy — leaves an empty document
// with no message and nothing to click. That is the worst possible failure:
// indistinguishable from "the product is broken" and impossible to recover from
// without knowing to hard-reload.
//
// Observed live, twice: a tab open across a deploy asks for a content-hashed
// chunk that no longer exists, the dynamic import rejects, and the page goes
// blank. Dashboard.tsx retries that case with one reload; this catches
// everything else, and catches the retry itself when it has already been spent.
//
// Deliberately a CLASS: error boundaries have no hooks equivalent.

import { Component, type ReactNode } from "react";
import { t, font } from "../theme";

interface Props { children: ReactNode; onReset?: () => void }
interface State { error: Error | null }

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Console, not a remote sink: this product has no server and sends nothing
    // anywhere. The message is for whoever opens devtools.
    console.error("[13F] view crashed:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    // A stale build is the common case and has a specific, effective cure, so
    // say which one this is rather than offering a generic "something went
    // wrong" that leaves the user guessing.
    const stale = /dynamically imported module|Importing a module script failed|Failed to fetch/i.test(
      error.message,
    );

    return (
      <div
        style={{
          display: "grid", placeItems: "center", minHeight: 320, padding: 24,
          fontFamily: font, textAlign: "center",
        }}
      >
        <div style={{ maxWidth: 460 }}>
          <div
            style={{
              width: 40, height: 40, borderRadius: 10, background: "#fef2f2", color: "#ef4444",
              display: "grid", placeItems: "center", fontSize: 18, margin: "0 auto 12px",
            }}
          >
            !
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: t.textPrimary, marginBottom: 6 }}>
            {stale ? "This page is out of date" : "This view could not be displayed"}
          </div>
          <p style={{ fontSize: 12.5, color: t.textMuted, lineHeight: 1.6, margin: "0 0 16px" }}>
            {stale
              ? "A newer version of the dashboard has been published since this tab was opened. Reloading picks it up — your data is fine."
              : "Something went wrong rendering this view. The underlying data is unaffected; reloading usually clears it."}
          </p>
          <button
            className="pressable"
            onClick={() => {
              // Clear the one-shot guard so the reload is allowed to happen.
              try { sessionStorage.removeItem("13f:chunk-reload"); } catch { /* private mode */ }
              location.reload();
            }}
            style={{
              fontSize: 12, fontWeight: 600, fontFamily: "inherit", cursor: "pointer",
              padding: "7px 14px", borderRadius: 8, border: `1px solid ${t.primaryBorder}`,
              background: t.primaryLight, color: t.primaryText,
            }}
          >
            Reload
          </button>
          <div style={{ marginTop: 14, fontSize: 10.5, color: t.textHint, wordBreak: "break-word" }}>
            {error.message}
          </div>
        </div>
      </div>
    );
  }
}
