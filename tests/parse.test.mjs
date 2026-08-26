// tests/parse.test.mjs
//
// Parser regressions pinned against the REAL byte shapes on sec.gov.
//
// The index-headers fixture below is a verbatim excerpt of Berkshire's
// 0001193125-26-226661-index-headers.html. It exists because an earlier version
// of parseIndexHeaders assumed raw SGML and found zero documents on every real
// filing — the tags are HTML-ESCAPED inside <PRE>, and ACCEPTANCE-DATETIME is a
// tag rather than a "LABEL: value" line. Synthetic fixtures could not have
// caught either.

import { describe, it, expect } from "vitest";
import {
  parseIndexHeaders,
  parseInfoTable,
  parsePrimaryDoc,
  etStampToUtcISO,
  normalizeDate,
  stripXslPrefix,
  parseFormIdx,
  parseMasterIdx,
  accessionFromPath,
} from "../scripts/_sec-parse.mjs";

// Verbatim shape from sec.gov: an unescaped SEC-HEADER inside an HTML comment
// (which contains NO document blocks), then the escaped SGML inside <PRE>.
const BERKSHIRE_HEADERS = `<HTML><HEAD><TITLE>SEC EDGAR Submission 0001193125-26-226661</TITLE>
<!--
<SEC-HEADER>0001193125-26-226661.hdr.sgml : 20260515
<ACCEPTANCE-DATETIME>20260515160605
<TYPE>13F-HR
</SEC-HEADER>
-->
</HEAD><BODY>
<PRE>&lt;SEC-DOCUMENT&gt;0001193125-26-226661-index.html : 20260515
&lt;SEC-HEADER&gt;0001193125-26-226661.hdr.sgml : 20260515
&lt;ACCEPTANCE-DATETIME&gt;20260515160605
ACCESSION NUMBER:\t\t0001193125-26-226661
CONFORMED SUBMISSION TYPE:\t13F-HR
CONFORMED PERIOD OF REPORT:\t20260331
FILED AS OF DATE:\t\t20260515

FILER:

\tCOMPANY DATA:\t
\t\tCOMPANY CONFORMED NAME:\t\t\tBERKSHIRE HATHAWAY INC
\t\tCENTRAL INDEX KEY:\t\t\t0001067983

\tFORMER CONFORMED NAME:\tNBH INC
&lt;/SEC-HEADER&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;13F-HR
&lt;SEQUENCE&gt;1
&lt;FILENAME&gt;primary_doc.xml
&lt;TEXT&gt;
<a href="xslX02/primary_doc.xml">Document 1 - file: primary_doc.html</a><br>
<a href="primary_doc.xml">Document 1 - RAW XML: primary_doc.xml</a><br>
&lt;/DOCUMENT&gt;
&lt;DOCUMENT&gt;
&lt;TYPE&gt;INFORMATION TABLE
&lt;SEQUENCE&gt;2
&lt;FILENAME&gt;53405.xml
&lt;DESCRIPTION&gt;INFORMATION TABLE FOR FORM 13F
&lt;TEXT&gt;
<a href="xsl/53405.xml">Document 2 - file: 53405.html</a><br>
<a href="53405.xml">Document 2 - RAW XML: 53405.xml</a><br>
&lt;/DOCUMENT&gt;
&lt;/SEC-DOCUMENT&gt;</PRE></BODY></HTML>`;

describe("parseIndexHeaders — the authoritative document selector", () => {
  const h = parseIndexHeaders(BERKSHIRE_HEADERS);

  it("finds the information table despite the HTML escaping", () => {
    expect(h.infoTableFilename).toBe("53405.xml");
  });

  it("proves a filename glob would have found nothing", () => {
    // This is the entire justification for spending a request on the SGML
    // header instead of globbing index.json.
    expect(/informationtable/i.test(h.infoTableFilename)).toBe(false);
    expect(h.infoTableFilename).not.toBe("infotable.xml");
  });

  it("is not fooled by the <a href> links that follow <TEXT>", () => {
    const doc1 = h.documents.find((d) => d.type === "13F-HR");
    expect(doc1.filename).toBe("primary_doc.xml");
    expect(h.documents).toHaveLength(2);
  });

  it("reads ACCEPTANCE-DATETIME from its TAG form, not a LABEL: form", () => {
    // 2026-05-15 16:06:05 Eastern (EDT, UTC-4) == 20:06:05 UTC, which is
    // exactly what the submissions API reports for this accession.
    expect(h.acceptanceDatetime).toBe("2026-05-15T20:06:05.000Z");
    expect(h.acceptanceRawEastern).toBe("20260515160605");
  });

  it("reads the label-form header fields", () => {
    expect(h.periodOfReport).toBe("2026-03-31");
    expect(h.filedAsOfDate).toBe("2026-05-15");
    expect(h.formType).toBe("13F-HR");
  });

  it("captures every CIK on the submission and any former names", () => {
    // Capturing all CIKs is what stops two watchlist funds that co-file one
    // 13F from double-counting into 100% overlap.
    expect(h.ciks).toContain("0001067983");
    expect(h.formerNames).toContain("NBH INC");
  });
});

