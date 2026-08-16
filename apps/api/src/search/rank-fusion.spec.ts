import { interleavePreferredResults, weightedReciprocalRankFusion } from "./rank-fusion";

describe("weightedReciprocalRankFusion", () => {
  it("rewards candidates supported by multiple differently-scaled branches", () => {
    const fused = weightedReciprocalRankFusion([
      { source: "semantic", weight: 0.7, hits: [{ id: "semantic-only" }, { id: "shared" }] },
      { source: "visual_text", weight: 0.5, hits: [{ id: "shared" }, { id: "visual-only" }] },
    ], (hit) => hit.id);
    expect(fused.map(({ hit }) => hit.id)).toEqual(["shared", "semantic-only", "visual-only"]);
    expect(fused[0]?.matchSources).toEqual(["semantic", "visual_text"]);
    expect(fused[0]?.primaryMatchSource).toBe("semantic");
  });

  it("uses branch rank rather than raw model scores", () => {
    const fused = weightedReciprocalRankFusion([
      { source: "keyword", weight: 1, hits: [{ id: "a", raw: 0.01 }, { id: "b", raw: 0.99 }] },
    ], (hit) => hit.id);
    expect(fused.map(({ hit }) => hit.id)).toEqual(["a", "b"]);
  });
});

describe("interleavePreferredResults", () => {
  it("keeps preferred matches first while reserving a small fallback lane", () => {
    const preferred = Array.from({ length: 8 }, (_, index) => ({ id: `p${index + 1}` }));
    const fallback = [{ id: "p1" }, { id: "f1" }, { id: "f2" }];
    expect(interleavePreferredResults(preferred, fallback, (item) => item.id).map((item) => item.id)).toEqual([
      "p1", "p2", "p3", "p4", "p5", "p6", "f1", "p7", "p8", "f2",
    ]);
  });
});
