import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TripIndexStore } from "./index-store";

it("persists, sorts, and reads back trips atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trips-"));
  const store = new TripIndexStore(join(dir, "trips.json"));
  await store.upsert({ tripId: "a", conversationId: "c1", title: "旧", destination: "泰山", startDate: "2026-10-26", days: 3, updatedAt: "2026-10-18T00:00:00Z", status: "active" });
  await store.upsert({ tripId: "b", conversationId: "c2", title: "新", destination: "黄山", startDate: "2026-11-01", days: 2, updatedAt: "2026-10-19T00:00:00Z", status: "active" });
  expect((await store.list()).map((t) => t.tripId)).toEqual(["b", "a"]);
  expect(await store.get("missing")).toBeUndefined();
  expect(JSON.parse(await (await import("node:fs/promises")).readFile(join(dir, "trips.json"), "utf8"))).toHaveLength(2);
});
