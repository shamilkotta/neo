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
  const page = await fetch(`${neo.url()}/`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain('<div id="root">');
  const script = /src="(\.\/assets\/[^"]+\.js)"/.exec(html)?.[1];
  expect(script).toBeDefined();
  const asset = await fetch(new URL(script!, `${neo.url()}/`));
  expect(asset.status).toBe(200);
  expect(await asset.text()).toContain("/v1/");
  expect(await (await fetch(`${neo.url()}/some/app/route`)).text()).toContain(
    '<div id="root">',
  );
});

test("the API answers cross-origin requests (standalone apps)", async () => {
  const preflight = await fetch(`${neo.url()}/v1/status`, {
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
  const status = await fetch(`${neo.url()}/v1/status`, {
    headers: { authorization: "Bearer t", origin: "https://app.example" },
  });
  expect(status.headers.get("access-control-allow-origin")).toBe("*");
  expect((await fetch(`${neo.url()}/v1/events?token=t`)).status).toBe(401);
});
