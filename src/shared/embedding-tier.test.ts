import { describe, expect, it } from "vitest";
import {
  CLOUD_SPACE,
  LOCAL_SPACE,
  parseCloudResponse,
  spaceFor,
} from "./embedding-tier";

describe("spaceFor", () => {
  it("maps local settings to the MiniLM space", () => {
    expect(spaceFor({ tier: "local" })).toBe(LOCAL_SPACE);
  });

  it("maps cloud settings to the Titan space", () => {
    expect(spaceFor({ tier: "cloud", endpoint: "https://x/embed", apiKey: "k" })).toBe(CLOUD_SPACE);
  });

  it("keeps the two spaces distinct on every stamped field", () => {
    expect(LOCAL_SPACE.modelId).not.toBe(CLOUD_SPACE.modelId);
    expect(LOCAL_SPACE.revision).not.toBe(CLOUD_SPACE.revision);
    expect(LOCAL_SPACE.dims).not.toBe(CLOUD_SPACE.dims);
  });
});

describe("parseCloudResponse", () => {
  const vec = (fill: number) => Array.from({ length: CLOUD_SPACE.dims }, () => fill);
  const good = {
    vectors: [vec(0.1), vec(0.2)],
    dims: CLOUD_SPACE.dims,
    model: CLOUD_SPACE.modelId,
  };

  it("flattens a valid response row-major", () => {
    const out = parseCloudResponse(good, CLOUD_SPACE, 2);
    expect(out.length).toBe(2 * CLOUD_SPACE.dims);
    expect(out[0]).toBeCloseTo(0.1);
    expect(out[CLOUD_SPACE.dims]).toBeCloseTo(0.2);
  });

  it("rejects a wrong model — vectors from another space must never load", () => {
    expect(() =>
      parseCloudResponse({ ...good, model: "someone-elses-model" }, CLOUD_SPACE, 2),
    ).toThrow(/model mismatch/);
  });

  it("rejects wrong dims", () => {
    expect(() => parseCloudResponse({ ...good, dims: 384 }, CLOUD_SPACE, 2)).toThrow(
      /dims mismatch/,
    );
  });

  it("rejects a count mismatch", () => {
    expect(() => parseCloudResponse(good, CLOUD_SPACE, 3)).toThrow(/2 vectors for 3 texts/);
  });

  it("rejects a ragged vector", () => {
    const ragged = { ...good, vectors: [vec(0.1), vec(0.2).slice(0, 10)] };
    expect(() => parseCloudResponse(ragged, CLOUD_SPACE, 2)).toThrow(/vector 1 has 10 dims/);
  });

  it("rejects a malformed payload", () => {
    expect(() => parseCloudResponse({ error: "throttled" }, CLOUD_SPACE, 1)).toThrow(
      /not \{ vectors, dims, model \}/,
    );
  });
});
