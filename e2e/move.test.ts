import { afterEach, describe, expect, test } from "bun:test";
import { NeoApiError, parse, Status } from "@neo/client";
import type { ScriptStep } from "@neo/kernel/testing";
import {
  failure,
  answers,
  idle,
  type Instance,
  instance,
  transcript,
  until,
  AgentState,
  Upload,
} from "./harness";

const opened: Instance[] = [];
afterEach(async () => {
  for (const neo of opened.splice(0)) await neo.close();
});

async function open(): Promise<Instance> {
  const neo = await instance();
  opened.push(neo);
  return neo;
}

const client = (neo: Instance) => neo.client();
const script = (neo: Instance, steps: ScriptStep[]) =>
  neo.act("POST", "/test/script", { steps });
const send = (neo: Instance, text: string) =>
  neo.act("POST", "/messages", { text });
const enqueue = (neo: Instance, text: string) =>
  neo.act("POST", "/test/messages", { text });

async function putFile(
  neo: Instance,
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
  agent = "neo",
): Promise<string> {
  const response = await neo.fetch(
    `${neo.agentUrl(agent)}/uploads?name=${name}`,
    {
      method: "POST",
      headers: { authorization: "Bearer t" },
      body: bytes,
    },
  );
  expect(response.ok).toBe(true);
  const { upload } = parse(Upload, await response.json());
  return `/.staging/${upload.id}/${upload.name}`;
}

async function getFile(
  neo: Instance,
  path: string,
  agent = "neo",
): Promise<Uint8Array> {
  const response = await neo.fetch(
    `${neo.agentUrl(agent)}/files?path=${path}`,
    {
      headers: { authorization: "Bearer t" },
    },
  );
  expect(response.ok).toBe(true);
  return new Uint8Array(await response.arrayBuffer());
}

function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536)
    crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, size)));
  return bytes;
}

async function startLongTurn(neo: Instance, label: string) {
  await script(neo, [{ gate: label }, { text: "unused" }]);
  await send(neo, `long job ${label}`);
  await until(
    async () => (await transcript(neo)).some((i) => i.type === "assistant"),
    5000,
    "the tool call",
  );
  await enqueue(neo, `queued behind ${label}`);
}

async function move(from: Instance, to: Instance, passphrase?: string) {
  const source = client(from);
  await source.seal();
  const bundle = await new Response(
    await source.exportBundle(passphrase),
  ).arrayBuffer();
  const result = await client(to).importBundle(bundle, passphrase);
  await source.complete();
  return result;
}

