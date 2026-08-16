export interface RankedBranch<THit> {
  source: string;
  weight: number;
  hits: readonly THit[];
}

export interface FusedHit<THit> {
  hit: THit;
  score: number;
  matchSources: string[];
  primaryMatchSource: string;
}

interface Aggregate<THit> {
  hit: THit;
  score: number;
  bestContribution: number;
  sourceScores: Map<string, number>;
  firstSeen: number;
}

export function weightedReciprocalRankFusion<THit>(
  branches: readonly RankedBranch<THit>[],
  keyOf: (hit: THit) => string,
  rankConstant = 60,
): FusedHit<THit>[] {
  const aggregates = new Map<string, Aggregate<THit>>();
  let firstSeen = 0;
  for (const branch of branches) {
    branch.hits.forEach((hit, index) => {
      const contribution = branch.weight / (rankConstant + index + 1);
      const key = keyOf(hit);
      const aggregate = aggregates.get(key) ?? {
        hit, score: 0, bestContribution: -Infinity, sourceScores: new Map<string, number>(), firstSeen: firstSeen++,
      };
      aggregate.score += contribution;
      aggregate.sourceScores.set(branch.source, (aggregate.sourceScores.get(branch.source) ?? 0) + contribution);
      if (contribution > aggregate.bestContribution) {
        aggregate.hit = hit;
        aggregate.bestContribution = contribution;
      }
      aggregates.set(key, aggregate);
    });
  }
  return [...aggregates.values()]
    .sort((a, b) => b.score - a.score || a.firstSeen - b.firstSeen)
    .map((aggregate) => {
      const sources = [...aggregate.sourceScores.entries()].sort((a, b) => b[1] - a[1]);
      return {
        hit: aggregate.hit,
        score: aggregate.score,
        matchSources: sources.map(([source]) => source),
        primaryMatchSource: sources[0]?.[0] ?? "keyword",
      };
    });
}

export function interleavePreferredResults<TResult>(
  preferred: readonly TResult[],
  fallback: readonly TResult[],
  keyOf: (result: TResult) => string,
  preferredPerFallback = 6,
): TResult[] {
  const output: TResult[] = [];
  const seen = new Set<string>();
  let preferredIndex = 0;
  let fallbackIndex = 0;
  const take = (source: readonly TResult[], index: number): number => {
    while (index < source.length && seen.has(keyOf(source[index]!))) index++;
    if (index < source.length) {
      const result = source[index]!;
      output.push(result);
      seen.add(keyOf(result));
      index++;
    }
    return index;
  };
  while (preferredIndex < preferred.length || fallbackIndex < fallback.length) {
    for (let count = 0; count < preferredPerFallback && preferredIndex < preferred.length; count++) {
      preferredIndex = take(preferred, preferredIndex);
    }
    if (fallbackIndex < fallback.length) fallbackIndex = take(fallback, fallbackIndex);
    if (preferredIndex >= preferred.length) {
      while (fallbackIndex < fallback.length) fallbackIndex = take(fallback, fallbackIndex);
    }
  }
  return output;
}
