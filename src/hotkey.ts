// KeyboardEvent → tauri-plugin-global-shortcut / global-hotkey accelerator 字符串。
//
// 词法与 global-hotkey 0.8 的 parse_hotkey / parse_key 严格对齐：
//   - 修饰键在前、单个主键在后，用 `+` 连接
//   - 修饰：ctrl/control, shift, alt/option, super/cmd/command, cmdorctrl/…
//   - 主键：parse_key 接受的 token（大小写不敏感）
//
// 捕获使用 event.code（物理键位）而非 event.key（字符），避免 Shift+1
// 被收成 `shift+!` 这类 parse_key 不认识的 token。

/** KeyboardEvent.code → parse_key 接受的主键 token（小写）。 */
const CODE_TO_KEY: Record<string, string> = {
  Backquote: "backquote",
  Backslash: "backslash",
  BracketLeft: "bracketleft",
  BracketRight: "bracketright",
  Comma: "comma",
  Equal: "equal",
  Minus: "minus",
  Period: "period",
  Quote: "quote",
  Semicolon: "semicolon",
  Slash: "slash",
  Backspace: "backspace",
  CapsLock: "capslock",
  Enter: "enter",
  Space: "space",
  Tab: "tab",
  Delete: "delete",
  End: "end",
  Home: "home",
  Insert: "insert",
  PageDown: "pagedown",
  PageUp: "pageup",
  PrintScreen: "printscreen",
  ScrollLock: "scrolllock",
  ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  ArrowUp: "arrowup",
  NumLock: "numlock",
  Numpad0: "numpad0",
  Numpad1: "numpad1",
  Numpad2: "numpad2",
  Numpad3: "numpad3",
  Numpad4: "numpad4",
  Numpad5: "numpad5",
  Numpad6: "numpad6",
  Numpad7: "numpad7",
  Numpad8: "numpad8",
  Numpad9: "numpad9",
  NumpadAdd: "numpadadd",
  NumpadDecimal: "numpaddecimal",
  NumpadDivide: "numpaddivide",
  NumpadEnter: "numpadenter",
  NumpadEqual: "numpadequal",
  NumpadMultiply: "numpadmultiply",
  NumpadSubtract: "numpadsubtract",
  Escape: "escape",
  Pause: "pause",
  AudioVolumeDown: "audiovolumedown",
  AudioVolumeUp: "audiovolumeup",
  AudioVolumeMute: "audiovolumemute",
  MediaPlay: "mediaplay",
  MediaPause: "mediapause",
  MediaPlayPause: "mediaplaypause",
  MediaStop: "mediastop",
  MediaTrackNext: "mediatracknext",
  // parse_key 接受 MEDIATRACKPREV | MEDIATRACKPREVIOUS
  MediaTrackPrevious: "mediatrackprev",
};

/** 纯修饰键：单独按下时不能组成 accelerator。 */
function isModifierOnly(e: KeyboardEvent): boolean {
  return (
    e.key === "Control" ||
    e.key === "Shift" ||
    e.key === "Alt" ||
    e.key === "Meta" ||
    e.code === "ControlLeft" ||
    e.code === "ControlRight" ||
    e.code === "ShiftLeft" ||
    e.code === "ShiftRight" ||
    e.code === "AltLeft" ||
    e.code === "AltRight" ||
    e.code === "MetaLeft" ||
    e.code === "MetaRight" ||
    e.code === "OSLeft" ||
    e.code === "OSRight"
  );
}

/** KeyboardEvent.code → parse_key token；无法映射时返回 null。 */
export function codeToKeyToken(code: string): string | null {
  const named = CODE_TO_KEY[code];
  if (named !== undefined) return named;
  // 字母：KeyA → a（parse_key 接受 "A" / "KEYA"）
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  // 主键盘数字：Digit1 → 1
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  // 功能键：F1–F24
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  return null;
}

/**
 * 把一次按键转成 accelerator 字符串。
 * - 只按下修饰键 → null（继续等主键）
 * - 无法映射的主键 → null
 * - 否则 → `ctrl+shift+alt+super+<key>` 的子集 + 主键（修饰顺序固定）
 */
export function eventToAccelerator(e: KeyboardEvent): string | null {
  if (isModifierOnly(e)) return null;

  const key = codeToKeyToken(e.code);
  if (key === null) return null;

  const mods: string[] = [];
  if (e.ctrlKey) mods.push("ctrl");
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.metaKey) mods.push("super");

  return [...mods, key].join("+");
}

/** 录制中展示用：把当前按下的修饰键拼成前缀提示。 */
export function modifierHint(e: KeyboardEvent): string {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.shiftKey) mods.push("Shift");
  if (e.altKey) mods.push("Alt");
  if (e.metaKey) mods.push("Super");
  return mods.length > 0 ? mods.join("+") + "+" : "";
}

/** 是否是「无修饰的 Esc」——录制取消手势。 */
export function isCaptureCancel(e: KeyboardEvent): boolean {
  return (
    e.code === "Escape" &&
    !e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.metaKey
  );
}
