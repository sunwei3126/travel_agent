import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createRegistry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { TravelService } from "../harness/service";
import { buildServer } from "./app";

async function openService() {
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
});
