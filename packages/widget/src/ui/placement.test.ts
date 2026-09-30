import { describe, expect, it } from "vitest";
import { bubbleBox, clampBox, DEFAULT_POSITION, placePanel, snapPosition } from "./placement.js";

const VP = { width: 1280, height: 800 };

describe("bubbleBox", () => {
  it("default = in basso a destra a 20px dai bordi, come prima", () => {
    expect(bubbleBox(DEFAULT_POSITION, VP)).toEqual({ left: 1280 - 20 - 56, top: 800 - 20 - 56 });
  });
  it("lato sinistro a 20px; y frazione del centro", () => {
    expect(bubbleBox({ side: "left", y: 0.5 }, VP)).toEqual({ left: 20, top: 400 - 28 });
  });
  it("y agli estremi resta dentro i margini", () => {
    expect(bubbleBox({ side: "left", y: 0 }, VP).top).toBe(20);
    expect(bubbleBox({ side: "left", y: 1 }, { width: 400, height: 300 }).top).toBe(300 - 20 - 56);
  });
});

describe("snapPosition", () => {
  it("centro nella metà sinistra → left, altrimenti right", () => {
    expect(snapPosition(639, 400, VP).side).toBe("left");
    expect(snapPosition(640, 400, VP).side).toBe("right");
  });
  it("y = centro clampato / altezza", () => {
    expect(snapPosition(100, 400, VP).y).toBe(0.5);
    expect(snapPosition(100, -500, VP).y).toBe(48 / 800);
    expect(snapPosition(100, 5000, VP).y).toBe(752 / 800);
  });
});

describe("clampBox", () => {
  it("tiene la bolla trascinata dentro il viewport", () => {
    expect(clampBox({ left: -50, top: -50 }, VP)).toEqual({ left: 0, top: 20 });
    expect(clampBox({ left: 5000, top: 5000 }, VP)).toEqual({ left: 1280 - 56, top: 800 - 20 - 56 });
  });
});

describe("placePanel", () => {
  it("bolla in basso a destra → pannello sopra, allineato a destra, 600 alto", () => {
    const p = placePanel(bubbleBox(DEFAULT_POSITION, VP), VP);
    expect(p).toEqual({ left: 1280 - 20 - 380, top: 724 - 12 - 600, width: 380, height: 600 });
  });
  it("bolla in alto a sinistra → pannello sotto, allineato a sinistra", () => {
    const p = placePanel(bubbleBox({ side: "left", y: 0 }, VP), VP);
    expect(p).toEqual({ left: 20, top: 20 + 56 + 12, width: 380, height: 600 });
  });
  it("spazio sopra sotto i 600 → l'altezza si riduce ma resta ≥ 360", () => {
    const vp = { width: 1280, height: 700 };
    const p = placePanel(bubbleBox(DEFAULT_POSITION, vp), vp);
    // bolla top = 624; spazio sopra = 624 - 12 - 20 = 592
    expect(p.height).toBe(592);
    expect(p.top).toBe(20);
  });
  it("meno di 360 in entrambe le direzioni → pannello DI FIANCO, verso l'interno", () => {
    const vp = { width: 1280, height: 600 };
    const b = bubbleBox({ side: "right", y: 0.5 }, vp); // top 272, spazio sopra 240
    const p = placePanel(b, vp);
    expect(p.left).toBe(1280 - 20 - 56 - 12 - 380);
    expect(p.height).toBe(560);
    expect(p.top).toBe(20);
    // e non copre la bolla
    expect(p.left + p.width).toBeLessThanOrEqual(b.left);
  });
  it("di fianco a sinistra → parte dopo la bolla", () => {
    const vp = { width: 1280, height: 600 };
    const p = placePanel(bubbleBox({ side: "left", y: 0.5 }, vp), vp);
    expect(p.left).toBe(20 + 56 + 12);
  });
  it("viewport stretto → larghezza ridotta, mai fuori schermo", () => {
    const vp = { width: 400, height: 800 };
    const p = placePanel(bubbleBox(DEFAULT_POSITION, vp), vp);
    expect(p.width).toBe(360);
    expect(p.left).toBe(20);
  });
});
