import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NeoApiError, NeoClient } from "@neo/client";
import { idle, type Instance, instance, running, transcript } from "./harness";

let neo: Instance;
let client: NeoClient;
beforeEach(async () => {
  neo = await instance();
  client = new NeoClient({ url: neo.url(), token: "t" });
});
afterEach(async () => {
  await neo.close();
});

const script = (steps: unknown[]) =>
  neo.call("POST", "/v1/test/script", { steps });
const seen = async () =>
  (await neo.call("GET", "/v1/test/seen")).seen as string[];

function png(
  width: number,
  height: number,
  padding = 32,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(24 + padding);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  bytes.set([..."IHDR"].map((c) => c.charCodeAt(0)), 12);
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
    const items = await transcript(neo);
    const [attached] = items[0].messages[0].attachments;
    expect(attached).toMatchObject({ name: "cat.png", mimeType: "image/png" });
    expect(attached.path).toMatch(/^\/attachments\/\w+\/cat\.png$/);
    const sent = (await seen()).at(-1)!;
    expect(sent).toContain(`${attached.path} (image/png`);
    expect(sent).toContain("shown to you below");
    expect(sent).toContain('"type":"image"');
    expect(await exists(upload.path)).toBe(false);
    expect(await exists(attached.path)).toBe(true);
    const turn = await client.turn(items[0].turnId);
    expect(turn.messages[0]!.attachments[0]!.path).toBe(attached.path);
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
    const sent = (await seen()).at(-1)!;
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
    const items = await transcript(neo);
    expect(items[0].messages[0].attachments[0].mimeType).toBe(
      "application/octet-stream",
    );
  });

  test("names are made safe and unique within a message", async () => {
    await script([{ text: "ok" }]);
    const a = await client.upload(new Blob(["1"]), "a.txt");
    const b = await client.upload(new Blob(["2"]), "a.txt");
    await client.send("two", {
      attachments: [a, { ...b, name: "../A.txt" }],
    });
    await idle(neo);
    const items = await transcript(neo);
    expect(
      items[0].messages[0].attachments.map((f: { name: string }) => f.name),
    ).toEqual(["a.txt", "__A.txt"]);
    const c = await client.upload(new Blob(["3"]), "same.txt");
    const d = await client.upload(new Blob(["4"]), "same.txt");
    await script([{ text: "ok" }]);
    await client.send("again", { attachments: [c, d] });
    await idle(neo);
    const later = (await transcript(neo)).filter((i) => i.type === "input");
    expect(
      later.at(-1).messages[0].attachments.map((f: { name: string }) => f.name),
    ).toEqual(["same.txt", "same (2).txt"]);
  });

  test("a queued message keeps its attachments until its turn", async () => {
    await script([{ gate: "g" }, { text: "first" }, { recall: "second" }]);
    await client.send("start");
    await running(neo);
    const file = await client.upload(new Blob(["later"]), "later.txt");
    const queued = await neo.call("POST", "/v1/test/messages", {
      text: "then this",
      attachments: [file],
    });
    expect(queued.message.status).toBe("queued");
    expect(queued.message.attachments[0].name).toBe("later.txt");
    await neo.call("POST", "/v1/test/release", { gate: "g" });
    await idle(neo);
    expect((await seen()).at(-1)).toContain("/later.txt (text/plain");
  });

  test("a retried send moves nothing again; a missing file is refused", async () => {
    await script([{ text: "ok" }]);
    const file = await client.upload(new Blob(["x"]), "x.txt");
    const a = await client.send("hi", { clientId: "c-1", attachments: [file] });
    const b = await client.send("hi", { clientId: "c-1", attachments: [file] });
    expect(b.id).toBe(a.id);
    await idle(neo);
    const error = await client
      .send("hi", { attachments: [{ path: "/.staging/nope/x.txt" }] })
      .catch((e) => e);
    expect(error).toBeInstanceOf(NeoApiError);
    expect(error.status).toBe(400);
  });
});

describe("files from the agent", () => {
  test("send_file sends a copy the person can download", async () => {
    await client.writeFile("/out/report.csv", "name,total\nneo,42\n");
    await script([
      {
        tool: "send_file",
        args: { path: "/out/report.csv", caption: "This week's totals" },
      },
      { text: "Here it is." },
    ]);
    await client.send("send me the report");
    await idle(neo);
    const items = await transcript(neo);
    const tool = items.find((i) => i.type === "tool" && i.name === "send_file");
    expect(tool.isError).toBe(false);
    expect(tool.file).toMatchObject({
      name: "report.csv",
      mimeType: "text/csv",
      size: 18,
      caption: "This week's totals",
    });
    await client.writeFile("/out/report.csv", "changed");
    const blob = await client.fileBlob(tool.file.path);
    expect(await blob.text()).toBe("name,total\nneo,42\n");
  });

  test("send_file on a missing file is an error the agent reads", async () => {
    await script([
      { tool: "send_file", args: { path: "/nope.txt" } },
      { text: "sorry" },
    ]);
    await client.send("send it");
    await idle(neo);
    const tool = (await transcript(neo)).find((i) => i.type === "tool");
    expect(tool.isError).toBe(true);
    expect(tool.output).toContain("/nope.txt");
    expect(tool.file).toBeUndefined();
  });
});
