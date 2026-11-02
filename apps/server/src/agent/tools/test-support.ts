import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DeepSeekClient } from "../../deepseek/client";
import { TripStore } from "../../store/trip-store";
import type { ToolContext, TravelDeps } from "../deps";

export const TRIP_ID = "trip-1";
export const NOW = new Date("2026-10-19T00:00:00Z");

export const completeBrief = {
  destination: "泰山",
  origin: "上海虹桥",
  startDate: "2026-10-26",
  days: 3,
  budgetCny: 3000,
  companions: "自己",
  fitness: "average" as const,
  interests: ["风景", "美食"],
};

/** A tool context backed by an in-memory store; override any shared service. */
export function makeContext(overrides: Partial<TravelDeps> = {}): ToolContext {
  const deps: TravelDeps = {
    now: () => NOW,
    deepseek: {
      search: async () => [],
      fetch: async (url: string) => ({ title: url, url, content: "" }),
    } as unknown as DeepSeekClient,
    generateSketch: async () => ({ svg: "<svg />", status: "ok" }),
    caps: { search: 40, fetch: 30 },
    ...overrides,
  };
  return { tripId: TRIP_ID, store: TripStore.open(":memory:"), deps };
}

export function textOf(result: CallToolResult): string {
  const block = result.content[0];
  if (block?.type !== "text") throw new Error("expected a text block");
  return block.text;
}

/** Calls a tool handler the way the in-process MCP server does. */
export function invoke(def: { handler: unknown }, args: unknown): Promise<CallToolResult> {
  return (def.handler as (args: unknown, extra: unknown) => Promise<CallToolResult>)(args, {});
}
