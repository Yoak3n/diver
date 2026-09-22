// LLM 消息 Markdown：主窗口/桌宠面板渲染 HTML，气泡与 TTS 抽纯文本。
// 同一棵 token 树双端复用，避免正则剥标记误杀字面量。

import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
});

/** Markdown → 消息面板用的安全 HTML（禁原始标签 + DOMPurify 兜底）。 */
export function renderMarkdownHtml(src: string): string {
  if (!src) return "";
  return DOMPurify.sanitize(md.render(src));
}

function pushBreak(parts: string[]): void {
  const last = parts[parts.length - 1];
  if (last !== undefined && !last.endsWith("\n")) parts.push("\n");
}

/** token 树 → 纯文本：保留段落/换行与代码内容，丢掉标记符。 */
type MdTokens = ReturnType<typeof md.parse>;

function tokensToPlainText(tokens: MdTokens): string {
  const parts: string[] = [];

  const walk = (list: MdTokens): void => {
    for (const t of list) {
      switch (t.type) {
        case "text":
        case "code_inline":
          parts.push(t.content);
          break;
        case "softbreak":
        case "hardbreak":
          parts.push("\n");
          break;
        case "fence":
        case "code_block":
          pushBreak(parts);
          parts.push(t.content.endsWith("\n") ? t.content : `${t.content}\n`);
          break;
        case "paragraph_close":
        case "heading_close":
        case "blockquote_close":
        case "bullet_list_close":
        case "ordered_list_close":
          pushBreak(parts);
          parts.push("\n");
          break;
        case "list_item_open":
          pushBreak(parts);
          parts.push("· ");
          break;
        case "inline":
          if (t.children) walk(t.children);
          break;
        default:
          break;
      }
    }
  };

  walk(tokens);
  return parts
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown → 气泡/朗读用纯文本（AST 抽取，不误杀 `2*3`、snake_case 等字面量）。 */
export function markdownToPlainText(src: string): string {
  if (!src) return "";
  return tokensToPlainText(md.parse(src, {}));
}
