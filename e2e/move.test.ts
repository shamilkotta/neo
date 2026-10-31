import { afterEach, describe, expect, test } from "bun:test";
import { NeoApiError, NeoClient } from "@neo/client";
import {
  answers,
  idle,
  type Instance,
  instance,
  onCloudflare,
  transcript,
  until,
} from "./harness";

const opened: Instance[] = [];
afterEach(async () => {
  for (const neo of opened.splice(0)) await neo.close();
});

async function open(on?: "bun" | "cloudflare"): Promise<Instance> {
  const neo = await instance(on);
  opened.push(neo);
  return neo;
}

const client = (neo: Instance) => new NeoClient({ url: neo.url(), token: "t" });
const script = (neo: Instance, steps: unknown[]) =>
  neo.call("POST", "/v1/test/script", { steps });
const send = (neo: Instance, text: string) =>
  neo.call("POST", "/v1/messages", { text });
/** Waits in the queue behind a running turn, which the API itself never does. */
const enqueue = (neo: Instance, text: string) =>
  neo.call("POST", "/v1/test/messages", { text });

async function putFile(neo: Instance, path: string, bytes: Uint8Array<ArrayBuffer>) {
  const response = await fetch(`${neo.url()}/v1/files?path=${path}`, {
    method: "PUT",
    headers: { authorization: "Bearer t" },
    body: bytes,
  });
  expect(response.ok).toBe(true);
}

async function getFile(neo: Instance, path: string): Promise<Uint8Array> {
  const response = await fetch(`${neo.url()}/v1/files?path=${path}`, {
    headers: { authorization: "Bearer t" },
  });
  expect(response.ok).toBe(true);
  return new Uint8Array(await response.arrayBuffer());
}

function randomBytes(size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536)
    crypto.getRandomValues(bytes.subarray(i, Math.min(i + 65536, size)));
  return bytes;
}

/** Starts a turn that stops inside a tool, with another message queued behind it. */
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

/** The steps `neo move` takes, through the client every app uses. */
async function move(from: Instance, to: Instance, passphrase?: string) {
  const source = client(from);
  await source.seal();
  // Buffered here only to keep the test simple; the CLI spools to disk.
  const bundle = await new Response(
    await source.exportBundle(passphrase),
  ).arrayBuffer();
  const result = await client(to).importBundle(bundle, passphrase);
  await source.complete();
  return result;
}

