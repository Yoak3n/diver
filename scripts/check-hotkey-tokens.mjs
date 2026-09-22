// 校验 hotkey.ts 捕获 token 与 global-hotkey parse_key 词表对齐。
// 运行：node scripts/check-hotkey-tokens.mjs

const parseKeyTokens = new Set([
  'BACKQUOTE', '`', 'BACKSLASH', '\\', 'BRACKETLEFT', '[', 'BRACKETRIGHT', ']',
  'PAUSE', 'PAUSEBREAK', 'COMMA', ',',
  'DIGIT0', '0', 'DIGIT1', '1', 'DIGIT2', '2', 'DIGIT3', '3', 'DIGIT4', '4',
  'DIGIT5', '5', 'DIGIT6', '6', 'DIGIT7', '7', 'DIGIT8', '8', 'DIGIT9', '9',
  'EQUAL', '=',
  'KEYA', 'A', 'KEYB', 'B', 'KEYC', 'C', 'KEYD', 'D', 'KEYE', 'E', 'KEYF', 'F',
  'KEYG', 'G', 'KEYH', 'H', 'KEYI', 'I', 'KEYJ', 'J', 'KEYK', 'K', 'KEYL', 'L',
  'KEYM', 'M', 'KEYN', 'N', 'KEYO', 'O', 'KEYP', 'P', 'KEYQ', 'Q', 'KEYR', 'R',
  'KEYS', 'S', 'KEYT', 'T', 'KEYU', 'U', 'KEYV', 'V', 'KEYW', 'W', 'KEYX', 'X',
  'KEYY', 'Y', 'KEYZ', 'Z',
  'MINUS', '-', 'PERIOD', '.', 'QUOTE', "'", 'SEMICOLON', ';', 'SLASH', '/',
  'BACKSPACE', 'CAPSLOCK', 'ENTER', 'SPACE', 'TAB', 'DELETE', 'END', 'HOME',
  'INSERT', 'PAGEDOWN', 'PAGEUP', 'PRINTSCREEN', 'SCROLLLOCK',
  'ARROWDOWN', 'DOWN', 'ARROWLEFT', 'LEFT', 'ARROWRIGHT', 'RIGHT', 'ARROWUP', 'UP',
  'NUMLOCK',
  'NUMPAD0', 'NUM0', 'NUMPAD1', 'NUM1', 'NUMPAD2', 'NUM2', 'NUMPAD3', 'NUM3',
  'NUMPAD4', 'NUM4', 'NUMPAD5', 'NUM5', 'NUMPAD6', 'NUM6', 'NUMPAD7', 'NUM7',
  'NUMPAD8', 'NUM8', 'NUMPAD9', 'NUM9',
  'NUMPADADD', 'NUMADD', 'NUMPADPLUS', 'NUMPLUS', 'NUMPADDECIMAL', 'NUMDECIMAL',
  'NUMPADDIVIDE', 'NUMDIVIDE', 'NUMPADENTER', 'NUMENTER', 'NUMPADEQUAL', 'NUMEQUAL',
  'NUMPADMULTIPLY', 'NUMMULTIPLY', 'NUMPADSUBTRACT', 'NUMSUBTRACT',
  'ESCAPE', 'ESC',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'F13', 'F14', 'F15', 'F16', 'F17', 'F18', 'F19', 'F20', 'F21', 'F22', 'F23', 'F24',
  'AUDIOVOLUMEDOWN', 'VOLUMEDOWN', 'AUDIOVOLUMEUP', 'VOLUMEUP',
  'AUDIOVOLUMEMUTE', 'VOLUMEMUTE',
  'MEDIAPLAY', 'MEDIAPAUSE', 'MEDIAPLAYPAUSE', 'MEDIASTOP',
  'MEDIATRACKNEXT', 'MEDIATRACKPREV', 'MEDIATRACKPREVIOUS',
]);

