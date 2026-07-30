#!/usr/bin/env node
// scripts/_sigv4.mjs
//
// AWS Signature Version 4 for S3-compatible APIs (Cloudflare R2).
//
// Extracted into its own module so it can be unit-tested. It was previously
// inline in publish-r2.mjs and shipped two signature bugs that only appeared
// against the live service:
//
//   1. The canonical request omitted the QUERY STRING. Signing worked for PUT
//      (no query) and failed for ListObjectsV2 (`?list-type=2&...`) with
//      SignatureDoesNotMatch.
//   2. The caller stripped a trailing slash from the URL AFTER signing, so the
//      path that was signed was not the path that was sent.
//
// Both are the same underlying mistake: the string you sign must be byte-for-byte
// the request you send. This module therefore returns the final URL alongside the
// headers, so a caller cannot modify one without the other.

import { createHash, createHmac } from "node:crypto";

const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();

/**
 * RFC 3986 encoding, which is what SigV4 requires.
 *
 * encodeURIComponent leaves ! ' ( ) * unescaped; AWS expects them percent-encoded.
 * A key or query value containing any of them would otherwise sign one way and
 * transmit another.
 */
export function rfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** Canonical query string: RFC3986-encoded pairs, sorted by encoded name. */
export function canonicalQuery(query = {}) {
  const pairs = Object.entries(query)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => [rfc3986(k), rfc3986(String(v))]);
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
  return pairs.map(([k, v]) => `${k}=${v}`).join("&");
}

/**
 * Canonical URI for a path-style S3 request.
 *
 * Each segment is encoded individually so the separating slashes survive. An
 * empty key addresses the bucket itself (used by ListObjectsV2) and must NOT
 * gain a trailing slash — that was one of the two mismatches above.
 */
export function canonicalUri(bucket, key) {
  const segments = key ? String(key).split("/") : [];
  return "/" + [bucket, ...segments].map(rfc3986).join("/");
}

/**
 * Sign one request.
 *
 * @returns {{url: string, headers: Record<string,string>}} Use BOTH verbatim.
 *   Mutating the returned url invalidates the signature.
 */
export function signRequest({
  method, host, bucket, key = "", query = {}, body = null,
  accessKeyId, secretAccessKey, region = "auto", service = "s3",
  now = new Date(),
}) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = body ? sha256(body) : sha256("");

  const headers = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  const signedHeaderNames = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const canonicalHeaders = signedHeaderNames
    .map((n) => `${n}:${String(headers[n]).trim()}\n`)
    .join("");

  const uri = canonicalUri(bucket, key);
  const qs = canonicalQuery(query);

  const canonicalRequest = [
    method, uri, qs, canonicalHeaders, signedHeaderNames.join(";"), payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const signingKey = ["AWS4" + secretAccessKey, dateStamp, region, service, "aws4_request"]
    .reduce((k, v) => hmac(k, v));
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    url: `https://${host}${uri}${qs ? `?${qs}` : ""}`,
    headers: {
      ...headers,
      Authorization:
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
    },
    // Exposed for tests.
    _canonicalRequest: canonicalRequest,
  };
}