describe("move", () => {
  test(`an instance moves ${onCloudflare ? "bun → cloudflare → bun" : "bun → bun"} with a turn running`, async () => {
    const first = await open("bun");
    const small = new TextEncoder().encode("remember the milk\n");
    const big = randomBytes(3 * 1024 * 1024 + 7); // a blob object
    await putFile(first, "/notes/todo.txt", small);
    await putFile(first, "/big/data.bin", big);
    await first.call("PUT", "/v1/providers/anthropic", {
      kind: "anthropic",
      apiKey: "sk-test",
    });
    await startLongTurn(first, "g1");
    const { instanceId, epoch } = await first.call("GET", "/v1/status");
    expect(epoch).toBe(1);

    const second = await open(onCloudflare ? "cloudflare" : "bun");
    const moved = await move(first, second, "correct horse");
    expect(moved).toEqual({ instanceId, epoch: 2, secrets: "kept" });
    expect((await first.call("GET", "/v1/status")).state).toBe("moved");
    await expect(send(first, "still there?")).rejects.toThrow();

    // The interrupted turn resumes on the new host: the gate replays, then the queue runs.
    await script(second, [
      { text: "resumed after move" },
      { text: "then the queue" },
    ]);
    await second.call("POST", "/v1/test/release", { gate: "g1" });
    await idle(second);
    expect(await answers(second)).toEqual([
      "resumed after move",
      "then the queue",
    ]);
    expect(new TextDecoder().decode(await getFile(second, "/notes/todo.txt"))).toBe(
      "remember the milk\n",
    );
    expect(Bun.hash(await getFile(second, "/big/data.bin"))).toBe(Bun.hash(big));
    const { providers } = await second.call("GET", "/v1/providers");
    expect(providers.map((p: any) => [p.id, p.hasKey])).toEqual([
      ["anthropic", true],
    ]);

    // The retired source takes the instance back (a later epoch), and nothing else.
    const stranger = await open();
    await client(stranger).seal();
    const other = await new Response(await client(stranger).exportBundle()).arrayBuffer();
    expect((await client(first).importBundle(other).catch((e) => e)).status).toBe(409);

    if (!onCloudflare) {
      await startLongTurn(second, "g3");
      expect((await move(second, first)).epoch).toBe(3);
      await script(first, [{ text: "home" }, { text: "queue" }]);
      await first.call("POST", "/v1/test/release", { gate: "g3" });
      await idle(first);
      expect((await answers(first)).slice(-2)).toEqual(["home", "queue"]);
      return;
    }
    // And back, again mid-turn, without a passphrase: the key is dropped.
    await startLongTurn(second, "g2");
    const third = await open("bun");
    expect(await move(second, third)).toEqual({
      instanceId,
      epoch: 3,
      secrets: "dropped",
    });
    await script(third, [{ text: "home again" }, { text: "queue again" }]);
    await third.call("POST", "/v1/test/release", { gate: "g2" });
    await idle(third);
    expect((await answers(third)).slice(-2)).toEqual([
      "home again",
      "queue again",
    ]);
    expect(Bun.hash(await getFile(third, "/big/data.bin"))).toBe(Bun.hash(big));
    const after = await third.call("GET", "/v1/providers");
    expect(after.providers[0].hasKey).toBe(false);
  });

  test("unseal cancels a move and the turn resumes in place", async () => {
    const neo = await open();
    await startLongTurn(neo, "g");
    await client(neo).seal();
    expect((await neo.call("GET", "/v1/status")).state).toBe("sealed");
    await expect(send(neo, "hello")).rejects.toThrow();
    await client(neo).unseal();
    await script(neo, [{ text: "back" }, { text: "queue" }]);
    await neo.call("POST", "/v1/test/release", { gate: "g" });
    await idle(neo);
    expect(await answers(neo)).toEqual(["back", "queue"]);
  });

  test("a wrong passphrase leaves the target new and usable", async () => {
    const source = await open();
    await putFile(source, "/a.txt", new TextEncoder().encode("a"));
    await client(source).seal();
    const bundle = await new Response(
      await client(source).exportBundle("right"),
    ).arrayBuffer();
    const target = await open();
    const before = (await target.call("GET", "/v1/status")).instanceId;
    const error = await client(target)
      .importBundle(bundle, "wrong")
      .catch((e) => e);
    expect(error).toBeInstanceOf(NeoApiError);
    expect(error.status).toBe(400);
    expect((await target.call("GET", "/v1/status")).instanceId).toBe(before);
    const missing = await client(target)
      .importBundle(bundle)
      .catch((e) => e);
    expect(missing.status).toBe(400);
    expect(
      (await client(target).importBundle(bundle, "right")).secrets,
    ).toBe("kept");
  });

  test("a used instance refuses an import, and a damaged bundle is refused", async () => {
    const source = await open();
    await client(source).seal();
    const bundle = new Uint8Array(
      await new Response(await client(source).exportBundle()).arrayBuffer(),
    );
    const used = await open();
    await putFile(used, "/mine.txt", new TextEncoder().encode("mine"));
    const refused = await client(used)
      .importBundle(bundle)
      .catch((e) => e);
    expect(refused.status).toBe(409);
    expect(new TextDecoder().decode(await getFile(used, "/mine.txt"))).toBe(
      "mine",
    );

    const target = await open();
    const cut = bundle.slice(0, Math.floor(bundle.length * 0.6));
    const damaged = await client(target)
      .importBundle(cut)
      .catch((e) => e);
    expect(damaged).toBeInstanceOf(NeoApiError);
    expect((await target.call("GET", "/v1/status")).state).toBe("active");
    expect((await client(target).importBundle(bundle)).epoch).toBe(2);
  });
});
