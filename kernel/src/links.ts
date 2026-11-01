// What the coordinator and the agents ask each other. The kernel only sees these interfaces; a host
// carries them (on Cloudflare, Durable Object RPC). Every argument and result is structured-clone
// data or a byte stream.
import type {
  AgentMessage,
  AgentProfile,
  AgentStatus,
  AgentSummary,
  ModelRef,
  NewAgent,
  ProfileChange,
  ThinkingLevel,
} from "@neo/client";
import type { ResolvedProvider } from "./services/providers";
import type { SharedCall, SharedStream } from "./vfs/mount";

/** What an agent needs from the instance to run a turn. Held in memory only (it has keys). */
export interface AgentConfig {
  revision: number;
  providers: ResolvedProvider[];
  model: ModelRef | null;
  thinking: ThinkingLevel | null;
  timezone: string;
}

/** Everything an agent needs to make itself. */
export interface AgentInit {
  instance: string;
  instanceId: string;
  profile: AgentProfile;
}

/** What an agent asks its coordinator. */
export interface CoordinatorLink {
  /** The agent's init if the registry has it; undefined for an agent that does not exist. */
  init(agentId: string): Promise<AgentInit | undefined>;
  config(): Promise<AgentConfig>;
  report(agentId: string, status: AgentStatus): Promise<void>;
  agents(): Promise<AgentSummary[]>;
  /** `key` makes a retried call return the agent it already made. */
  createAgent(by: string, input: NewAgent, key: string): Promise<AgentProfile>;
  updateProfile(agentId: string, change: ProfileChange): Promise<AgentProfile>;
  /** /shared: the instance's folder every agent reads and writes. */
  shared: SharedCall;
  sharedStream: SharedStream;
}

/** What the coordinator, or another agent, asks an agent. */
export interface AgentLink {
  /** From a teammate: into the mailbox (a repeat of the same id is ignored). */
  deliver(message: AgentMessage): Promise<void>;
  /** From a teammate: stop work on its messages and drop its queued ones. */
  interrupt(
    instance: string,
    agentId: string,
    from: string,
  ): Promise<{ stopped: boolean; cancelled: number }>;
  provision(init: AgentInit): Promise<void>;
  profileChanged(profile: AgentProfile): Promise<void>;
  configChanged(revision: number): Promise<void>;
  status(): Promise<AgentStatus | undefined>;
  isNew(): Promise<boolean>;
  seal(): Promise<void>;
  unseal(): Promise<void>;
  markMoved(): Promise<void>;
  exportPart(): Promise<ReadableStream<Uint8Array>>;
  importPart(init: AgentInit, part: ReadableStream<Uint8Array>): Promise<void>;
  destroy(): Promise<void>;
}

/** The host decides what an agent is (a Durable Object stub on Cloudflare). */
export interface Cells {
  get(agentId: string): AgentLink;
}