describe("move", () => {
  test("an instance moves with all its agents and a turn running, and comes home", async () => {
    const first = await open();
    const small = new TextEncoder().encode("remember the milk\n");
    const big = randomBytes(3 * 1024 * 1024 + 7);
    const todo = await putFile(first, "todo.txt", small);
    const data = await putFile(first, "data.bin", big);
    const helper = (await client(first).createAgent({ name: "Helper" })).id;
    const notes = await putFile(
      first,
      "notes.txt",
      new TextEncoder().encode("helper's"),
      helper,
    );
    await first.root.act("PUT", "/providers/anthropic", {
      kind: "anthropic",
      apiKey: "sk-test",
    });
    await startLongTurn(first, "g1");
    const { instanceId, epoch } = await first.root.call(
      "GET",
      "/status",
      Status,
    );
    expect(epoch).toBe(1);
    if (!instanceId) throw new Error("The instance has no id");

    const second = await open();
    const moved = await move(first, second, "correct horse");
    expect(moved).toEqual({ instanceId, epoch: 2, secrets: "kept" });
    expect((await first.root.call("GET", "/status", Status)).state).toBe(
      "moved",
    );
    expect((await first.call("GET", "/status", AgentState)).state).toBe(
      "moved",
    );
    await expect(send(first, "still there?")).rejects.toThrow();

    await script(second, [
      { text: "resumed after move" },
      { text: "then the queue" },
    ]);
    await second.act("POST", "/test/release", { gate: "g1" });
    await idle(second);
    expect(await answers(second)).toEqual([
      "resumed after move",
      "then the queue",
    ]);
    expect(new TextDecoder().decode(await getFile(second, todo))).toBe(
      "remember the milk\n",
    );
    expect(Bun.hash(await getFile(second, data))).toBe(Bun.hash(big));
    expect(new TextDecoder().decode(await getFile(second, notes, helper))).toBe(
      "helper's",
    );
    const agents = (await client(second).agents()).map((a) => a.id);
    expect<string[]>(agents).toEqual(["neo", helper]);
    const providers = await client(second).providers();
    expect(providers.map((p) => [p.id, p.hasKey])).toEqual([
      ["anthropic", true],
    ]);

    const stranger = await open();
    await client(stranger).seal();
    const other = await new Response(
      await client(stranger).exportBundle(),
    ).arrayBuffer();
    expect((await failure(client(first).importBundle(other))).status).toBe(409);

    await startLongTurn(second, "g2");
    expect(await move(second, first)).toEqual({
      instanceId,
      epoch: 3,
      secrets: "dropped",
    });
    await script(first, [{ text: "home again" }, { text: "queue again" }]);
    await first.act("POST", "/test/release", { gate: "g2" });
    await idle(first);
    expect((await answers(first)).slice(-2)).toEqual([
      "home again",
      "queue again",
    ]);
    expect(Bun.hash(await getFile(first, data))).toBe(Bun.hash(big));
    const after = await client(first).providers();
    expect(after[0]?.hasKey).toBe(false);
  });

  test("unseal cancels a move and the turn resumes in place", async () => {
    const neo = await open();
    await startLongTurn(neo, "g");
    await client(neo).seal();
    expect((await neo.root.call("GET", "/status", Status)).state).toBe(
      "sealed",
    );
    expect((await neo.call("GET", "/status", AgentState)).state).toBe("sealed");
    await expect(send(neo, "hello")).rejects.toThrow();
    await client(neo).unseal();
    await script(neo, [{ text: "back" }, { text: "queue" }]);
    await neo.act("POST", "/test/release", { gate: "g" });
    await idle(neo);
    expect(await answers(neo)).toEqual(["back", "queue"]);
  });

  test("a wrong passphrase leaves the target new and usable", async () => {
    const source = await open();
    await putFile(source, "a.txt", new TextEncoder().encode("a"));
    await client(source).seal();
    const bundle = await new Response(
      await client(source).exportBundle("right"),
    ).arrayBuffer();
    const target = await open();
    const before = (await target.root.call("GET", "/status", Status))
      .instanceId;
    const error = await failure(client(target).importBundle(bundle, "wrong"));
    expect(error).toBeInstanceOf(NeoApiError);
    expect(error.status).toBe(400);
    expect((await target.root.call("GET", "/status", Status)).instanceId).toBe(
      before,
    );
    const missing = await failure(client(target).importBundle(bundle));
    expect(missing.status).toBe(400);
    expect((await client(target).importBundle(bundle, "right")).secrets).toBe(
      "kept",
    );
  });

  test("a used instance refuses an import, and a damaged bundle is refused", async () => {
    const source = await open();
    await client(source).seal();
    const bundle = new Uint8Array(
      await new Response(await client(source).exportBundle()).arrayBuffer(),
    );
    const used = await open();
    const mine = await putFile(
      used,
      "mine.txt",
      new TextEncoder().encode("mine"),
    );
    const refused = await failure(client(used).importBundle(bundle));
    expect(refused.status).toBe(409);
    expect(new TextDecoder().decode(await getFile(used, mine))).toBe("mine");

    const target = await open();
    const cut = bundle.slice(0, Math.floor(bundle.length * 0.6));
    const damaged = await failure(client(target).importBundle(cut));
    expect(damaged).toBeInstanceOf(NeoApiError);
    expect((await target.root.call("GET", "/status", Status)).state).toBe(
      "active",
    );
    expect((await client(target).importBundle(bundle)).epoch).toBe(2);
  });
});
