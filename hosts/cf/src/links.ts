import type { AgentLink, Cells, CoordinatorLink } from "@neo/kernel";

export const agentName = (instance: string, agentId: string) =>
  `${instance}/${agentId}`;

export function coordinatorLink(env: Env, instance: string): CoordinatorLink {
  const stub = () => env.INSTANCE.getByName(instance);
  return {
    init: (agentId) => stub().agentInit(instance, agentId),
    config: () => stub().agentConfig(instance),
    report: (agentId, status) => stub().agentReport(instance, agentId, status),
    agents: () => stub().agentList(instance),
    createAgent: (by, input, key) =>
      stub().agentCreate(instance, by, input, key),
    updateProfile: (agentId, change) =>
      stub().agentUpdate(instance, agentId, change),
    shared: (op, args) => stub().sharedCall(instance, op, args),
    sharedStream: (path) => stub().sharedStream(instance, path),
  };
}

export function agentCells(env: Env, instance: string): Cells {
  return {
    get(agentId): AgentLink {
      const stub = () => env.AGENT.getByName(agentName(instance, agentId));
      return {
        deliver: (message) => stub().deliver(message),
        interrupt: (inst, id, from) => stub().interrupt(inst, id, from),
        provision: (init) => stub().provision(init),
        profileChanged: (profile) => stub().profileChanged(profile),
        configChanged: (revision) => stub().configChanged(revision),
        status: () => stub().status(),
        isNew: () => stub().isNew(),
        seal: () => stub().seal(),
        unseal: () => stub().unseal(),
        markMoved: () => stub().markMoved(),
        exportPart: () => stub().exportPart(),
        importPart: (init, part) => stub().importPart(init, part),
        destroy: () => stub().destroy(),
      };
    },
  };
}
