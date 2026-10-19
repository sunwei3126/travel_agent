import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { TravelService } from "../harness/service";
import { buildServer } from "./app";

/** Parses AG-UI SSE `data:` frames, ignoring non-JSON trailers. */
function sseEvents(body: string): any[] {
  return body
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data.length > 0 && data !== "[DONE]")
    .flatMap((data) => {
      try {
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        return [];
      }
    });
}

async function openService(
  thinkingLevel: "off" | "low" | "medium" = "off",
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-demo-agui-"));
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const model = faux.getModel()!;
  const service = await TravelService.open({
    dataDir: dir,
    models,
    registry: createRegistry(),
    defaultModel: model,
    thinkingLevel,
  });
  return { service, faux };
}

/**
 * Critical C2: watchEvents is conversation-scoped and never closes after a
 * run, so the route must treat pi-durable's run_end as the terminal signal and
 * write RUN_FINISHED, ending the SSE response.
 */
describe("AG-UI route with the real durable service", () => {
  it("ends the stream with RUN_FINISHED after run_end", async () => {
    const { service, faux } = await openService();
    faux.setResponses([fauxAssistantMessage([fauxText("已收到，开始规划。")])]);
    const app = buildServer({ service });
    const trip = await service.createTrip({
      title: "泰山",
      destination: "泰山",
      startDate: "2026-10-26",
      days: 3,
    });

    try {
      const response = await Promise.race([
        app.inject({
          method: "POST",
          url: `/agui?tripId=${trip.tripId}`,
          payload: {
            runId: "r1",
            messages: [{ id: "m1", role: "user", content: "泰山三天" }],
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("AG-UI stream did not end")), 20_000),
        ),
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/event-stream");
      expect(response.body).toContain("RUN_STARTED");
      expect(response.body).toContain("RUN_FINISHED");
      expect(response.body).not.toContain("RUN_ERROR");
      expect(response.body).toContain("TEXT_MESSAGE_START");
      expect(response.body).toContain("TEXT_MESSAGE_END");
    } finally {
      await app.close();
      await service.close();
    }
  }, 30_000);

  it("streams reasoning events when the model returns thinking", async () => {
    const { service, faux } = await openService("low");
    faux.setResponses([
      fauxAssistantMessage([fauxThinking("先想一下"), fauxText("你好")]),
    ]);
    const app = buildServer({ service });
    const trip = await service.createTrip({
      title: "泰山",
      destination: "泰山",
      startDate: "2026-10-26",
      days: 3,
    });

    try {
      const response = await Promise.race([
        app.inject({
          method: "POST",
          url: `/agui?tripId=${trip.tripId}`,
          payload: {
            runId: "r-thinking",
            messages: [{ id: "m1", role: "user", content: "泰山三天" }],
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("AG-UI stream did not end")), 20_000),
        ),
      ]);

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain("REASONING_START");
      expect(response.body).toContain("REASONING_MESSAGE_START");
      expect(response.body).toContain("REASONING_MESSAGE_CONTENT");
      expect(response.body).toContain("REASONING_MESSAGE_END");
      expect(response.body).toContain("REASONING_END");
      expect(response.body).not.toContain("THINKING_");
      expect(response.body).toContain("RUN_FINISHED");
    } finally {
      await app.close();
      await service.close();
    }
  }, 30_000);

  it("streams a tool call with authoritative arguments and keeps the transcript", async () => {
    const { service, faux } = await openService("low");
    const args = { origin: "上海", budgetCny: 3000 };
    faux.setResponses([
      fauxAssistantMessage(
        [fauxThinking("先想一下"), fauxToolCall("trip_update_brief", args)],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage([fauxText("已记录。")]),
    ]);
    const app = buildServer({ service });
    const trip = await service.createTrip({
      title: "泰山",
      destination: "泰山",
      startDate: "2026-10-26",
      days: 3,
    });

    try {
      const response = await Promise.race([
        app.inject({
          method: "POST",
          url: `/agui?tripId=${trip.tripId}`,
          payload: {
            runId: "r-tool",
            messages: [{ id: "m1", role: "user", content: "泰山三天" }],
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("AG-UI stream did not end")), 20_000),
        ),
      ]);

      expect(response.statusCode).toBe(200);
      const events = sseEvents(response.body);
      const reasoning = events.filter(
        (event) => event.type === "REASONING_MESSAGE_CONTENT",
      );
      expect(reasoning.map((event) => event.delta).join("")).toBe("先想一下");
      expect(
        events.filter((event) => event.type === "REASONING_MESSAGE_START"),
      ).toHaveLength(1);

      const toolArgs = events
        .filter((event) => event.type === "TOOL_CALL_ARGS")
        .map((event) => event.delta)
        .join("");
      expect(toolArgs).toBe(JSON.stringify(args));
      expect(events.filter((event) => event.type === "TOOL_CALL_START")).toHaveLength(1);
      expect(events.filter((event) => event.type === "TOOL_CALL_END")).toHaveLength(1);
      expect(events.some((event) => event.type === "TOOL_CALL_RESULT")).toBe(true);

      const snapshot = events.find((event) => event.type === "MESSAGES_SNAPSHOT");
      expect(
        snapshot.messages.some(
          (message: any) => message.role === "user" && message.content === "泰山三天",
        ),
      ).toBe(true);
      expect(response.body).not.toContain("THINKING_");
      expect(response.body).toContain("RUN_FINISHED");

      const transcript = await service.getTranscript(trip.tripId);
      expect(
        transcript.some(
          (entry) => entry.role === "reasoning" && entry.content === "先想一下",
        ),
      ).toBe(true);
      const assistant = transcript.find(
        (entry) => entry.role === "assistant" && entry.toolCalls?.length,
      );
      expect(assistant?.toolCalls?.[0]).toMatchObject({
        name: "trip_update_brief",
        arguments: JSON.stringify(args),
      });
      expect(
        transcript.some(
          (entry) => entry.role === "tool" && entry.name === "trip_update_brief",
        ),
      ).toBe(true);
    } finally {
      await app.close();
      await service.close();
    }
  }, 30_000);
});
