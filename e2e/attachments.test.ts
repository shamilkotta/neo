import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { agentId, type AgentClient, NeoApiError } from "@neo/client";
import {
  failure,
  idle,
  type Instance,
  instance,
  running,
  itemAs,
  itemsOf,
  Queued,
  seen as seenBy,
  toolResults,
  transcript,
} from "./harness";
import type { ScriptStep } from "@neo/kernel/testing";

let neo: Instance;
let client: AgentClient;
beforeEach(async () => {
  neo = await instance();
  client = neo.client().agent(agentId("neo"));
});
afterEach(async () => {
  await neo.close();
});

const script = (steps: ScriptStep[]) =>
  neo.act("POST", "/test/script", { steps });
const seen = () => seenBy(neo);
const attachmentsOf = async (index: number) =>
  itemAs((await transcript(neo))[index], "input").messages[0]?.attachments ??
  [];
const first = async <T>(list: Promise<T[]>): Promise<T> => {
  const [item] = await list;
  if (item === undefined) throw new Error("Expected at least one");
  return item;
};

function png(
  width: number,
  height: number,
  padding = 32,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set(
    [..."IHDR"].map((c) => c.charCodeAt(0)),
    12,
  );
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

const exists = (path: string) =>
  client.file(path).then(
    () => true,
    (e) => {
      if (e instanceof NeoApiError && e.status === 404) return false;
      throw e;
    },
  );

describe("attachments from the person", () => {
  test("an image goes inline on its turn, with its path; the upload moves into place", async () => {
    await script([{ recall: "a cat" }]);
    const upload = await client.upload(
      new Blob([png(64, 48)], { type: "image/png" }),
      "cat.png",
    );
    await client.send("what is this?", { attachments: [upload] });
    await idle(neo);
    const attached = await first(attachmentsOf(0));
    expect(attached).toMatchObject({ name: "cat.png", mimeType: "image/png" });
    expect(attached.path).toMatch(/^\/attachments\/\w+\/cat\.png$/);
    const sent = (await seen()).at(-1) ?? "";
    expect(sent).toContain(`${attached.path} (image/png`);
    expect(sent).toContain("shown to you below");
    expect(sent).toContain('"type":"image"');
    expect(await exists(`/.staging/${upload.id}`)).toBe(false);
    expect((await client.fileBlob(attached.path)).size).toBeGreaterThan(0);
    const turn = await client.turn(
      itemAs((await transcript(neo))[0], "input").turnId,
    );
    expect(turn.messages[0]?.attachments[0]?.path).toBe(attached.path);
  });

  test("other files, and images over the limits, go by path only", async () => {
    await script([{ recall: "ok" }]);
    const notes = await client.upload(new Blob(["a,b\n1,2\n"]), "data.csv");
    const huge = await client.upload(
      new Blob([png(3000, 3000)], { type: "image/png" }),
      "huge.png",
    );
    await client.send("", { attachments: [notes, huge] });
    await idle(neo);
    const sent = (await seen()).at(-1) ?? "";
    expect(sent).toMatch(/\/data\.csv \(text\/csv, 8 B\)/);
    expect(sent).toContain("3000x3000 is larger than");
    expect(sent).not.toContain('"type":"image"');
  });

  test("a file claiming to be an image is not sent as one", async () => {
    await script([{ recall: "ok" }]);
    const fake = await client.upload(
      new Blob(["not really"], { type: "image/png" }),
      "fake.png",
    );
    await client.send("look", { attachments: [fake] });
    await idle(neo);
    expect((await seen()).at(-1)).not.toContain('"type":"image"');
    expect((await attachmentsOf(0))[0]?.mimeType).toBe(
      "application/octet-stream",
    );
  });

  test("names are made safe and unique within a message", async () => {
    await script([{ text: "ok" }]);
    const a = await client.upload(new Blob(["1"]), "a.txt");
    const b = await client.upload(new Blob(["2"]), "../A.txt");
    expect(b.name).toBe("__A.txt");
    await client.send("two", { attachments: [a, b] });
    await idle(neo);
    expect((await attachmentsOf(0)).map((f) => f.name)).toEqual([
      "a.txt",
      "__A.txt",
    ]);
    const c = await client.upload(new Blob(["3"]), "same.txt");
    const d = await client.upload(new Blob(["4"]), "same.txt");
    await script([{ text: "ok" }]);
    await client.send("again", { attachments: [c, d] });
    await idle(neo);
    const later = await itemsOf(neo, "input");
    expect(later.at(-1)?.messages[0]?.attachments.map((f) => f.name)).toEqual([
      "same.txt",
      "same (2).txt",
    ]);
  });

  test("a queued message keeps its attachments until its turn", async () => {
    await script([{ gate: "g" }, { text: "first" }, { recall: "second" }]);
    await client.send("start");
    await running(neo);
    const file = await client.upload(new Blob(["later"]), "later.txt");
    const queued = await neo.call("POST", "/test/messages", Queued, {
      text: "then this",
      attachments: [file],
    });
    expect(queued.message.status).toBe("queued");
    expect(queued.message.attachments[0]?.name).toBe("later.txt");
    await neo.act("POST", "/test/release", { gate: "g" });
    await idle(neo);
    expect((await seen()).at(-1)).toContain("/later.txt (text/plain");
  });

  test("a retried send moves nothing again; an unknown upload or a path is refused", async () => {
    await script([{ text: "ok" }]);
    const file = await client.upload(new Blob(["x"]), "x.txt");
    const a = await client.send("hi", { clientId: "c-1", attachments: [file] });
    const b = await client.send("hi", { clientId: "c-1", attachments: [file] });
    expect(b.id).toBe(a.id);
    await idle(neo);
    const error = await failure(
      client.send("hi", {
        attachments: [{ id: "01JAAAAAAAAAAAAAAAAAAAAAAA" }],
      }),
    );
    expect(error).toBeInstanceOf(NeoApiError);
    expect(error.status).toBe(400);
    const path = await failure(
      neo.act("POST", "/messages", {
        text: "hi",
        attachments: [{ path: "/user/a.txt" }],
      }),
    );
    expect(path.status).toBe(400);
  });
});

describe("who reaches what", () => {
  test("the files API stays inside /user, and has no writes", async () => {
    const mine = await client.upload(new Blob(["mine"]), "a.txt");
    expect((await client.file("/")).kind).toBe("directory");
    const escaped = await client.file(`/../../.staging/${mine.id}/a.txt`);
    expect(escaped).toMatchObject({ kind: "file", text: "mine" });
    const put = await neo.fetch(`${neo.agentUrl()}/files?path=/b.txt`, {
      method: "PUT",
      headers: { authorization: "Bearer t" },
      body: "x",
    });
    expect(put.ok).toBe(false);
    await script([{ text: "ok" }]);
    const file = await client.upload(new Blob(["x"]), "x.txt");
    await client.send("hi", { attachments: [file] });
    await idle(neo);
    const attached = await first(attachmentsOf(0));
    expect(await exists(attached.path)).toBe(false);
    expect(
      await client.fileBlob(`/user/.staging/${mine.id}/a.txt`).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });

  test("the agent's tools cannot change /attachments", async () => {
    await script([{ text: "ok" }]);
    const file = await client.upload(new Blob(["keep"]), "keep.txt");
    await client.send("hi", { attachments: [file] });
    await idle(neo);
    const attached = await first(attachmentsOf(0));
    await script([
      {
        tool: "bash",
        args: {
          command: `rm -r /attachments; rm -r /; echo x > ${attached.path}`,
        },
      },
      { tool: "write", args: { path: attached.path, content: "changed" } },
      { text: "tried" },
    ]);
    await client.send("break it");
    await idle(neo);
    const tools = await toolResults(neo);
    expect(tools[0]?.output).toContain("read-only");
    expect(tools[1]?.isError).toBe(true);
    expect(await (await client.fileBlob(attached.path)).text()).toBe("keep");
  });
});

describe("files from the agent", () => {
  test("send_file sends a copy the person can download", async () => {
    await script([
      {
        tool: "write",
        args: { path: "/out/report.csv", content: "name,total\nneo,42\n" },
      },
      {
        tool: "send_file",
        args: { path: "/out/report.csv", caption: "This week's totals" },
      },
      { text: "Here it is." },
    ]);
    await client.send("send me the report");
    await idle(neo);
    const tool = await first(
      toolResults(neo).then((tools) =>
        tools.filter((t) => t.name === "send_file"),
      ),
    );
    expect(tool.isError).toBe(false);
    expect(tool.file).toMatchObject({
      name: "report.csv",
      mimeType: "text/csv",
      size: 18,
      caption: "This week's totals",
    });
    await script([
      { tool: "write", args: { path: "/out/report.csv", content: "changed" } },
      { text: "ok" },
    ]);
    await client.send("change it");
    await idle(neo);
    const blob = await client.fileBlob(tool.file?.path ?? "");
    expect(await blob.text()).toBe("name,total\nneo,42\n");
  });

  test("send_file on a missing file is an error the agent reads", async () => {
    await script([
      { tool: "send_file", args: { path: "/nope.txt" } },
      { text: "sorry" },
    ]);
    await client.send("send it");
    await idle(neo);
    const tool = await first(toolResults(neo));
    expect(tool.isError).toBe(true);
    expect(tool.output).toContain("/nope.txt");
    expect(tool.file).toBeUndefined();
  });
});
