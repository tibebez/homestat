import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/index.ts";

async function withTempConfigFile(content: unknown, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "homestat-test-"));
  const path = join(dir, "config.json");

  try {
    await Bun.write(path, JSON.stringify(content));
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("accepts services with null or missing group", async () => {
  await withTempConfigFile(
    {
      services: [
        { name: "A", url: "http://localhost:3000", group: null },
        { name: "B", url: "http://localhost:3001" },
      ],
    },
    async (path) => {
      const config = await loadConfig(path);
      expect(config.services[0].group).toBeNull();
      expect(config.services[1].group).toBeUndefined();
    },
  );
});

test("accepts bookmarkedAt as number or null", async () => {
  await withTempConfigFile(
    {
      services: [
        {
          name: "A",
          url: "http://localhost:3000",
          bookmarked: true,
          bookmarkedAt: 42,
        },
        {
          name: "B",
          url: "http://localhost:3001",
          bookmarked: false,
          bookmarkedAt: null,
        },
      ],
    },
    async (path) => {
      const config = await loadConfig(path);
      expect(config.services[0].bookmarkedAt).toBe(42);
      expect(config.services[1].bookmarkedAt).toBeNull();
    },
  );
});

test("accepts enabled as boolean", async () => {
  await withTempConfigFile(
    {
      services: [
        { name: "A", url: "http://localhost:3000", enabled: true },
        { name: "B", url: "http://localhost:3001", enabled: false },
      ],
    },
    async (path) => {
      const config = await loadConfig(path);
      expect(config.services[0].enabled).toBe(true);
      expect(config.services[1].enabled).toBe(false);
    },
  );
});

test("rejects invalid enabled type", async () => {
  await withTempConfigFile(
    {
      services: [{ name: "A", url: "http://localhost:3000", enabled: "yes" }],
    },
    async (path) => {
      await expect(loadConfig(path)).rejects.toThrow("invalid enabled");
    },
  );
});

test("rejects invalid group type", async () => {
  await withTempConfigFile(
    {
      services: [{ name: "A", url: "http://localhost:3000", group: 123 }],
    },
    async (path) => {
      await expect(loadConfig(path)).rejects.toThrow("invalid group");
    },
  );
});
