import assert from "node:assert/strict";
import { test } from "node:test";

import { ServiceConfigurationError } from "../service-config.ts";
import { resolveStorageDriver, supportsDirectUploads } from "./driver.ts";
import { createGcsStorageService } from "./gcs.ts";
import { StorageObjectNotFoundError } from "./types.ts";

type Call = { init: RequestInit; url: string };

// In-memory bucket behind the GCS JSON API and the metadata server.
function fakeGcs() {
  const objects = new Map<string, { body: Uint8Array; contentType: string }>();
  const calls: Call[] = [];
  let tokens = 0;
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));

    calls.push({ init, url: String(input) });

    if (url.hostname === "metadata.google.internal") {
      tokens += 1;
      return Response.json({
        access_token: `token-${tokens}`,
        expires_in: 3600,
      });
    }

    const upload = url.pathname.startsWith("/upload/");
    const key = upload
      ? url.searchParams.get("name")!
      : decodeURIComponent(url.pathname.split("/o/")[1]);
    const stored = objects.get(key);

    if (upload) {
      if (url.searchParams.get("ifGenerationMatch") === "0" && stored) {
        return new Response("precondition", { status: 412 });
      }

      objects.set(key, {
        body: new Uint8Array(init.body as Uint8Array),
        contentType: new Headers(init.headers).get("content-type")!,
      });
      return Response.json({ name: key });
    }

    if (init.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: stored ? 204 : 404 });
    }

    if (!stored) {
      return new Response("not found", { status: 404 });
    }

    if (url.searchParams.get("alt") === "media") {
      return new Response(stored.body as BodyInit, {
        headers: {
          "content-length": String(stored.body.byteLength),
          "content-type": stored.contentType,
        },
      });
    }

    return Response.json({
      contentType: stored.contentType,
      etag: "etag-1",
      size: String(stored.body.byteLength),
    });
  }) as typeof globalThis.fetch;

  return { calls, fetch, objects };
}

const PDF = new Uint8Array([37, 80, 68, 70]);

test("STORAGE_DRIVER=gcs picks Cloud Storage, without direct uploads", () => {
  assert.equal(resolveStorageDriver({ STORAGE_DRIVER: "GCS" }), "gcs");
  assert.equal(supportsDirectUploads({ STORAGE_DRIVER: "gcs" }), false);
});

test("the Cloud Storage driver needs a bucket", () => {
  assert.throws(
    () => createGcsStorageService({ env: {} }),
    ServiceConfigurationError,
  );
});

test("objects round-trip through the bucket with a metadata-server token", async () => {
  const { calls, fetch } = fakeGcs();
  const storage = createGcsStorageService({
    env: { GCS_BUCKET: "docs" },
    fetch,
  });

  await storage.putObject({
    body: PDF,
    contentType: "application/pdf",
    key: "/envelopes/a b/original.pdf",
  });

  const object = await storage.getObject("envelopes/a b/original.pdf");

  assert.deepEqual(object.body, PDF);
  assert.equal(object.contentType, "application/pdf");
  assert.equal(object.bucketName, "docs");

  const head = await storage.headObject("envelopes/a b/original.pdf");

  assert.equal(head.exists, true);
  assert.equal(head.contentLength, 4);

  const stream = await storage.getObjectStream("envelopes/a b/original.pdf");

  assert.deepEqual(
    new Uint8Array(await new Response(stream.stream).arrayBuffer()),
    PDF,
  );

  const metadataCalls = calls.filter((call) =>
    call.url.startsWith("http://metadata.google.internal/"),
  );

  assert.equal(metadataCalls.length, 1);
  assert.equal(
    new Headers(calls.at(-1)!.init.headers).get("authorization"),
    "Bearer token-1",
  );
  assert.ok(
    calls.some((call) =>
      call.url.includes("/o/envelopes%2Fa%20b%2Foriginal.pdf"),
    ),
  );
});

test("an expired token is fetched again", async () => {
  const { calls, fetch } = fakeGcs();
  let clock = 0;
  const storage = createGcsStorageService({
    env: { GCS_BUCKET: "docs" },
    fetch,
    now: () => clock,
  });

  await storage.headObject("a");
  clock += 3600 * 1000;
  await storage.headObject("a");

  assert.equal(
    calls.filter((call) => call.url.includes("metadata.google.internal"))
      .length,
    2,
  );
});

test("GCS_ACCESS_TOKEN is used as is, without the metadata server", async () => {
  const { calls, fetch } = fakeGcs();
  const storage = createGcsStorageService({
    env: { GCS_ACCESS_TOKEN: "static", GCS_BUCKET: "docs" },
    fetch,
  });

  await storage.headObject("a");

  assert.equal(calls.length, 1);
  assert.equal(
    new Headers(calls[0].init.headers).get("authorization"),
    "Bearer static",
  );
});

test("keepExisting leaves the first write in place", async () => {
  const { fetch, objects } = fakeGcs();
  const storage = createGcsStorageService({
    env: { GCS_BUCKET: "docs" },
    fetch,
  });

  await storage.putObject({
    body: PDF,
    contentType: "application/pdf",
    key: "k",
    keepExisting: true,
  });
  await storage.putObject({
    body: new Uint8Array([1]),
    contentType: "application/pdf",
    key: "k",
    keepExisting: true,
  });

  assert.deepEqual(objects.get("k")!.body, PDF);
});

test("a missing object is not found, and deleting it is not a failure", async () => {
  const { fetch } = fakeGcs();
  const storage = createGcsStorageService({
    env: { GCS_BUCKET: "docs" },
    fetch,
  });

  await assert.rejects(storage.getObject("gone"), StorageObjectNotFoundError);
  assert.equal((await storage.headObject("gone")).exists, false);
  await storage.deleteObject("gone");
});
