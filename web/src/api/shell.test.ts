import { describe, expect, it } from "vitest";
import { zoomKeyAction } from "./shell";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("zoomKeyAction", () => {
  it("catches the keypad and the shifted plus", () => {
    expect(zoomKeyAction(key({ metaKey: true, code: "NumpadAdd", key: "+" }))).toBe("zoom_in");
    expect(zoomKeyAction(key({ ctrlKey: true, code: "NumpadSubtract", key: "-" }))).toBe("zoom_out");
    expect(zoomKeyAction(key({ ctrlKey: true, code: "Numpad0", key: "0" }))).toBe("zoom_reset");
    expect(zoomKeyAction(key({ metaKey: true, shiftKey: true, code: "Equal", key: "+" }))).toBe("zoom_in");
  });

  it("leaves ordinary keys alone", () => {
    expect(zoomKeyAction(key({ code: "NumpadAdd", key: "+" }))).toBeNull();
    expect(zoomKeyAction(key({ metaKey: true, code: "Digit0", key: "0" }))).toBeNull();
    expect(zoomKeyAction(key({ metaKey: true, altKey: true, code: "NumpadAdd", key: "+" }))).toBeNull();
  });
});
