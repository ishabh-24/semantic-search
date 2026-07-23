import { describe, expect, it } from "vitest";
import { diffChunks } from "./chunk-diff";

const vec = (x: number) => Float32Array.of(x);

describe("diffChunks", () => {
  it("reuses vectors for unchanged chunks and flags only the changed one", () => {
    const existing = new Map([
      ["intro paragraph", vec(1)],
      ["body paragraph", vec(2)],
      ["closing paragraph", vec(3)],
    ]);
    // Middle paragraph edited; the other two are identical.
    const plan = diffChunks(["intro paragraph", "body paragraph EDITED", "closing paragraph"], existing);
    expect(plan.reuseCount).toBe(2);
    expect(plan.embedCount).toBe(1);
    expect(plan.reuse[0]).toBe(existing.get("intro paragraph"));
    expect(plan.reuse[1]).toBeNull(); // the edited chunk must be re-embedded
    expect(plan.reuse[2]).toBe(existing.get("closing paragraph"));
  });

  it("reuses unchanged chunks even when their position shifts", () => {
    const existing = new Map([
      ["alpha", vec(1)],
      ["beta", vec(2)],
    ]);
    // A new chunk is inserted at the top; alpha/beta shift down but are unchanged.
    const plan = diffChunks(["brand new intro", "alpha", "beta"], existing);
    expect(plan.embedCount).toBe(1); // only the inserted chunk
    expect(plan.reuse[0]).toBeNull();
    expect(plan.reuse[1]).toBe(existing.get("alpha"));
    expect(plan.reuse[2]).toBe(existing.get("beta"));
  });

  it("embeds everything for a brand-new doc (no existing chunks)", () => {
    const plan = diffChunks(["a", "b"], new Map());
    expect(plan.reuseCount).toBe(0);
    expect(plan.embedCount).toBe(2);
  });

  it("reuses everything when nothing changed", () => {
    const existing = new Map([
      ["a", vec(1)],
      ["b", vec(2)],
    ]);
    const plan = diffChunks(["a", "b"], existing);
    expect(plan.reuseCount).toBe(2);
    expect(plan.embedCount).toBe(0);
  });
});
