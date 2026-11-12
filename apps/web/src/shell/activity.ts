import type { AgentSummary } from "@neo/client";
import type { Activity } from "../ui/Avatar";

export const activityOf = (a: AgentSummary): Activity =>
  a.status?.paused ? "paused" : a.status?.working ? "working" : "idle";
