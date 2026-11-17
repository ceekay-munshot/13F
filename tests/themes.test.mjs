// The AI & semis theme: one row for a trade the SEC splits over four sectors.
import { describe, it, expect } from "vitest";
import { inAiTheme } from "../shared/themes.mjs";

describe("inAiTheme", () => {
  it("takes the chips, wherever the SEC filed the rest of the trade", () => {
    expect(inAiTheme("NVDA", "Semiconductors")).toBe(true);
    expect(inAiTheme("SKHY", "Semiconductors")).toBe(true);
    expect(inAiTheme("SNDK", "Computers & Hardware")).toBe(true);
    expect(inAiTheme("NBIS", "Software & IT Services")).toBe(true);
    expect(inAiTheme("VRT", "Electronics & Instruments")).toBe(true);
  });
  it("leaves out solar and contract manufacturers filed as semiconductors", () => {
    expect(inAiTheme("FSLR", "Semiconductors")).toBe(false);
    expect(inAiTheme("JBL", "Semiconductors")).toBe(false);
  });
  it("leaves out everything else", () => {
    expect(inAiTheme("AAPL", "Computers & Hardware")).toBe(false);
    expect(inAiTheme("MSFT", "Software & IT Services")).toBe(false);
  });
});
