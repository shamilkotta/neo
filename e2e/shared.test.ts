import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { NeoClient } from "@neo/client";
import { type Instance, instance, TOKEN, until } from "./harness";

let neo: Instance;
let root: NeoClient;
beforeEach(async () => {
  neo = await instance();
  root = neo.client();
});
afterEach(async () => {
  await neo.close();
});

const at = (id: string) => neo.agent(id);
const idle = (id: string) =>
  until(
    async () => {
      const s = await at(id).call("GET", "/status");
      return !s.turn && s.queued === 0 ? s : undefined;
    },
    8000,
    `${id} idle`,
  );
/** Runs tool calls on an agent in one turn; returns their outputs. */
async function run(id: string, steps: { tool: string; args: unknown }[]) {
  await at(id).call("POST", "/test/script", {
    steps: [...steps, { text: "done" }],
  });
  const before = (await tools(id)).length;
  await at(id).call("POST", "/messages", { text: "go" });
  await idle(id);
  return (await tools(id)).slice(before);
}
const tools = async (id: string) =>
  ((await at(id).call("GET", "/transcript")).items as any[])
    .filter((i) => i.type === "tool")
    .map((i) => ({ output: i.output as string, isError: i.isError as boolean }));
const bash = (command: string) => ({ tool: "bash", args: { command } });

describe("/shared", () => {
  test("one agent writes, another reads; the shell sees it next to local files", async () => {
    await root.createAgent({ name: "Helper" });
    const [wrote] = await run("neo", [
      { tool: "write", args: { path: "/shared/plan.md", content: "step one\n" } },
    ]);
    expect(wrote!.isError).toBe(false);
    const [read, listing, copied] = await run("helper", [
      { tool: "read", args: { path: "/shared/plan.md" } },
      bash("ls / && ls /shared"),
      bash("mkdir -p /notes && cp /shared/plan.md /notes/plan.md && echo more >> /shared/plan.md && cat /notes/plan.md /shared/plan.md"),
    ]);
    expect(read!.output).toContain("step one");
    expect(listing!.output).toContain("shared");
    expect(listing!.output).toContain("plan.md");
    expect(copied!.output).toBe("step one\nstep one\nmore\n");
    const [again] = await run("neo", [bash("cat /shared/plan.md && ls /notes 2>&1 || true")]);
    expect(again!.output).toContain("step one\nmore");
    expect(again!.output).not.toContain("plan.md\n");
  });

  test("large files stream in and out of /shared intact", async () => {
    await root.createAgent({ name: "Helper" });
    const size = 3 * 1024 * 1024 + 321;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i += 65536)
      crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, size)));
    const put = await neo.fetch(`${neo.agentUrl()}/uploads?name=big.bin`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: bytes,
    });
    const { upload } = await put.json();
    const [out] = await run("neo", [
      bash(`cp /user/.staging/${upload.id}/big.bin /shared/big.bin && ls -l /shared`),
    ]);
    expect(out!.isError).toBe(false);
    const [moved] = await run("helper", [
      bash("mkdir -p /user && mv /shared/big.bin /user/big.bin"),
    ]);
    expect(moved!.isError).toBe(false);
    const got = new Uint8Array(
      await (
        await neo.fetch(`${neo.agentUrl("helper")}/files?path=/big.bin`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        })
      ).arrayBuffer(),
    );
    expect(got.length).toBe(size);
    expect(Bun.hash(got)).toBe(Bun.hash(bytes));
    const [gone] = await run("neo", [bash("ls /shared")]);
    expect(gone!.output).not.toContain("big.bin");
  });

  test("the person can't reach /shared; /shared itself can't be removed", async () => {
    await run("neo", [
      { tool: "write", args: { path: "/shared/secret.txt", content: "agents only" } },
    ]);
    const files = await neo.fetch(`${neo.agentUrl()}/files?path=/shared/secret.txt`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(files.status).toBe(404);
    const up = await neo.fetch(`${neo.agentUrl()}/files?path=/../shared/secret.txt`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(up.status).toBe(404);
    const [removed] = await run("neo", [bash("rm -r /shared 2>&1; ls /shared")]);
    expect(removed!.output).toContain("secret.txt");
  });

  test("send_file can give the person a file from /shared", async () => {
    const [sent] = await run("neo", [
      { tool: "write", args: { path: "/shared/report.txt", content: "report" } },
      { tool: "send_file", args: { path: "/shared/report.txt" } },
    ]).then((r) => r.slice(1));
    expect(sent!.isError).toBe(false);
    expect(sent!.output).toContain("Sent report.txt");
  });

  test("a move carries /shared", async () => {
    await run("neo", [
      { tool: "write", args: { path: "/shared/kept.txt", content: "kept" } },
    ]);
    await root.seal();
    const bundle = await new Response(await root.exportBundle()).arrayBuffer();
    const target = await instance();
    await target.client().importBundle(bundle);
    await target.call("POST", "/test/script", {
      steps: [{ tool: "read", args: { path: "/shared/kept.txt" } }, { text: "ok" }],
    });
    await target.call("POST", "/messages", { text: "read it" });
    await until(
      async () =>
        ((await target.call("GET", "/transcript")).items as any[]).some(
          (i) => i.type === "tool" && i.output.includes("kept"),
        ),
      8000,
      "the file after the move",
    );
  });
});
