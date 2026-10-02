// 自动朗读去重（同一文本/消息在 TTL 内只读一遍）。

const spokenMarks = new Map<string, number>();
const SPOKEN_TTL_MS = 60_000;

export function claimSpeech(messageId: string | undefined, text: string): boolean {
  // 按消息身份去重：同一消息的重复完成事件只读一遍；
  // 不同消息即使文本相同也各自朗读（「生成后自动朗读」逐条读）。无 id 时回退文本键。
  const key = messageId
    ? `msg:${messageId}`
    : `text:${text.replace(/\s+/g, " ").trim().slice(0, 300)}`;
  const now = Date.now();
  for (const [k, t] of spokenMarks) {
    if (now - t > SPOKEN_TTL_MS) spokenMarks.delete(k);
  }
  const prev = spokenMarks.get(key);
  if (prev && now - prev < SPOKEN_TTL_MS) return false;
  spokenMarks.set(key, now);
  return true;
}
