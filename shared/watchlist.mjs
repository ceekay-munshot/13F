// shared/watchlist.mjs
//
// THE CLIENT'S FUNDS. One list, read by both the dashboard and the pipeline.
//
// ---------------------------------------------------------------------------
// WHY THIS MOVED OUT OF src/lib/favourites.ts
// ---------------------------------------------------------------------------
// It was a frontend-only constant, so it decided which columns the Consensus
// view draws and nothing else. The ingest had never heard of it, and during a
// filing season the ingest is working through ten thousand managers a few
// hundred at a time — in the order EDGAR published them. The funds this
// dashboard is actually about were somewhere in that queue with everybody else,
// and could sit unread for two days while a client asked about one of them.
//
// Now the planner reads the same file and puts every CIK in it at the FRONT of
// the queue, every run. Add a fund here and the next run fetches it; remove one
// and it simply stops being prioritised. Nothing else needs touching.
//
// NOT A FALLBACK. This list decides ORDER, never SCOPE. If the SEC cannot be
// reached the run still does nothing and resumes later — falling back to a fixed
// set of funds is what let a broken discovery look healthy for a whole quarter,
// and `npm run guard` fails the build if that comes back.
//
// WHY CIKs AND NOT NAMES
// ----------------------
// Every CIK below was resolved against the live filer index and checked to be
// the entity that actually files the 13F. Name matching is unreliable for this
// asset class and quietly picks the wrong entity:
//
//   "Pershing Sq" matches both Pershing Square Capital Management ($13.7B) and
//                 PERSHING SQUARE HOLDCO ($0.6B)
//                 — and note that as of 2026-Q2 the right answer is the SECOND
//                 one, renamed Pershing Square Inc., because the holdings moved
//                 to it. Which entity is correct is not a fact about the names;
//                 it changes, and it is checked against who actually files.
//   "TCI"         matches TCI Fund Management ($45.2B) and an unrelated
//                 registered advisor called TCI Wealth Advisors ($1.9B)
//   "Abrams"      matches Abrams Capital Management ($4.6B) and Abrams Bison
//                 Investments ($2.3B)
//
// In each case the larger, well-known manager is the intended one, but that is
// a judgement — so it is recorded here rather than re-derived from a substring
// match at runtime.

/**
 * @typedef {object} WatchFund
 * @property {string} cik    zero-padded to ten, as every artifact path uses
 * @property {string} code   short label for matrix columns; 3 chars and unique
 * @property {string} label  display name, shortened where the filed name is unwieldy
 */

/**
 * The client's comparison set, in the order they gave it.
 *
 * Order is preserved deliberately: it is their mental ranking, and sorting it
 * by size or alphabetically would quietly overrule that. It is also the order
 * the ingest works through them, so the top of this list is fetched first.
 *
 * @type {WatchFund[]}
 */
export const CLIENT_WATCHLIST = [
  { cik: "0001067983", code: "BRK", label: "Berkshire Hathaway" },
  { cik: "0001590531", code: "FOX", label: "Foxhaven" },
  { cik: "0001061165", code: "LNP", label: "Lone Pine" },
  // MOVED 26 Aug 2026, from 0001336528 (Pershing Square Capital Management,
  // L.P.). That entity stopped reporting its own holdings: for 2026-Q2 it filed
  // a NOTICE saying its positions are included in the report of its public
  // parent, and named this CIK. So this is now the entity that actually files
  // the 13F, which is the rule the whole list is built on.
  //
  // The trade is real and was taken deliberately. The old CIK keeps the $13.7B
  // history and it stays browsable at its own page — which now links here — but
  // this entity's OWN earlier filings are a single ~$0.6B position, so its first
  // four quarters here look nothing like Pershing Square. The 2026-Q2 crossover
  // is flagged as a manager change and its deltas are withheld rather than
  // reported as 13 purchases; from 2026-Q3 the comparison is ordinary again.
  { cik: "0002026053", code: "PSH", label: "Pershing Square" },
  { cik: "0001960830", code: "SRG", label: "SurgoCap" },
  { cik: "0001647251", code: "TCI", label: "TCI Fund Mgmt" },
  { cik: "0001599383", code: "WND", label: "WindAcre" },
  { cik: "0001768375", code: "ASP", label: "Aspex" },
  { cik: "0001798849", code: "DUR", label: "Durable" },
  { cik: "0001358706", code: "ABR", label: "Abrams Capital" },
  { cik: "0001609098", code: "DAR", label: "Darsana" },
  { cik: "0002087378", code: "AVY", label: "Avantyr" },
  { cik: "0001279936", code: "CAN", label: "Cantillon" },
  { cik: "0001871926", code: "NUV", label: "Nuveen" },
];

/** Just the CIKs, for the ingest planner. */
export const WATCHLIST_CIKS = CLIENT_WATCHLIST.map((f) => f.cik);
