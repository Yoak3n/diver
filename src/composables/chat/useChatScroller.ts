// 聊天滚动控制器（composables/chat）：贴底跟随、首屏贴底、前插滚动锚定、
// 懒加载触发、消息时间线（当前位置追踪 + 按消息跳转）。
// DOM 读写集中在传入的 scrollEl 上；几何计算在 src/scroll.ts（纯函数）。
// 状态 / UI / 逻辑分文件约定见 AGENTS.md。

import { nextTick, ref, watch, type Ref } from "vue";
import { isNearBottom, topWithin } from "../../scroll";

export function createChatScroller(opts: {
  scrollEl: Ref<HTMLElement | null>;
  /** 消息条数（响应式取值） */
  count: () => number;
  /** 池内最旧一条消息 id（响应式取值） */
  firstId: () => string | undefined;
  hasMore: () => boolean;
  loadingOlder: () => boolean;
  /** 请求加载更早消息（由视图层接到会话池的 loadOlder） */
  requestOlder: () => void;
}) {
  const stickToBottom = ref(true);
  /** 视口顶部当前消息 id（时间线刻度高亮用）。 */
  const currentMid = ref<string | null>(null);
  /** 懒加载触发节流：滚动事件连发时不重复请求。 */
  let olderRequestedAt = 0;
  let currentScheduled = false;

  /** 找视口顶部压着（或其上方最近）的「真人消息行」，记为当前阅读位置。
   *  锚点只认真人发言（origin=user）：工具 / 思考 / 摘要 / 他方实例发言都不是锚点。 */
  function updateCurrent() {
    currentScheduled = false;
    const el = opts.scrollEl.value;
    if (!el) return;
    const rows = el.querySelectorAll<HTMLElement>('.msg-row.user[data-mid][data-origin="user"]');
    if (rows.length === 0) {
      currentMid.value = null;
      return;
    }
    let at = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if (topWithin(el, rows[i]) <= el.scrollTop + 12) at = i;
      else break;
    }
    currentMid.value = rows[at].dataset.mid ?? null;
  }

  function scheduleCurrent() {
    if (currentScheduled) return;
    currentScheduled = true;
    requestAnimationFrame(updateCurrent);
  }

  function onScroll() {
    const el = opts.scrollEl.value;
    if (!el) return;
    stickToBottom.value = isNearBottom(el.scrollTop, el.scrollHeight, el.clientHeight);
    scheduleCurrent();
    // 顶到头自动懒加载更早消息
    if (
      el.scrollTop <= 48 &&
      opts.hasMore() &&
      !opts.loadingOlder() &&
      Date.now() - olderRequestedAt > 1200
    ) {
      olderRequestedAt = Date.now();
      opts.requestOlder();
    }
  }

  /** 时间线点击跳转：滚动到指定消息行顶部。 */
  function jumpToMessage(id: string) {
    const el = opts.scrollEl.value;
    if (!el) return;
    const row = el.querySelector<HTMLElement>(`[data-mid="${CSS.escape(id)}"]`);
    if (!row) return;
    el.scrollTo({ top: Math.max(0, topWithin(el, row) - 8), behavior: "smooth" });
  }

  /** force：按钮点击 / 需要贴底的场景；默认仅贴近底部时跟随。 */
  function scrollToBottom(force = false) {
    nextTick(() => {
      const el = opts.scrollEl.value;
      if (!el) return;
      if (!force && !stickToBottom.value) return;
      el.scrollTop = el.scrollHeight;
      stickToBottom.value = true;
    });
  }

  // 首屏（空池 → 首批消息）：强制贴底 + 下一帧复贴（markdown/图片撑高后仍准）。
  // immediate：重挂载（视图切换）时池可能已非空，同样要贴底，不能只靠 0→N 变化。
  watch(
    () => opts.count(),
    (n, old) => {
      if (n === 0) return;
      if (old !== undefined && old !== 0) return;
      nextTick(() => {
        const el = opts.scrollEl.value;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        requestAnimationFrame(() => {
          el.scrollTop = el.scrollHeight;
        });
        scheduleCurrent();
      });
    },
    { immediate: true },
  );

  // 前插锚定：更早消息并入池后按高度差补偿 scrollTop，视口不跳屏
  watch(
    opts.firstId,
    async (_next, prev) => {
      // 空池首拉不算前插，交给首屏贴底
      if (prev === undefined) return;
      const el = opts.scrollEl.value;
      if (!el) return;
      const prevHeight = el.scrollHeight;
      await nextTick();
      if (!el.isConnected) return;
      const grew = el.scrollHeight - prevHeight;
      if (grew > 0) {
        el.scrollTop += grew;
        scheduleCurrent();
      }
    },
  );

  return { stickToBottom, currentMid, onScroll, scrollToBottom, jumpToMessage };
}
