import { describe, expect, it } from "vitest";

import { RingBuffer } from "./buffer.js";

describe("RingBuffer", () => {
  it("pushes and reports size", () => {
    const b = new RingBuffer<number>(5);
    b.push(1);
    b.push(2);
    expect(b.size).toBe(2);
  });

  it("drops the oldest items when pushing past the cap", () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.push(2);
    b.push(3);
    b.push(4);
    expect(b.size).toBe(3);
    expect(b.takeAll()).toEqual([2, 3, 4]);
  });

  it("takeAll empties the buffer", () => {
    const b = new RingBuffer<number>(3);
    b.push(1);
    b.push(2);
    expect(b.takeAll()).toEqual([1, 2]);
    expect(b.size).toBe(0);
    expect(b.takeAll()).toEqual([]);
  });

  it("restore puts items back at the head", () => {
    const b = new RingBuffer<number>(5);
    b.push(3);
    b.push(4);
    b.restore([1, 2]);
    expect(b.takeAll()).toEqual([1, 2, 3, 4]);
  });

  it("restore respects the cap by dropping the oldest", () => {
    const b = new RingBuffer<number>(3);
    b.push(4);
    b.push(5);
    // combined [1,2,3,4,5] over cap 3 → keep the newest 3
    b.restore([1, 2, 3]);
    expect(b.takeAll()).toEqual([3, 4, 5]);
  });

  it("setMaxItems shrinks by dropping the oldest", () => {
    const b = new RingBuffer<number>(5);
    for (const n of [1, 2, 3, 4, 5]) b.push(n);
    b.setMaxItems(2);
    expect(b.size).toBe(2);
    expect(b.takeAll()).toEqual([4, 5]);
  });

  it("treats a non-positive cap as 1", () => {
    const b = new RingBuffer<number>(0);
    b.push(1);
    b.push(2);
    expect(b.takeAll()).toEqual([2]);
  });
});
