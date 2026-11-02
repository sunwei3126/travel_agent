import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerCopilotKitRoute, type NodeHandler } from "./copilotkit";

const echo: NodeHandler = async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  res.writeHead(200, { "content-type": "application/json", "x-url": req.url ?? "" });
  res.end(Buffer.concat(chunks));
};

describe("registerCopilotKitRoute", () => {
  it("hands the raw request, body included, to the runtime handler", async () => {
    const app = Fastify();
    registerCopilotKitRoute(app, echo);
    const response = await app.inject({
      method: "POST",
      url: "/api/copilotkit/agent/travel/run",
      payload: { runId: "r1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ runId: "r1" });
    expect(response.headers["x-url"]).toBe("/api/copilotkit/agent/travel/run");
  });

  it("also serves the base path itself", async () => {
    const app = Fastify();
    registerCopilotKitRoute(app, echo);
    const response = await app.inject({ method: "GET", url: "/api/copilotkit" });
    expect(response.statusCode).toBe(200);
  });

  it("leaves JSON body parsing on for other routes", async () => {
    const app = Fastify();
    registerCopilotKitRoute(app, echo);
    app.post("/other", async (request) => request.body);
    const response = await app.inject({ method: "POST", url: "/other", payload: { a: 1 } });
    expect(response.json()).toEqual({ a: 1 });
  });
});
