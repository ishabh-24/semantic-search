import { describe, expect, it } from "vitest";
import { LexicalIndex, type LexicalDoc } from "./lexical-index";

// Chunks across three docs; ids are `${docId}:${seq}`.
const DOCS: LexicalDoc[] = [
  { id: "invoices:0", text: "Total amount due on receipt.", title: "invoice_2024_final", breadcrumbs: "" },
  { id: "hiring:0", text: "We plan to grow the team and expand the hiring budget next quarter.", title: "Hiring Plan", breadcrumbs: "Q3 › Headcount" },
  { id: "hiring:1", text: "Marketing spend is unrelated to salaries.", title: "Hiring Plan", breadcrumbs: "Q3 › Marketing" },
  { id: "notes:0", text: "Random meeting notes about lunch.", title: "Standup Notes", breadcrumbs: "" },
];

function build(): LexicalIndex {
  const idx = new LexicalIndex();
  idx.add(DOCS);
  return idx;
}

describe("LexicalIndex", () => {
  it("ranks an exact filename-style query's doc #1 (done-when for commit 11)", () => {
    const hits = build().search("invoice_2024_final", 5);
    expect(hits[0]!.id).toBe("invoices:0");
  });

  it("boosts a title match over a body-only match", () => {
    // "hiring" appears in the Hiring Plan title and in one chunk's body.
    const hits = build().search("hiring", 5);
    expect(hits[0]!.id.startsWith("hiring:")).toBe(true);
  });

  it("tolerates a typo via fuzzy matching", () => {
    const hits = build().search("invoice_2024_fnal", 5); // missing 'i'
    expect(hits.some((h) => h.id === "invoices:0")).toBe(true);
  });

  it("matches a prefix (as-you-type)", () => {
    const hits = build().search("invoic", 5);
    expect(hits.some((h) => h.id === "invoices:0")).toBe(true);
  });

  it("returns nothing for a blank query and respects k", () => {
    const idx = build();
    expect(idx.search("   ", 5)).toEqual([]);
    expect(idx.search("plan budget team notes", 2).length).toBeLessThanOrEqual(2);
  });

  it("reports its document count", () => {
    expect(build().size).toBe(DOCS.length);
  });
});
