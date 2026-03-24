import { describe, it, expect } from "vitest";
import { metrics } from "../../src/utils/metrics.js";

describe("MetricsCollector", () => {
  it("increments counters", () => {
    metrics.incCounter("test_counter", { env: "test" });
    metrics.incCounter("test_counter", { env: "test" });

    const output = metrics.render();
    expect(output).toContain("# TYPE test_counter counter");
    expect(output).toContain('test_counter{env="test"} 2');
  });

  it("sets gauges", () => {
    metrics.setGauge("test_gauge", 42.5, { sym: "BTC" });
    metrics.setGauge("test_gauge", 43.0, { sym: "BTC" }); // overwrites

    const output = metrics.render();
    expect(output).toContain("# TYPE test_gauge gauge");
    expect(output).toContain('test_gauge{sym="BTC"} 43');
  });

  it("handles multiple label sets", () => {
    metrics.incCounter("multi_label", { a: "1", b: "2" });
    metrics.incCounter("multi_label", { a: "1", b: "3" });

    const output = metrics.render();
    expect(output).toContain('a="1",b="2"');
    expect(output).toContain('a="1",b="3"');
  });

  it("renders valid Prometheus format", () => {
    const output = metrics.render();
    // Every line should be either a comment, metric, or empty
    for (const line of output.split("\n")) {
      if (line === "") continue;
      expect(
        line.startsWith("#") || /^[a-z_]+(\{.*\})? \d/.test(line),
      ).toBe(true);
    }
  });
});
