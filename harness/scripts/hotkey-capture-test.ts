/**
 * hotkey capture smoke — KeyboardEvent → accelerator.
 * Run: pnpm tsx scripts/hotkey-capture-test.ts
 */
import {
  codeToKeyToken,
  eventToAccelerator,
  isImeEvent,
  keyToKeyToken,
  resolveKeyToken,
} from "../../src/hotkey.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`);
  console.log(`  ok — ${message}`);
}

type FakeKey = {
  code: string;
  key: string;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  getModifierState?: (name: string) => boolean;
};

function ev(partial: FakeKey): KeyboardEvent {
  const base = {
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 0,
    getModifierState: () => false,
    ...partial,
  };
  return base as unknown as KeyboardEvent;
}

function main() {
  console.log("T1 code → token");
  assert(codeToKeyToken("KeyK") === "k", "KeyK → k");
  assert(codeToKeyToken("Digit2") === "2", "Digit2 → 2");
  assert(codeToKeyToken("F12") === "f12", "F12 → f12");
  assert(codeToKeyToken("NumpadAdd") === "numpadadd", "NumpadAdd → numpadadd");
  assert(codeToKeyToken("Unidentified") === null, "Unidentified → null");

  console.log("T2 key fallback when code missing (WebView2)");
  assert(keyToKeyToken("a") === "a", "key a → a");
  assert(keyToKeyToken("K") === "k", "key K → k");
  assert(keyToKeyToken("F5") === "f5", "key F5 → f5");
  assert(keyToKeyToken(" ") === "space", "key Space → space");
  assert(keyToKeyToken("Enter") === "enter", "key Enter → enter");

  console.log("T3 resolveKeyToken prefers code, falls back to key");
  assert(resolveKeyToken(ev({ code: "KeyA", key: "a" })) === "a", "code wins");
  assert(
    resolveKeyToken(ev({ code: "", key: "F5" })) === "f5",
    "empty code falls back to key F5",
  );
  assert(
    resolveKeyToken(ev({ code: "Unidentified", key: "b" })) === "b",
    "Unidentified code falls back to key b",
  );

  console.log("T4 eventToAccelerator");
  assert(
    eventToAccelerator(ev({ code: "KeyK", key: "k", ctrlKey: true })) === "ctrl+k",
    "Ctrl+K → ctrl+k",
  );
  assert(
    eventToAccelerator(
      ev({ code: "Digit1", key: "!", ctrlKey: true, shiftKey: true }),
    ) === "ctrl+shift+1",
    "Ctrl+Shift+1 → ctrl+shift+1 (not shift+!)",
  );
  assert(
    eventToAccelerator(ev({ code: "F5", key: "F5" })) === "f5",
    "F5 alone → f5",
  );
  assert(
    eventToAccelerator(
      ev({
        code: "KeyK",
        key: "k",
        ctrlKey: true,
        altKey: true,
        getModifierState: (n) => n === "AltGraph",
      }),
    ) === "alt+k",
    "AltGr+K drops phantom ctrl → alt+k",
  );
  assert(
    eventToAccelerator(
      ev({ code: "KeyA", key: "Process", isComposing: true }),
    ) === null,
    "IME composing → null",
  );
  assert(
    eventToAccelerator(ev({ code: "", key: "F5", ctrlKey: true })) === "ctrl+f5",
    "WebView2 empty code Ctrl+F5 → ctrl+f5",
  );
  assert(
    eventToAccelerator(ev({ code: "ControlLeft", key: "Control" })) === null,
    "modifier-only → null",
  );

  console.log("T5 WebView2 keyCode 229 false positive");
  assert(
    eventToAccelerator(
      ev({ code: "KeyK", key: "Process", ctrlKey: true, shiftKey: true, keyCode: 229 }),
    ) === "ctrl+shift+k",
    "Ctrl+Shift+K with keyCode 229 still captures via code",
  );
  assert(
    isImeEvent(ev({ code: "KeyK", key: "k", keyCode: 229 })) === false,
    "KeyK + keyCode 229 is not IME fake",
  );
  assert(
    isImeEvent(ev({ code: "KeyA", key: "Process", isComposing: true })) === true,
    "isComposing Process is IME fake",
  );
  assert(
    isImeEvent(ev({ code: "", key: "Process", keyCode: 229 })) === true,
    "no code + Process + 229 is IME fake",
  );

  console.log("\nhotkey capture smoke: all passed");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
