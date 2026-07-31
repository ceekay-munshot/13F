// src/lib/csv.ts
//
// CSV export. Plan §6.10 mandates an export control, and until now no data
// could leave the dashboard by any route.
//
// THE CUSIP RULE IS STRUCTURAL, NOT POLICY
// ----------------------------------------
// Export takes rows that are already shaped for the screen — the same
// view-model the tables render. A view-model with no cusip field has nothing to
// leak, so the exclusion holds by construction rather than by remembering to
// strip a column here. That is the whole reason this function takes
// `{header, cell}` pairs over an existing row type instead of serialising a
// record wholesale: you cannot accidentally widen it.
//
// Everything is generated in the browser from data already fetched. No endpoint,
// no upload, nothing leaves the machine.

/** RFC 4180: quote when the value contains a comma, quote, or newline. */
function escapeCell(value: unknown): string {
  if (value == null) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export interface CsvColumn<T> {
  header: string;
  cell: (row: T) => string | number | null | undefined;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => escapeCell(c.header)).join(",")];
  for (const r of rows) lines.push(columns.map((c) => escapeCell(c.cell(r))).join(","));
  // CRLF, because Excel on Windows treats a bare LF file as one long row.
  return lines.join("\r\n");
}

/**
 * Trigger a download of `rows` as `filename`.
 *
 * Uses a Blob + object URL rather than a `data:` URI: Safari caps data: URIs at
 * a couple of megabytes and a full-universe export blows straight past that.
 * The URL is revoked on the next tick so the tab does not retain the blob.
 */
export function downloadCsv<T>(filename: string, rows: T[], columns: CsvColumn<T>[]): void {
  const blob = new Blob(["﻿" + toCsv(rows, columns)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
