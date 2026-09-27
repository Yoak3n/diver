// 用户消息回声判定（本地回显 vs 服务端回传）。
// 纯图片消息双方正文可能不同：本地回显为空文，服务端会把正文替换成占位
// 「（图片）」（见 cos-plugins/backend routes/chat.ts，占位是给模型的上下文）——
// 去重与渲染都需要识别这一形态，避免同一条消息渲染两条气泡。

import type { ChatImage } from "../../types";

/** backend /api/chat 对纯图片消息的正文占位（与模型上下文一致）。 */
export const IMAGE_PLACEHOLDER = "（图片）";

/** 是否「纯图片」形态：带图且正文为空或仅占位。 */
export function isImagePlaceholder(msg: { content: string; images?: ChatImage[] }): boolean {
  return (msg.images?.length ?? 0) > 0 && (msg.content === "" || msg.content === IMAGE_PLACEHOLDER);
}

/** 同一条用户消息：正文全等，或双方都是纯图片形态（调用方另行比对图数与时间窗）。 */
export function sameUserEcho(
  a: { content: string; images?: ChatImage[] },
  b: { content: string; images?: ChatImage[] },
): boolean {
  if (a.content === b.content) return true;
  return isImagePlaceholder(a) && isImagePlaceholder(b);
}
