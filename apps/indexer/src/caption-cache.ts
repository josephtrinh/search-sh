export function captionCacheKey(
  task: string,
  maxNewTokens: number,
  numBeams: number,
): string {
  return JSON.stringify({ task, maxNewTokens, numBeams });
}
