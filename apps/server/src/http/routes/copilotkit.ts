import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";

export type NodeHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Mounts the CopilotKit runtime. The runtime reads the request stream itself,
 * so body parsing is disabled in this scope only (Fastify would otherwise
 * consume the stream first); other routes keep JSON parsing.
 */
export function registerCopilotKitRoute(app: FastifyInstance, handler: NodeHandler): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_request, _payload, done) => {
      done(null);
    });
    const route = async (
      request: { raw: IncomingMessage },
      reply: { hijack: () => unknown; raw: ServerResponse },
    ): Promise<void> => {
      reply.hijack();
      await handler(request.raw, reply.raw);
    };
    scope.all("/api/copilotkit", route as never);
    scope.all("/api/copilotkit/*", route as never);
  });
}
