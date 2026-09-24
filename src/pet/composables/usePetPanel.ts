// 消息面板开关 + 面板朝向（朝屏幕中心）+ 附件。

import { ref } from "vue";
import { tauriAvailable } from "../../tauri";
import {
  filesToAttachments,
  imageFilesFromClipboard,
  imageFilesFromDataTransfer,
} from "../../imageAttach";
import type { ComposerAttachment } from "../../types";

export function usePetPanel(opts: {
  onSideChange: (side: "left" | "right") => void;
  onPanelToggle: (open: boolean) => void;
  afterOpen: () => void;
}) {
  const panelOpen = ref(false);
  const bubbleSide = ref<"left" | "right">("right");
  const panelDragOver = ref(false);
  const moreMenuOpen = ref(false);
  const panelInput = ref<HTMLInputElement | null>(null);
  const attachFileInput = ref<HTMLInputElement | null>(null);
  const chatMessagesRef = ref<HTMLElement | null>(null);

  let bubbleSideTimer: number | null = null;

  async function updateBubbleSide() {
    try {
      let winLeft = 0;
      let winWidth = window.innerWidth;
      if (tauriAvailable()) {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const [pos, size] = await Promise.all([
          getCurrentWindow().outerPosition(),
          getCurrentWindow().outerSize(),
        ]);
        winLeft = pos.x;
        winWidth = size.width;
      } else {
        winLeft = window.screenX || 0;
        winWidth = window.outerWidth || winWidth;
      }
      const screenLeft = (window.screen as unknown as { availLeft?: number }).availLeft ?? 0;
      const screenWidth = window.screen.availWidth || 1920;
      const winCenter = winLeft + winWidth / 2;
      const screenCenter = screenLeft + screenWidth / 2;
      const next = winCenter < screenCenter ? "right" : "left";
      if (next !== bubbleSide.value) {
        bubbleSide.value = next;
        opts.onSideChange(next);
      }
    } catch {
      bubbleSide.value = "right";
      opts.onSideChange("right");
    }
  }

  function scrollChatToBottom() {
    const el = chatMessagesRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  }

  function openPanel() {
    void updateBubbleSide().then(() => {
      panelOpen.value = true;
      opts.onPanelToggle(true);
      void (async () => {
        // 呼出前先清气泡由调用方处理；这里滚动 + 聚焦
        opts.afterOpen();
      })();
    });
  }

  function closePanel() {
    panelOpen.value = false;
    opts.onPanelToggle(false);
  }

  function toggleMoreMenu() {
    moreMenuOpen.value = !moreMenuOpen.value;
    if (moreMenuOpen.value) {
      // modelPicker 由上层管理
    }
  }

  function closePanelFromMenu() {
    moreMenuOpen.value = false;
    closePanel();
  }

  async function onAddAttachFiles(
    files: File[],
    addAttachments: (items: ComposerAttachment[]) => void,
  ) {
    const items = await filesToAttachments(files);
    if (items.length) addAttachments(items);
  }

  function pickAttachImages() {
    attachFileInput.value?.click();
  }

  function onAttachFileInput(e: Event, addAttachments: (items: ComposerAttachment[]) => void) {
    const input = e.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length) void onAddAttachFiles(files, addAttachments);
  }

  function onPanelPaste(e: ClipboardEvent, addAttachments: (items: ComposerAttachment[]) => void) {
    const files = imageFilesFromClipboard(e);
    if (files.length) {
      e.preventDefault();
      void onAddAttachFiles(files, addAttachments);
    }
  }

  function onPanelDragOver(e: DragEvent) {
    if (e.dataTransfer?.types.includes("Files")) {
      e.preventDefault();
      panelDragOver.value = true;
    }
  }

  function onPanelDrop(e: DragEvent, addAttachments: (items: ComposerAttachment[]) => void) {
    panelDragOver.value = false;
    const files = imageFilesFromDataTransfer(e.dataTransfer);
    if (files.length) {
      e.preventDefault();
      void onAddAttachFiles(files, addAttachments);
    }
  }

  function startSideTimer() {
    bubbleSideTimer = window.setInterval(() => void updateBubbleSide(), 3000);
  }

  function dispose() {
    if (bubbleSideTimer !== null) window.clearInterval(bubbleSideTimer);
    bubbleSideTimer = null;
  }

  return {
    panelOpen,
    bubbleSide,
    panelDragOver,
    moreMenuOpen,
    panelInput,
    attachFileInput,
    chatMessagesRef,
    updateBubbleSide,
    scrollChatToBottom,
    openPanel,
    closePanel,
    toggleMoreMenu,
    closePanelFromMenu,
    pickAttachImages,
    onAttachFileInput,
    onPanelPaste,
    onPanelDragOver,
    onPanelDrop,
    startSideTimer,
    dispose,
  };
}
