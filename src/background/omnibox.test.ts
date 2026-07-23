import { describe, expect, it } from "vitest";
import { docUrl, xmlEscape, formatSuggestion } from "./omnibox";
import type { DocHit } from "../shared/worker-protocol";

const hit = (over: Partial<DocHit> = {}): DocHit => ({
  docId: "abc123",
  docName: "Q3 Plan",
  breadcrumbs: ["Budget", "Headcount"],
  snippet: "We plan to hire four engineers.",
  score: 0.5,
  chunkId: "abc123:0",
  ...over,
});

describe("docUrl", () => {
  it("builds the Google Docs deep link", () => {
    expect(docUrl("abc123")).toBe("https://docs.google.com/document/d/abc123/edit");
  });
});

describe("xmlEscape", () => {
  it("escapes the XML-significant characters", () => {
    expect(xmlEscape(`A & B <x> "q" 'z'`)).toBe("A &amp; B &lt;x&gt; &quot;q&quot; &apos;z&apos;");
  });
});

describe("formatSuggestion", () => {
  it("uses the doc URL as content and marks up name + breadcrumb/snippet", () => {
    const s = formatSuggestion(hit());
    expect(s.content).toBe("https://docs.google.com/document/d/abc123/edit");
    expect(s.description).toContain("<match>Q3 Plan</match>");
    expect(s.description).toContain("Budget › Headcount — ");
  });

  it("escapes dynamic text so a stray & doesn't break the markup", () => {
    const s = formatSuggestion(hit({ docName: "R&D <notes>", snippet: "a & b" }));
    expect(s.description).toContain("<match>R&amp;D &lt;notes&gt;</match>");
    expect(s.description).not.toContain("R&D"); // raw ampersand must not survive
  });

  it("omits the separator when there are no breadcrumbs", () => {
    const s = formatSuggestion(hit({ breadcrumbs: [] }));
    expect(s.description).not.toContain(" — ");
  });
});
