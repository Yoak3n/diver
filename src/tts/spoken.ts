// 自动朗读去重（同一文本/消息在 TTL 内只读一遍）。

const spokenMarks = new Map<string, number>();
const SPOKEN_TTL_MS = 60_000;

export function claimSpeech(_messageId: string | undefined, text: string): boolean {
  const key = `text:${text.replace(/\s+/g, " ").trim().slice(0, 300)}`;
  const now = Date.now();
  for (const [k, t] of spokenMarks) {
    if (now - t > SPOKEN_TTL_MS) spokenMarks.delete(k);
  }
  const prev = spokenMarks.get(key);
  if (prev && now - prev < SPOKEN_TTL_MS) return false;
  spokenMarks.set(key, now);
  return true;
}
