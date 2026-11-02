"use client";

import { CopilotKit } from "@copilotkit/react-core";
import type { ReactNode } from "react";
import "@copilotkit/react-ui/styles.css";
import { ChatPanel } from "./chat/ChatPanel";

const baseUrl = (process.env.NEXT_PUBLIC_API_URL ?? "/backend").replace(/\/$/, "");

/** The Fastify backend serves the CopilotKit runtime; the trip id is the thread id. */
export const RUNTIME_URL = `${baseUrl}/api/copilotkit`;

export function TravelChat({
  tripId,
  children,
}: {
  tripId: string;
  children?: ReactNode;
}) {
  return (
    <CopilotKit
      runtimeUrl={RUNTIME_URL}
      agent="travel"
      threadId={tripId}
      useSingleEndpoint={false}
      enableInspector={false}
    >
      <ChatPanel key={tripId} />
      {children}
    </CopilotKit>
  );
}
