export function captionCacheKey(
  task: string,
  maxNewTokens: number,
  numBeams: number,
): string {
  return JSON.stringify({ task, maxNewTokens, numBeams });
}

export function qwenCaptionCacheKey(
  promptVersion: string,
  maxTokens: number,
  seed: number,
  mmprojSha256: string,
  promptSha256: string,
): string {
  return JSON.stringify({
    promptVersion,
    maxTokens,
    seed,
    mmprojSha256,
    promptSha256,
    temperature: 0,
    reasoning: false,
    userPrompt: "qwen-user-prompt-v2",
    normalizer: "qwen-caption-v2",
  });
}
