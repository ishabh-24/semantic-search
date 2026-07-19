import { describe, expect, it } from "vitest";
import { chunkDoc, DEFAULT_CHUNK_OPTIONS, type Chunk } from "./chunker";

const DOC = { id: "doc-1", name: "Q3 Planning" };

function texts(chunks: Chunk[]): string[] {
  return chunks.map((c) => c.text);
}

describe("breadcrumbs", () => {
  it("builds the nested heading path", () => {
    const md = [
      "# Q3 Planning",
      "Top-level intro paragraph.",
      "## Budget",
      "Budget overview paragraph.",
      "### Headcount",
      "We plan to hire four engineers.",
    ].join("\n\n");

    const chunks = chunkDoc(DOC, md);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]!.breadcrumbs).toEqual(["Q3 Planning"]);
    expect(chunks[1]!.breadcrumbs).toEqual(["Q3 Planning", "Budget"]);
    expect(chunks[2]!.breadcrumbs).toEqual(["Q3 Planning", "Budget", "Headcount"]);
    expect(chunks[2]!.breadcrumbs.join(" › ")).toBe("Q3 Planning › Budget › Headcount");
  });

  it("pops the stack when a sibling heading appears", () => {
    const md = [
      "# Q3 Planning",
      "## Budget",
      "### Headcount",
      "Hiring text.",
      "## Marketing", // back up two levels
      "Campaign text.",
    ].join("\n\n");

    const chunks = chunkDoc(DOC, md);
    expect(chunks.at(-1)!.breadcrumbs).toEqual(["Q3 Planning", "Marketing"]);
  });

  it("skips a heading level without duplicating ancestors", () => {
    const md = ["# Top", "### Deep", "Deep content."].join("\n\n");
    expect(chunkDoc(DOC, md)[0]!.breadcrumbs).toEqual(["Top", "Deep"]);
  });

  it("strips inline markdown from headings", () => {
    const md = ["## **Bold** and [linked](https://x.test) title", "Body."].join("\n\n");
    expect(chunkDoc(DOC, md)[0]!.breadcrumbs).toEqual(["Bold and linked title"]);
  });

  it("uses empty breadcrumbs for preamble before any heading", () => {
    const md = "Preamble paragraph.\n\n# First\n\nSection body.";
    const chunks = chunkDoc(DOC, md);
    expect(chunks[0]!.breadcrumbs).toEqual([]);
    expect(chunks[1]!.breadcrumbs).toEqual(["First"]);
  });

  it("treats # lines inside code fences as content, not headings", () => {
    const md = ["# Real", "```", "# not a heading", "code();", "```", "After code."].join("\n");
    const chunks = chunkDoc(DOC, md);
    expect(chunks.every((c) => c.breadcrumbs.join() === "Real")).toBe(true);
    expect(chunks[0]!.text).toContain("# not a heading");
  });
});

describe("packing and splitting", () => {
  it("merges short paragraphs into one chunk", () => {
    const md = ["# S", "One.", "Two.", "Three."].join("\n\n");
    const chunks = chunkDoc(DOC, md);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("One.\n\nTwo.\n\nThree.");
  });

  it("splits a long section and keeps every chunk under maxChars", () => {
    const sentence = "This is a filler sentence about quarterly planning topics. ";
    const md = `# Long\n\n${sentence.repeat(80).trim()}`; // ~4800 chars
    const chunks = chunkDoc(DOC, md);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxChars);
      expect(chunk.breadcrumbs).toEqual(["Long"]);
    }
  });

  it("overlaps consecutive chunks within a section by the previous tail", () => {
    const sentences = Array.from(
      { length: 40 },
      (_, i) => `Sentence number ${i} discusses the planning cycle.`,
    );
    const md = `# S\n\n${sentences.join(" ")}`;
    const chunks = chunkDoc(DOC, md);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i++) {
      // Each chunk after the first starts with a sentence from the previous chunk.
      const firstSentence = chunks[i]!.text.split(".")[0] + ".";
      expect(chunks[i - 1]!.text).toContain(firstSentence);
    }
  });

  it("does not overlap across heading boundaries", () => {
    const md = ["# A", "Alpha section text.", "# B", "Beta section text."].join("\n\n");
    const chunks = chunkDoc(DOC, md);
    expect(texts(chunks)).toEqual(["Alpha section text.", "Beta section text."]);
  });

  it("hard-splits a single sentence longer than maxChars", () => {
    const md = `# S\n\n${"word ".repeat(500).trim()}`; // one 2500-char "sentence"
    const chunks = chunkDoc(DOC, md);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(DEFAULT_CHUNK_OPTIONS.maxChars);
    }
  });
});

describe("shape", () => {
  it("returns no chunks for empty or heading-only docs", () => {
    expect(chunkDoc(DOC, "")).toEqual([]);
    expect(chunkDoc(DOC, "# Just a heading\n\n## Another")).toEqual([]);
  });

  it("assigns stable sequential ids", () => {
    const md = ["# A", "One.", "# B", "Two."].join("\n\n");
    const chunks = chunkDoc(DOC, md);
    expect(chunks.map((c) => c.id)).toEqual(["doc-1:0", "doc-1:1"]);
    expect(chunks.map((c) => c.seq)).toEqual([0, 1]);
    expect(chunks.every((c) => c.docId === "doc-1")).toBe(true);
  });

  it("handles CRLF line endings", () => {
    const md = "# Title\r\n\r\nWindows paragraph.";
    const chunks = chunkDoc(DOC, md);
    expect(chunks[0]!.breadcrumbs).toEqual(["Title"]);
    expect(chunks[0]!.text).toBe("Windows paragraph.");
  });
});
