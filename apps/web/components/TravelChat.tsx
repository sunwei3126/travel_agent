"use client";

import { CopilotKit } from "@copilotkit/react-core";
import type { ReactNode } from "react";
import "@copilotkit/react-ui/styles.css";
import { ChatPanel } from "./chat/ChatPanel";

export function TravelChat({
  tripId,
  children,
}: {
  tripId: string;
  children?: ReactNode;
}) {
  return (
    <CopilotKit
      runtimeUrl={`/api/copilotkit/${encodeURIComponent(tripId)}`}
      agent="travel"
      enableInspector={false}
    >
      <ChatPanel key={tripId} tripId={tripId} />
      {children}
    </CopilotKit>
  );
}
