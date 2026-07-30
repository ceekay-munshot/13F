// tests/sigv4.test.mjs
//
// Request signing for R2. These exist because two signing bugs reached the live
// service and only surfaced there: the canonical request omitted the query
// string (so every ListObjectsV2 failed with SignatureDoesNotMatch while PUTs
// succeeded), and the caller edited the URL after signing it.
//
// The invariant under test throughout: THE STRING YOU SIGN MUST BE THE REQUEST
// YOU SEND.

import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signRequest, canonicalQuery, canonicalUri, rfc3986 } from "../scripts/_sigv4.mjs";

const CREDS = {
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  host: "acct.r2.cloudflarestorage.com",
  bucket: "13f",
  now: new Date("2026-07-31T12:00:00Z"),
};

describe("signing-key derivation matches the AWS reference vector", () => {
  it("reproduces the published signature", () => {
    const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
    const signingKey = ["AWS4wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", "20150830", "us-east-1", "iam", "aws4_request"]
      .reduce((k, v) => hmac(k, v));
    const stringToSign =
      "AWS4-HMAC-SHA256\n20150830T123600Z\n20150830/us-east-1/iam/aws4_request\n" +
      "f536975d06c0309214f805bb90ccff089219ecd68b2577efef23edd43b7e1a59";
    expect(createHmac("sha256", signingKey).update(stringToSign).digest("hex"))
      .toBe("5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
  });
});

describe("rfc3986", () => {
  it("escapes the characters encodeURIComponent leaves alone", () => {
    // ! ' ( ) * must be percent-encoded for SigV4. A key containing any of them
    // would otherwise sign one way and transmit another.
    expect(rfc3986("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
  });

  it("escapes slashes (segments are joined afterwards)", () => {
    expect(rfc3986("a/b")).toBe("a%2Fb");
  });
});

describe("canonicalUri", () => {
  it("addresses the BUCKET with no trailing slash when the key is empty", () => {
    // The ListObjectsV2 case. A trailing slash here, or stripping one after
    // signing, is exactly what produced SignatureDoesNotMatch.
    expect(canonicalUri("13f", "")).toBe("/13f");
  });

  it("preserves separators while encoding each segment", () => {
    expect(canonicalUri("13f", "fund/0000089014/2026-03-31.json"))
      .toBe("/13f/fund/0000089014/2026-03-31.json");
  });
});

describe("canonicalQuery", () => {
  it("sorts by encoded parameter name", () => {
    expect(canonicalQuery({ "max-keys": "1000", "list-type": "2" }))
      .toBe("list-type=2&max-keys=1000");
  });

  it("encodes values, so a continuation token cannot break the signature", () => {
    // Real tokens are base64 and routinely contain + / =.
    const qs = canonicalQuery({ "continuation-token": "a+b/c=", "list-type": "2" });
    expect(qs).toBe("continuation-token=a%2Bb%2Fc%3D&list-type=2");
  });

  it("is empty for a request with no query", () => {
    expect(canonicalQuery({})).toBe("");
  });

  it("drops null and undefined rather than signing the string 'undefined'", () => {
    expect(canonicalQuery({ a: "1", b: undefined, c: null })).toBe("a=1");
  });
});

describe("signRequest — the url and the signature must agree", () => {
  it("includes the query string in the signed canonical request", () => {
    // THE original bug: the canonical request omitted the query, so PUT (no
    // query) signed correctly and LIST (with query) always failed.
    const r = signRequest({
      method: "GET", key: "", query: { "list-type": "2", "max-keys": "1000" }, ...CREDS,
    });
    const lines = r._canonicalRequest.split("\n");
    expect(lines[0]).toBe("GET");
    expect(lines[1]).toBe("/13f");
    expect(lines[2]).toBe("list-type=2&max-keys=1000"); // <- was empty
  });

  it("returns a url whose query matches what was signed", () => {
    // The SECOND bug: the caller appended/stripped query and slashes after
    // signing. Returning the final url from the signer makes that impossible.
    const r = signRequest({
      method: "GET", key: "", query: { "list-type": "2", "max-keys": "1000" }, ...CREDS,
    });
    expect(r.url).toBe("https://acct.r2.cloudflarestorage.com/13f?list-type=2&max-keys=1000");
    expect(r.url.split("?")[1]).toBe(r._canonicalRequest.split("\n")[2]);
  });

  it("signs a PUT with no query and no stray '?'", () => {
    const r = signRequest({
      method: "PUT", key: "fund/0000089014/2026-03-31.json", body: Buffer.from("{}"), ...CREDS,
    });
    expect(r.url).toBe("https://acct.r2.cloudflarestorage.com/13f/fund/0000089014/2026-03-31.json");
    expect(r.url).not.toContain("?");
    expect(r._canonicalRequest.split("\n")[2]).toBe("");
  });

  it("hashes the body, so two different bodies sign differently", () => {
    const a = signRequest({ method: "PUT", key: "k.json", body: Buffer.from("a"), ...CREDS });
    const b = signRequest({ method: "PUT", key: "k.json", body: Buffer.from("b"), ...CREDS });
    expect(a.headers["x-amz-content-sha256"]).not.toBe(b.headers["x-amz-content-sha256"]);
    expect(a.headers.Authorization).not.toBe(b.headers.Authorization);
  });

  it("is deterministic for a fixed timestamp", () => {
    const mk = () => signRequest({ method: "GET", key: "", query: { "list-type": "2" }, ...CREDS });
    expect(mk().headers.Authorization).toBe(mk().headers.Authorization);
  });

  it("re-signs with a fresh timestamp, so a backed-off retry stays in window", () => {
    const early = signRequest({ method: "PUT", key: "k.json", body: Buffer.from("x"), ...CREDS });
    const later = signRequest({
      method: "PUT", key: "k.json", body: Buffer.from("x"), ...CREDS,
      now: new Date("2026-07-31T12:20:00Z"),
    });
    expect(early.headers["x-amz-date"]).not.toBe(later.headers["x-amz-date"]);
    expect(early.headers.Authorization).not.toBe(later.headers.Authorization);
  });
});
