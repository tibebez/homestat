import { expect, test } from "bun:test";
import { CONFIG_PATH, evaluateStatus, normalizeServiceUrl, relativeTime } from "../src/index.ts";

test("config path uses ~/.homestat/config.json", () => {
  expect(CONFIG_PATH.endsWith(".homestat/config.json")).toBe(true);
});

test("normalizes urls that are missing protocol", () => {
  expect(normalizeServiceUrl("localhost:8080")).toBe("http://localhost:8080");
  expect(normalizeServiceUrl("https://example.com")).toBe("https://example.com");
});

test("evaluates online status for 2xx and 3xx", () => {
  expect(evaluateStatus(200)).toBe("online");
  expect(evaluateStatus(302)).toBe("online");
  expect(evaluateStatus(404)).toBe("offline");
});

test("formats relative times", () => {
  const now = 1_000_000;
  expect(relativeTime(null, now)).toBe("never");
  expect(relativeTime(now - 5_000, now)).toBe("5s ago");
  expect(relativeTime(now - 120_000, now)).toBe("2m ago");
});