describe("etStampToUtcISO — the fold's ordering depends on this", () => {
  it("converts EDT (summer, UTC-4)", () => {
    expect(etStampToUtcISO("20260515160605")).toBe("2026-05-15T20:06:05.000Z");
  });

  it("converts EST (winter, UTC-5)", () => {
    // 2026-02-17 is the real 4Q-2025 deadline — squarely in standard time.
    expect(etStampToUtcISO("20260217150000")).toBe("2026-02-17T20:00:00.000Z");
  });

  it("returns null on malformed input rather than a wrong instant", () => {
    expect(etStampToUtcISO("2026-05-15")).toBeNull();
    expect(etStampToUtcISO("")).toBeNull();
  });
});

describe("parseInfoTable — namespace prefixes are not stable", () => {
  const PREFIXED = `<?xml version="1.0"?>
<ns1:informationTable xmlns:ns1="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <ns1:infoTable>
    <ns1:nameOfIssuer>10X GENOMICS INC</ns1:nameOfIssuer>
    <ns1:titleOfClass>CL A COM</ns1:titleOfClass>
    <ns1:cusip>88025U109</ns1:cusip>
    <ns1:figi>BBG007WX14Y9</ns1:figi>
    <ns1:value>745194</ns1:value>
    <ns1:shrsOrPrnAmt><ns1:sshPrnamt>35101</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt>
    <ns1:investmentDiscretion>SOLE</ns1:investmentDiscretion>
    <ns1:votingAuthority><ns1:Sole>35101</ns1:Sole><ns1:Shared>0</ns1:Shared><ns1:None>0</ns1:None></ns1:votingAuthority>
  </ns1:infoTable>
</ns1:informationTable>`;

  const BARE = `<?xml version="1.0"?>
<informationTable xmlns="http://www.sec.gov/edgar/document/thirteenf/informationtable">
  <infoTable>
    <nameOfIssuer>ABBOTT LABS</nameOfIssuer>
    <titleOfClass>COM</titleOfClass>
    <cusip>002824100</cusip>
    <value>172672</value>
    <shrsOrPrnAmt><sshPrnamt>1700</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt>
    <putCall>Put</putCall>
    <investmentDiscretion>DFND</investmentDiscretion>
    <otherManager>1,2</otherManager>
    <votingAuthority><Sole>0</Sole><Shared>1700</Shared><None>0</None></votingAuthority>
  </infoTable>
</informationTable>`;

  it("parses the ns1:-prefixed shape (Bridgewater)", () => {
    const [r] = parseInfoTable(PREFIXED);
    expect(r.cusip).toBe("88025U109");
    expect(r.figi).toBe("BBG007WX14Y9");
    expect(r.value_raw).toBe(745194);
    expect(r.ssh_prnamt).toBe(35101);
    expect(r.ssh_prnamt_type).toBe("SH");
    expect(r.put_call).toBeNull(); // absent for ordinary long equity
    expect(r.voting_sole).toBe(35101);
  });

  it("parses the default-namespace shape (Citadel)", () => {
    const [r] = parseInfoTable(BARE);
    expect(r.cusip).toBe("002824100");
    expect(r.put_call).toBe("Put");
    // An INDEX STRING into the cover page's otherManagers2Info — not a CIK.
    expect(r.other_manager).toBe("1,2");
    expect(r.voting_shared).toBe(1700);
  });

  it("keeps a leading-zero CUSIP as a string", () => {
    // "002824100" (Abbott) becomes 2824100 the instant it touches a numeric
    // type, and then never joins to anything again.
    const [r] = parseInfoTable(BARE);
    expect(r.cusip).toBe("002824100");
    expect(typeof r.cusip).toBe("string");
  });

  it("handles a single-row table that fast-xml-parser does not array-wrap", () => {
    expect(parseInfoTable(BARE)).toHaveLength(1);
  });
});

