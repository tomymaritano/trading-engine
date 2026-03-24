import { describe, it, expect, vi } from "vitest";

// Create a fresh bus for testing (not the singleton)
import EventEmitter from "eventemitter3";

describe("EventBus pattern", () => {
  it("delivers typed events to subscribers", () => {
    const bus = new EventEmitter();
    const handler = vi.fn();

    bus.on("test:event", handler);
    bus.emit("test:event", { value: 42 });

    expect(handler).toHaveBeenCalledWith({ value: 42 });
  });

  it("supports multiple subscribers per event", () => {
    const bus = new EventEmitter();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on("test:event", handler1);
    bus.on("test:event", handler2);
    bus.emit("test:event", "data");

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it("supports once listeners", () => {
    const bus = new EventEmitter();
    const handler = vi.fn();

    bus.once("test:event", handler);
    bus.emit("test:event", 1);
    bus.emit("test:event", 2);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(1);
  });

  it("removes specific listeners", () => {
    const bus = new EventEmitter();
    const handler = vi.fn();

    bus.on("test:event", handler);
    bus.off("test:event", handler);
    bus.emit("test:event", "data");

    expect(handler).not.toHaveBeenCalled();
  });
});
