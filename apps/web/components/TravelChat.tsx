"use client";

import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import "@copilotkit/react-ui/styles.css";

export function TravelChat({ tripId }: { tripId: string }) {
  return (
    <CopilotKit runtimeUrl={`/api/copilotkit/${tripId}`} agent="travel">
      <CopilotChat
        labels={{
          title: "旅行助手",
          placeholder: "说说你想去哪、玩几天、在意什么",
        }}
      />
    </CopilotKit>
  );
}