describe("parsePrimaryDoc", () => {
  const XML = `<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler">
  <schemaVersion>X0202</schemaVersion>
  <headerData><filerInfo><periodOfReport>03-31-2026</periodOfReport></filerInfo></headerData>
  <formData>
    <coverPage>
      <reportCalendarOrQuarter>03-31-2026</reportCalendarOrQuarter>
      <isAmendment>true</isAmendment>
      <amendmentNo>1</amendmentNo>
      <amendmentInfo><amendmentType>RESTATEMENT</amendmentType></amendmentInfo>
      <filingManager><name>CANTILLON CAPITAL MANAGEMENT LLC</name></filingManager>
      <reportType>13F HOLDINGS REPORT</reportType>
      <form13FFileNumber>028-10729</form13FFileNumber>
    </coverPage>
    <summaryPage>
      <tableEntryTotal>76</tableEntryTotal>
      <tableValueTotal>15050978966</tableValueTotal>
      <isConfidentialOmitted>false</isConfidentialOmitted>
    </summaryPage>
  </formData>
</edgarSubmission>`;

  const c = parsePrimaryDoc(XML);

  it("extracts the units discriminator and the reconciliation total", () => {
    expect(c.schemaVersion).toBe("X0202");
    expect(c.tableValueTotal).toBe(15_050_978_966);
    expect(c.tableEntryTotal).toBe(76);
  });

  it("normalizes MM-DD-YYYY to ISO", () => {
    expect(c.periodOfReport).toBe("2026-03-31");
  });

  it("reads the amendment classification the fold depends on", () => {
    expect(c.isAmendment).toBe(true);
    expect(c.amendmentType).toBe("RESTATEMENT");
    expect(c.amendmentNo).toBe(1);
  });

  it("defaults confDeniedExpired to null when the element is absent", () => {
    // Verified absent on real filings (CenturyLink 2026-Q2) — requiring it
    // would reject valid amendments.
    expect(c.confDeniedExpired).toBeNull();
  });

  it("leaves the cover-page manager list empty when the filing has no such element", () => {
    // The common case by far, and it must stay an empty array rather than
    // undefined: the fund page maps over it.
    expect(c.coverManagers).toEqual([]);
    expect(c.additionalInformation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The notice cover page
// ---------------------------------------------------------------------------
//
// Verbatim from Pershing Square Capital Management's 2026-Q2 notice
// (0001172661-26-003777), reduced to the elements this asserts on.
//
// The shape is the whole point: a 13F-NT has an EMPTY summary page, so the
// summary-page manager list the parser already read comes back empty, and the
// one fact the document exists to state lives on the COVER page instead. Read
// only the first and a notice parses to nothing at all — which is what happened,
// and why the dashboard told a client we had not read a filing we had.
describe("parsePrimaryDoc on a 13F-NT notice", () => {
  const NOTICE = `<?xml version="1.0"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler" xmlns:ns1="http://www.sec.gov/edgar/common">
  <schemaVersion>X0202</schemaVersion>
  <headerData><submissionType>13F-NT</submissionType>
    <filerInfo><periodOfReport>06-30-2026</periodOfReport></filerInfo></headerData>
  <formData>
    <coverPage>
      <reportCalendarOrQuarter>06-30-2026</reportCalendarOrQuarter>
      <isAmendment>false</isAmendment>
      <filingManager><name>Pershing Square Capital Management, L.P.</name></filingManager>
      <reportType>13F NOTICE</reportType>
      <otherManagersInfo>
        <otherManager>
          <cik>0002026053</cik>
          <form13FFileNumber>028-25746</form13FFileNumber>
          <name>PERSHING SQUARE INC.</name>
        </otherManager>
      </otherManagersInfo>
      <additionalInformation>Holdings of this reporting manager are now included in the report of its public parent company.</additionalInformation>
    </coverPage>
    <summaryPage>
      <otherIncludedManagersCount/>
      <tableEntryTotal/>
      <tableValueTotal/>
    </summaryPage>
  </formData>
</edgarSubmission>`;

  const nt = parsePrimaryDoc(NOTICE);

  it("reads the cover-page manager who reports the holdings instead", () => {
    expect(nt.coverManagers).toEqual([
      { cik: "0002026053", fileNumber: "028-25746", name: "PERSHING SQUARE INC." },
    ]);
  });

  it("pads the successor CIK to ten digits, because it is used as an artifact path", () => {
    // `2026053` matches no `fund/0002026053/` key, so an unpadded value would
    // render a button that navigates to a page that does not exist.
    for (const m of nt.coverManagers) expect(m.cik).toMatch(/^\d{10}$/);
  });

  it("keeps the filer's own explanation", () => {
    expect(nt.additionalInformation).toBe(
      "Holdings of this reporting manager are now included in the report of its public parent company.",
    );
  });

  it("still reports an empty summary-page list, which is what a notice has", () => {
    // Guards against 'fixing' this by pointing otherManagers at the cover page:
    // the two lists mean different things and both are needed.
    expect(nt.otherManagers).toEqual([]);
    expect(nt.tableEntryTotal).toBeNull();
  });

});

describe("misc normalizers", () => {
  it("normalizes all three date shapes", () => {
    expect(normalizeDate("03-31-2026")).toBe("2026-03-31");
    expect(normalizeDate("2026-03-31")).toBe("2026-03-31");
    expect(normalizeDate("20260331")).toBe("2026-03-31");
    expect(normalizeDate("")).toBeNull();
  });

  it("strips the XSL viewer prefix from primaryDocument", () => {
    // The submissions API returns a rendering path, not raw XML. Fetching it
    // unmodified returns styled HTML.
    expect(stripXslPrefix("xslForm13F_X02/primary_doc.xml")).toBe("primary_doc.xml");
  });

  it("extracts an accession from an archive path", () => {
    expect(accessionFromPath("edgar/data/1350694/0001350694-26-000002.txt")).toBe("0001350694-26-000002");
  });
});

describe("index files", () => {
  const FORM_IDX = `Description:           Master Index of EDGAR Dissemination Feed
Last Data Received:    May 15, 2026

Form Type   Company Name                                                  CIK         Date Filed  File Name
---------------------------------------------------------------------------------------------------------
13F-HR      KINGDON CAPITAL MANAGEMENT, L.L.C.                            1000097     2026-05-15  edgar/data/1000097/0001000097-26-000005.txt
13F-HR      KINGDON CAPITAL MANAGEMENT, L.L.C.                            1000097     2026-05-15  edgar/data/1000097/0001000097-26-000005.txt
13F-HR/A    SEGALL BRYANT & HAMILL, LLC                                   1006378     2026-05-15  edgar/data/1006378/0001006378-26-000005.txt
13F-NT      CANTILLON CAPITAL MANAGEMENT LLP                              1352269     2026-05-15  edgar/data/1352269/0001352269-26-000002.txt
10-K        SOME OTHER COMPANY INC                                        999999      2026-05-15  edgar/data/999999/0000999999-26-000001.txt
`;

  it("dedupes the byte-identical duplicate rows these files contain", () => {
    // Verified real: Kingdon's 2026-05-15 13F-HR appears twice.
    const rows = parseFormIdx(FORM_IDX);
    expect(rows.filter((r) => r.accession_number === "0001000097-26-000005")).toHaveLength(1);
  });

  it("keeps company names containing spaces and commas intact", () => {
    // The file is FIXED-WIDTH; splitting on whitespace mangles most names.
    const rows = parseFormIdx(FORM_IDX);
    expect(rows[0].company_name).toBe("KINGDON CAPITAL MANAGEMENT, L.L.C.");
    expect(rows[1].company_name).toBe("SEGALL BRYANT & HAMILL, LLC");
  });

  it("keeps all four 13F form types and drops everything else", () => {
    const rows = parseFormIdx(FORM_IDX);
    expect(rows.map((r) => r.form_type)).toEqual(["13F-HR", "13F-HR/A", "13F-NT"]);
    expect(rows.some((r) => r.form_type === "10-K")).toBe(false);
  });

  it("zero-pads the CIK to 10 characters", () => {
    expect(parseFormIdx(FORM_IDX)[0].cik).toBe("0001000097");
  });

  // -------------------------------------------------------------------------
  // THE HEADER EDGAR ACTUALLY SENDS, WHICH WRAPS ONTO TWO LINES.
  //
  // Copied byte for byte from
  // https://www.sec.gov/Archives/edgar/daily-index/2026/QTR3/form.20260814.idx
  // on 2026-08-18. The old parser found its column offsets in "the line above
  // the rule", which here is "      Date Filed  File Name" — no "Company Name",
  // no "CIK" — so offset detection bailed and it returned ZERO ROWS for the
  // whole file. Every fixture it had used a tidy one-line header, so nothing
  // caught it.
  //
  // Note also the trailing padding on each row and the awkward names: a company
  // called "&PARTNERS", one called "10Elms LLP" that starts with digits, and a
  // filing submitted under an AGENT's accession prefix (0000902664-) whose filer
  // is someone else entirely. All three broke a whitespace-splitting parse.
  // -------------------------------------------------------------------------
  const FORM_IDX_LIVE =
    "Description:           Daily Index of EDGAR Dissemination Feed by Form Type\n" +
    "Last Data Received:    Aug 14, 2026\n" +
    "Comments:              webmaster@sec.gov\n" +
    "Anonymous FTP:         ftp://ftp.sec.gov/edgar/\n" +
    " \n \n \n \n" +
    "Form Type   Company Name                                                  CIK\n" +
    "      Date Filed  File Name\n" +
    "-".repeat(141) + "\n" +
    "1-A              Deedflow INC                                                  2143384     20260814    edgar/data/2143384/0001683168-26-006495.txt        \n" +
    "13F-HR           &PARTNERS                                                     107136      20260814    edgar/data/107136/0001214659-26-010148.txt         \n" +
    "13F-HR           10Elms LLP                                                    2056650     20260814    edgar/data/2056650/0002056650-26-000004.txt        \n" +
    "13F-HR           11 Capital Partners LP                                        1801172     20260814    edgar/data/1801172/0000902664-26-003493.txt        \n" +
    "13F-NT           PERSHING SQUARE CAPITAL MANAGEMENT, L.P.                      1336528     20260814    edgar/data/1336528/0001172661-26-003777.txt        \n";

  it("reads the two-line header EDGAR actually sends", () => {
    // The regression. This returned [] against every live file for months, which
    // meant discovery could not have worked even once the 403 handling was right.
    const rows = parseFormIdx(FORM_IDX_LIVE);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.form_type)).toEqual(["13F-HR", "13F-HR", "13F-HR", "13F-NT"]);
  });

  it("does not let trailing padding swallow the company name", () => {
    // Slicing at `line.length - path.length` lands inside the path when the row
    // is space-padded, and hands back the whole row as the name.
    const rows = parseFormIdx(FORM_IDX_LIVE);
    expect(rows.map((r) => r.company_name)).toEqual([
      "&PARTNERS",
      "10Elms LLP",
      "11 Capital Partners LP",
      "PERSHING SQUARE CAPITAL MANAGEMENT, L.P.",
    ]);
    expect(rows.every((r) => !r.company_name.includes("edgar/"))).toBe(true);
  });

  it("takes the FILER's cik from the archive path, not the submitter's from the accession", () => {
    // 11 Capital Partners filed through an agent: the accession begins 0000902664
    // and the filer is 1801172. Deriving the cik from the accession would file a
    // manager's holdings under its lawyer.
    const row = parseFormIdx(FORM_IDX_LIVE).find((r) => r.accession_number === "0000902664-26-003493");
    expect(row.cik).toBe("0001801172");
  });

  it("reads the compact YYYYMMDD filing date the live files use", () => {
    expect(parseFormIdx(FORM_IDX_LIVE)[0].filing_date).toBe("2026-08-14");
    // …and still the dashed form the older fixtures carry.
    expect(parseFormIdx(FORM_IDX)[0].filing_date).toBe("2026-05-15");
  });

  it("parses the pipe-delimited master.idx variant", () => {
    const MASTER = `CIK|Company Name|Form Type|Date Filed|Filename
--------------------------------------------------------------------------------
1000097|KINGDON CAPITAL MANAGEMENT, L.L.C.|13F-HR|2026-05-15|edgar/data/1000097/0001000097-26-000005.txt
1000097|KINGDON CAPITAL MANAGEMENT, L.L.C.|13F-HR|2026-05-15|edgar/data/1000097/0001000097-26-000005.txt
`;
    const rows = parseMasterIdx(MASTER);
    expect(rows).toHaveLength(1);
    expect(rows[0].accession_number).toBe("0001000097-26-000005");
  });
});

describe("normalizeDate — the DERA shape", () => {
  // The bulk data set uses DD-MON-YYYY, a fourth format that appears nowhere
  // else. It silently returned null, which made every period_end null, which
  // made the full-universe loader emit zero funds while otherwise looking like
  // it had worked perfectly.
  it("parses 31-MAR-2026", () => {
    expect(normalizeDate("31-MAR-2026")).toBe("2026-03-31");
    expect(normalizeDate("30-SEP-2025")).toBe("2025-09-30");
    expect(normalizeDate("1-JUN-2026")).toBe("2026-06-01");
  });

  it("still handles the other three shapes", () => {
    expect(normalizeDate("2026-03-31")).toBe("2026-03-31");
    expect(normalizeDate("03-31-2026")).toBe("2026-03-31");
    expect(normalizeDate("20260331")).toBe("2026-03-31");
  });

  it("returns null on an unknown month rather than a wrong date", () => {
    expect(normalizeDate("31-XXX-2026")).toBeNull();
  });
});
