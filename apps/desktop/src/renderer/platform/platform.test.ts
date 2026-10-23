import { afterEach, describe, expect, it } from "vitest";
import { getPlatform, modKeyLabel, shortcutLabel } from "./platform";

function setPlatform(value: string | undefined) {
  if (value === undefined) delete window.stubwise;
  else window.stubwise = { platform: value };
}

afterEach(() => setPlatform(undefined));

describe("platform", () => {
  it("darwin è mac: ⌘ e simboli attaccati", () => {
    setPlatform("darwin");
    expect(getPlatform()).toBe("mac");
    expect(modKeyLabel()).toBe("⌘");
    expect(shortcutLabel(["mod", "K"])).toBe("⌘K");
    expect(shortcutLabel(["mod", "shift", "H"])).toBe("⌘⇧H");
  });

  it("win32 è windows: Ctrl e più", () => {
    setPlatform("win32");
    expect(getPlatform()).toBe("windows");
    expect(modKeyLabel()).toBe("Ctrl");
    expect(shortcutLabel(["mod", "K"])).toBe("Ctrl+K");
    expect(shortcutLabel(["mod", "shift", "H"])).toBe("Ctrl+Shift+H");
  });

  it("linux è linux", () => {
    setPlatform("linux");
    expect(getPlatform()).toBe("linux");
    expect(modKeyLabel()).toBe("Ctrl");
  });

  it("senza preload è web, con Ctrl", () => {
    setPlatform(undefined);
    expect(getPlatform()).toBe("web");
    expect(modKeyLabel()).toBe("Ctrl");
    expect(shortcutLabel(["mod", "1"])).toBe("Ctrl+1");
  });
});
