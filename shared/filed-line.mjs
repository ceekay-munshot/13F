// shared/filed-line.mjs
//
// Reading what a filer typed on one holding line, where the form's own boxes
// say less than the line does. Used by both ingest paths and the Sectors build,
// so a line is read the same way everywhere.

const squash = (s) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();

/**
 * "Put" or "Call" when the filer typed it as the security's class instead of
 * ticking the form's put/call box, else null.
 *
 * Read as filed, such a line is shares: Alpine Investment Management's $585M
 * SanDisk put showed as a $585M purchase of SanDisk stock, at $173,989 a share,
 * and a SpaceX put sat in SpaceX's holders. Measured on the Sectors tab's funds
 * for June and September 2026 (64,191 lines): 59 options filed this way, $1.59B,
 * against 249 that used the box. Only the word itself counts. "OPTION" alone
 * does not say which, and "OPT STRATEGY ETF" is a fund.
 */
export function putCallFromClass(cls) {
  const m = /^(?:(?:LONG|SHORT) )?(?:OPTIONS? )?(PUT|CALL)S?(?: OPTIONS?)?$/.exec(squash(cls));
  return m ? (m[1] === "PUT" ? "Put" : "Call") : null;
}

/** The put/call box as filed or, when it is empty, what the class column says. */
export function putCallOf(filed, cls) {
  const f = filed == null ? "" : String(filed).trim();
  return f || putCallFromClass(cls);
}

/**
 * A ticker without the "ZZZZ" the SEC's list adds to a company's other code.
 *
 * Tickers come from the SEC's fails-to-deliver files. When a company has two
 * codes in them, around a reverse split, a re-listing or a move abroad, the
 * second carries the symbol plus ZZZZ: HONZZZZ is Honeywell, GTESZZZZ is Gates.
 * All 40 in the list are the same company as the plain symbol. Left on, one
 * fund's Honeywell reads as two companies, and Gates as a ticker nobody uses.
 */
export function cleanTicker(t) {
  if (!t) return t ?? null;
  const m = /^(.+?)ZZZZ$/.exec(t);
  return m ? m[1] : t;
}

/** The securities list with every ticker cleaned (see cleanTicker). */
export function cleanSecurities(securities) {
  const out = {};
  for (const [cusip, s] of Object.entries(securities ?? {})) {
    out[cusip] = s?.ticker && s.ticker !== cleanTicker(s.ticker) ? { ...s, ticker: cleanTicker(s.ticker) } : s;
  }
  return out;
}

/**
 * What kind of share a class describes: common, preferred, a warrant, a unit,
 * or a lettered class. Two lines can only be one holding if this agrees.
 */
export function shareKind(cls) {
  const c = squash(cls);
  if (/\b(PFD|PREF|PREFERRED|PRF|PFRD)\b/.test(c)) return "preferred";
  if (/\b(WT|WTS|WARRANT|WARRANTS|WRT|WRNT)\b/.test(c)) return "warrant";
  if (/\b(RT|RTS|RIGHT|RIGHTS)\b/.test(c)) return "right";
  if (/\bUNITS?\b/.test(c)) return "unit";
  if (/\b(NOTE|NOTES|DEB|DEBS|BOND|BONDS)\b/.test(c)) return "debt";
  const letter = /\bCL(?:ASS)? ?([A-Z])\b/.exec(c);
  return letter ? `class ${letter[1]}` : "common";
}

/**
 * A name a fund family files all its funds under. "ISHARES TR" is dozens of
 * different funds, so two such lines are only one holding if the class (which
 * names the fund) agrees word for word.
 */
const FAMILY_NAME = /\b(TR|TRUST|ETF|ETFS|FUND|FUNDS|FD|FDS|PORTFOLIO|PORTFOLIOS|SER|SERIES|ISHARES|SPDR|PROSHARES|DIREXION|VANGUARD|INVESCO)\b/;

/**
 * The same stock, filed under a different code from one quarter to the next.
 *
 * Changes are matched on the code a line is filed under, so when the code
 * changes the match fails and one holding reads as two trades: everything sold,
 * and a new purchase. Lingotto's Teva showed as "sold $685M" and "bought $694M"
 * in September 2026, when it had cut its shares by 13%. The causes are ordinary:
 * the company's code changed (ExxonMobil, Carnival and Gates moved to new
 * holding companies, Teva's shares replaced its ADRs, Ascendis moved from ADRs
 * to shares, ONEOK and Berkshire's B shares were re-issued), the SEC's list
 * marks the second code with ZZZZ, or the filer typed another code.
 *
 * `added` are this quarter's lines that matched nothing last quarter, `dropped`
 * last quarter's that match nothing now. A pair is one holding when:
 *   - it has the same ticker, or
 *   - it has the same name as filed, at most one of the two has a ticker, the
 *     same kind of share, and, under a fund family's name, the same issuer and
 *     the same class word for word;
 * and in either case each is the only candidate on its side, and the price per
 * share is between half and double. One share is then never paired with an ADR
 * worth ten, and a holding is not paired across a share consolidation, whose
 * share counts cannot be compared (Skye Bioscience's 1-for-10 would otherwise
 * read as a 90% cut).
 *
 * Measured on the Sectors tab's funds, June against March and September against
 * June 2026 (2,569 fund-quarters): 139 holdings were one stock re-coded, $4.77B
 * of sales and $4.77B of purchases that did not happen. 108 kept their ticker,
 * 31 matched by name. Every pair was checked by eye and is one company. Left
 * apart, rightly: two iShares bond funds under one name, AROW filed under
 * Associated Banc-Corp's name, and New Fortress Energy's preferred against its
 * common.
 *
 * @returns {Map<object, object>} this quarter's line -> last quarter's line
 */
export function pairRecoded(added, dropped) {
  const isShare = (h) =>
    (h.put_call ?? "") === "" && (h.ssh_prnamt_type ?? "SH") === "SH" && h.ssh_prnamt > 0 && h.value_usd > 0;
  const now = added.filter(isShare);
  const was = dropped.filter(isShare);
  const pairs = new Map();
  const used = new Set();

  // Lines by key, where a key two lines share maps to null: ambiguous, so neither.
  const only = (rows, keyOf) => {
    const m = new Map();
    for (const h of rows) {
      if (pairs.has(h) || used.has(h)) continue;
      const k = keyOf(h);
      if (k) m.set(k, m.has(k) ? null : h);
    }
    return m;
  };
  const price = (h) => h.value_usd / h.ssh_prnamt;
  const pass = (keyOf, fits) => {
    const before = only(was, keyOf);
    for (const [k, h] of only(now, keyOf)) {
      const p = before.get(k);
      if (!h || !p || !fits(h, p)) continue;
      const r = price(h) / price(p);
      if (!(r >= 0.5 && r <= 2)) continue;
      pairs.set(h, p);
      used.add(p);
    }
  };
  const sameIssuer = (a, b) =>
    a.cusip && b.cusip ? a.cusip.slice(0, 6) === b.cusip.slice(0, 6) : a.issuerId != null && a.issuerId === b.issuerId;

  pass((h) => cleanTicker(h.ticker), () => true);
  pass((h) => squash(h.name_of_issuer), (h, p) => {
    if (h.ticker && p.ticker) return false; // two different tickers are two stocks
    if (shareKind(h.title_of_class) !== shareKind(p.title_of_class)) return false;
    if (FAMILY_NAME.test(squash(h.name_of_issuer))) {
      return sameIssuer(h, p) && squash(h.title_of_class) === squash(p.title_of_class);
    }
    return true;
  });
  return pairs;
}
