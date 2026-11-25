import { type EnvSource } from "../../utils/env.ts";
import { ServiceConfigurationError } from "../service-config.ts";
import {
  normalizeStorageKey,
  type StorageObjectHead,
  StorageObjectNotFoundError,
  type StorageService,
} from "./types.ts";

const API_URL = "https://storage.googleapis.com";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
// Refresh before expiry so a token never lapses mid-request.
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

type CachedToken = { expiresAt: number; value: string };

type CreateGcsStorageServiceOptions = {
  env?: EnvSource;
  fetch?: typeof fetch;
  now?: () => number;
};

export function createGcsStorageService({
  env = process.env,
  fetch: send = fetch,
  now = Date.now,
}: CreateGcsStorageServiceOptions = {}): StorageService {
  const bucket = env.GCS_BUCKET?.trim();

  if (!bucket) {
    throw new ServiceConfigurationError("storage", ["GCS_BUCKET"]);
  }

  const staticToken = env.GCS_ACCESS_TOKEN?.trim();
  let cached: CachedToken | null = null;

  async function accessToken(): Promise<string> {
    if (staticToken) {
      return staticToken;
    }

    if (cached && cached.expiresAt > now()) {
      return cached.value;
    }

    const response = await send(METADATA_TOKEN_URL, {
      headers: { "metadata-flavor": "Google" },
    });

    if (!response.ok) {
      throw new Error(
        `Storage could not get a Google access token: ${response.status}`,
      );
    }

    const answer = (await response.json()) as {
      access_token: string;
      expires_in: number;
    };

    cached = {
      expiresAt: now() + answer.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
      value: answer.access_token,
    };

    return cached.value;
  }

  const objectUrl = (key: string) =>
    `${API_URL}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(key)}`;

  async function request(url: string, init: RequestInit = {}) {
    return send(url, {
      ...init,
      headers: {
        ...(init.headers as Record<string, string> | undefined),
        authorization: `Bearer ${await accessToken()}`,
      },
    });
  }

  async function fail(
    action: string,
    key: string,
    response: Response,
  ): Promise<never> {
    const detail = (await response.text().catch(() => "")).slice(0, 300);

    throw new Error(
      `Storage ${action} failed for ${key}: ${response.status} ${detail}`.trim(),
    );
  }

  async function fetchObject(key: string) {
    const normalizedKey = normalizeStorageKey(key);
    const response = await request(`${objectUrl(normalizedKey)}?alt=media`);

    if (response.status === 404) {
      await response.body?.cancel();
      throw new StorageObjectNotFoundError(normalizedKey);
    }

    if (!response.ok) {
      await fail("read", normalizedKey, response);
    }

    return { normalizedKey, response };
  }

  function contentLengthOf(response: Response): number | undefined {
    const value = response.headers.get("content-length");

    return value === null ? undefined : Number.parseInt(value, 10);
  }

  async function headObject(key: string): Promise<StorageObjectHead> {
    const normalizedKey = normalizeStorageKey(key);
    const response = await request(objectUrl(normalizedKey));

    if (response.status === 404) {
      await response.body?.cancel();
      return { bucketName: bucket!, exists: false, key: normalizedKey };
    }

    if (!response.ok) {
      await fail("lookup", normalizedKey, response);
    }

    const metadata = (await response.json()) as {
      contentType?: string;
      etag?: string;
      size?: string;
    };

    return {
      bucketName: bucket!,
      contentLength:
        metadata.size === undefined ? undefined : Number(metadata.size),
      contentType: metadata.contentType,
      etag: metadata.etag,
      exists: true,
      key: normalizedKey,
    };
  }

  return {
    async deleteObject(key) {
      const normalizedKey = normalizeStorageKey(key);
      const response = await request(objectUrl(normalizedKey), {
        method: "DELETE",
      });

      if (!response.ok && response.status !== 404) {
        await fail("delete", normalizedKey, response);
      }

      await response.body?.cancel();
    },
    async getObject(key) {
      const { normalizedKey, response } = await fetchObject(key);
      const body = new Uint8Array(await response.arrayBuffer());

      return {
        body,
        bucketName: bucket,
        contentLength: body.byteLength,
        contentType: response.headers.get("content-type") ?? undefined,
        etag: response.headers.get("etag") ?? undefined,
        key: normalizedKey,
      };
    },
    async getObjectStream(key) {
      const { normalizedKey, response } = await fetchObject(key);

      return {
        bucketName: bucket,
        contentLength: contentLengthOf(response),
        contentType: response.headers.get("content-type") ?? undefined,
        key: normalizedKey,
        stream:
          response.body ??
          new ReadableStream<Uint8Array>({
            start: (controller) => controller.close(),
          }),
      };
    },
    headObject,
    async putObject(input) {
      const normalizedKey = normalizeStorageKey(input.key);
      const params = new URLSearchParams({
        name: normalizedKey,
        uploadType: "media",
      });

      // ifGenerationMatch=0 makes GCS refuse (412) when the object exists.
      if (input.keepExisting) {
        params.set("ifGenerationMatch", "0");
      }

      const response = await request(
        `${API_URL}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?${params}`,
        {
          body: input.body as BodyInit,
          headers: { "content-type": input.contentType },
          method: "POST",
        },
      );

      if (!response.ok && !(input.keepExisting && response.status === 412)) {
        await fail("write", normalizedKey, response);
      }

      await response.body?.cancel();

      return { bucketName: bucket, key: normalizedKey };
    },
  };
}
