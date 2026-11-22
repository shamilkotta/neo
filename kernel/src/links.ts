import type {
  AgentId,
  AgentMessage,
  AgentProfile,
  AgentStatus,
  AgentTopic,
  AgentSummary,
  ModelRef,
  NewAgent,
  ProfileChange,
  ThinkingLevel,
} from "@neo/client";
import type { ResolvedProvider } from "./services/providers";
import type { SharedCall, SharedStream } from "./vfs/mount";

export interface AgentConfig {
  revision: number;
  providers: ResolvedProvider[];
  model: ModelRef | null;
  thinking: ThinkingLevel | null;
  timezone: string;
}

export interface AgentInit {
  instance: string;
  instanceId: string;
  profile: AgentProfile;
}

export interface AgentCreator {
  by: AgentId;
  idempotencyKey: string;
}

export interface CoordinatorLink {
  init(agentId: AgentId): Promise<AgentInit | undefined>;
  config(): Promise<AgentConfig>;
  changed(
    agentId: AgentId,
    topics: AgentTopic[],
    status: AgentStatus | undefined,
  ): Promise<{ watched: boolean }>;
  live(agentId: AgentId, events: unknown[]): Promise<void>;
  agents(): Promise<AgentSummary[]>;
  createAgent(input: NewAgent, creator: AgentCreator): Promise<AgentProfile>;
  updateProfile(agentId: AgentId, change: ProfileChange): Promise<AgentProfile>;
  shared: SharedCall;
  sharedStream: SharedStream;
}

export interface AgentLink {
  deliver(message: AgentMessage): Promise<void>;
  interrupt(
    instance: string,
    agentId: AgentId,
    from: AgentId,
  ): Promise<{ stopped: boolean; cancelled: number }>;
  provision(init: AgentInit): Promise<void>;
  profileChanged(profile: AgentProfile): Promise<void>;
  configChanged(revision: number): Promise<void>;
  watch(on: boolean): Promise<void>;
  status(): Promise<AgentStatus | undefined>;
  isNew(): Promise<boolean>;
  seal(): Promise<void>;
  unseal(): Promise<void>;
  markMoved(): Promise<void>;
  exportPart(): Promise<ReadableStream<Uint8Array>>;
  importPart(init: AgentInit, part: ReadableStream<Uint8Array>): Promise<void>;
  destroy(): Promise<void>;
}

export interface Cells {
  get(agentId: AgentId): AgentLink;
}