// 与 src/hotkey.ts CODE_TO_KEY 保持同步
const CODE_TO_KEY = {
  Backquote: 'backquote', Backslash: 'backslash', BracketLeft: 'bracketleft',
  BracketRight: 'bracketright', Comma: 'comma', Equal: 'equal', Minus: 'minus',
  Period: 'period', Quote: 'quote', Semicolon: 'semicolon', Slash: 'slash',
  Backspace: 'backspace', CapsLock: 'capslock', Enter: 'enter', Space: 'space',
  Tab: 'tab', Delete: 'delete', End: 'end', Home: 'home', Insert: 'insert',
  PageDown: 'pagedown', PageUp: 'pageup', PrintScreen: 'printscreen',
  ScrollLock: 'scrolllock', ArrowDown: 'arrowdown', ArrowLeft: 'arrowleft',
  ArrowRight: 'arrowright', ArrowUp: 'arrowup', NumLock: 'numlock',
  Numpad0: 'numpad0', Numpad1: 'numpad1', Numpad2: 'numpad2', Numpad3: 'numpad3',
  Numpad4: 'numpad4', Numpad5: 'numpad5', Numpad6: 'numpad6', Numpad7: 'numpad7',
  Numpad8: 'numpad8', Numpad9: 'numpad9', NumpadAdd: 'numpadadd',
  NumpadDecimal: 'numpaddecimal', NumpadDivide: 'numpaddivide',
  NumpadEnter: 'numpadenter', NumpadEqual: 'numpadequal',
  NumpadMultiply: 'numpadmultiply', NumpadSubtract: 'numpadsubtract',
  Escape: 'escape', Pause: 'pause',
  AudioVolumeDown: 'audiovolumedown', AudioVolumeUp: 'audiovolumeup',
  AudioVolumeMute: 'audiovolumemute',
  MediaPlay: 'mediaplay', MediaPause: 'mediapause', MediaPlayPause: 'mediaplaypause',
  MediaStop: 'mediastop', MediaTrackNext: 'mediatracknext',
  MediaTrackPrevious: 'mediatrackprev',
};

function codeToKeyToken(code) {
  const named = CODE_TO_KEY[code];
  if (named !== undefined) return named;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code.toLowerCase();
  return null;
}

const MODS = new Set([
  'OPTION', 'ALT', 'CONTROL', 'CTRL', 'COMMAND', 'CMD', 'SUPER', 'SHIFT',
  'COMMANDORCONTROL', 'COMMANDORCTRL', 'CMDORCTRL', 'CMDORCONTROL',
]);

function roughParse(h) {
  const tokens = h.split('+');
  let key = null;
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) return false;
    if (key !== null) return false;
    const u = token.toUpperCase();
    if (MODS.has(u)) continue;
    if (!parseKeyTokens.has(u)) return false;
    key = token;
  }
  return key !== null;
}

let fail = 0;
for (const [code, token] of Object.entries(CODE_TO_KEY)) {
  if (!parseKeyTokens.has(token.toUpperCase())) {
    console.log('FAIL named', code, '->', token);
    fail++;
  }
}
for (const code of ['KeyA', 'KeyZ', 'Digit0', 'Digit9', 'F1', 'F12', 'F24']) {
  const t = codeToKeyToken(code);
  if (!t || !parseKeyTokens.has(t.toUpperCase())) {
    console.log('FAIL pattern', code, '->', t);
    fail++;
  }
}

const samples = [
  ['ctrl+shift+m', true],
  ['ctrl+shift+p', true],
  ['alt+1', true],
  ['cmdorctrl+f5', true],
  ['super+space', true],
  ['ctrl+shift+!', false],
  ['shift+ctrl+m', true],
  ['ctrl+a', true],
];
for (const [s, expect] of samples) {
  const ok = roughParse(s);
  if (ok !== expect) {
    console.log('FAIL sample', s, 'got', ok, 'want', expect);
    fail++;
  }
}

console.log(fail === 0 ? 'ALL OK' : `FAILURES: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
