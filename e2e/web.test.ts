import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Instance, instance } from "./harness";

let neo: Instance;
beforeEach(async () => {
  neo = await instance();
});
afterEach(async () => {
  await neo.close();
});

test("the instance serves the bundled web app next to its API", async () => {
  const page = await fetch(`${neo.origin()}/`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('<div id="root">');
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect(script).toBeDefined();
  const asset = await fetch(new URL(script!, `${neo.origin()}/`));
  expect(asset.status).toBe(200);
  expect(await asset.text()).toContain("/agents/");
  expect(
    await (await fetch(`${neo.origin()}/some/app/route`)).text(),
  ).toContain('<div id="root">');
});

test("the API answers cross-origin requests (standalone apps)", async () => {
  const preflight = await fetch(`${neo.url()}/status`, {
    method: "OPTIONS",
    headers: {
      origin: "https://app.example",
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
  expect(preflight.headers.get("access-control-allow-headers")).toContain(
    "authorization",
  );
  const status = await neo.fetch(`${neo.url()}/status`, {
    headers: { authorization: "Bearer t", origin: "https://app.example" },
  });
  expect(status.headers.get("access-control-allow-origin")).toBe("*");
  expect((await fetch(`${neo.url()}/events?token=t`)).status).toBe(401);
});

test("unauthenticated requests are refused before an instance exists", async () => {
  const base = neo.url();
  expect((await fetch(`${base}/status`)).status).toBe(401);
  const wrong = await fetch(`${base}/status`, {
    headers: { authorization: "Bearer nope", origin: "https://app.example" },
  });
  expect(wrong.status).toBe(401);
  expect(wrong.headers.get("access-control-allow-origin")).toBe("*");
  expect((await fetch(`${base}/status`, { method: "OPTIONS" })).status).toBe(
    204,
  );
});
