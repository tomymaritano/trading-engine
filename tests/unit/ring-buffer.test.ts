import { describe, it, expect } from "vitest";
import { RingBuffer } from "../../src/utils/ring-buffer.js";

describe("RingBuffer", () => {
  it("stores and retrieves items by age", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(10);
    buf.push(20);
    buf.push(30);

    expect(buf.get(0)).toBe(30); // most recent
    expect(buf.get(1)).toBe(20);
    expect(buf.get(2)).toBe(10); // oldest
    expect(buf.size).toBe(3);
  });

  it("overwrites oldest items when full", () => {
    const buf = new RingBuffer<number>(3);
    buf.push(1);
    buf.push(2);
    buf.push(3);
    buf.push(4); // overwrites 1

    expect(buf.full).toBe(true);
    expect(buf.size).toBe(3);
    expect(buf.latest()).toBe(4);
    expect(buf.oldest()).toBe(2);
    expect(buf.get(2)).toBe(2);
  });

  it("iterates from oldest to newest", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.push(3);

    expect(buf.toArray()).toEqual([1, 2, 3]);
  });

  it("handles wrapping correctly after many pushes", () => {
    const buf = new RingBuffer<number>(3);
    for (let i = 0; i < 100; i++) buf.push(i);

    expect(buf.latest()).toBe(99);
    expect(buf.oldest()).toBe(97);
    expect(buf.toArray()).toEqual([97, 98, 99]);
  });

  it("returns undefined for out-of-range access", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    expect(buf.get(1)).toBeUndefined();
    expect(buf.get(100)).toBeUndefined();
  });

  it("clears correctly", () => {
    const buf = new RingBuffer<number>(5);
    buf.push(1);
    buf.push(2);
    buf.clear();
    expect(buf.size).toBe(0);
    expect(buf.latest()).toBeUndefined();
  });
});
