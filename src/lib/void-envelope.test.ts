import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { PDFDocument } from "pdf-lib";
import type { Pool, PoolClient, QueryResult } from "pg";

import { replaceDbPoolForTests } from "./db/connection.ts";
import { EnvelopeMutationError, voidSentEnvelope } from "./envelopes.ts";
import { EMAIL_NOT_CONNECTED_MESSAGE } from "./services/email.ts";
import { resetSealIdentityCache } from "./services/seal-identity.ts";
import type { StorageService } from "./services/storage.ts";
import type * as RouteModule from "./api/route.ts";

// Resolve next/server when running plain node --test, matching route.dbtest.ts.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (/^next\/[a-z-]+$/.test(specifier)) {
      return nextResolve(`${specifier}.js`, context);
    }

    return nextResolve(specifier, context);
  },
});

let routeModule: typeof RouteModule;
let workDir: string;
let outboxDir: string;
let sourcePdfBytes: Uint8Array;
let sourcePdfHash: string;
let replacedPool: Pool | null = null;

type EnvelopeState = {
  completedAt: number | null;
  createdAt: number;
  declinedAt: number | null;
  evidenceKey: string | null;
  expiresAt: number | null;
  id: string;
  pageCount: number;
  part11: boolean;
  reminderIntervalDays: number | null;
  sentAt: number | null;
  signatureLevel: "advanced" | "qualified" | "simple";
  signatureProvider: string | null;
  signedPdfKey: string | null;
  sourcePdfFilename: string;
  sourcePdfHash: string;
  sourcePdfKey: string;
  sourcePdfSizeBytes: number;
  status: "draft" | "sent" | "completed" | "declined" | "voided";
  title: string;
  updatedAt: number;
  userId: string;
  voidedAt: number | null;
};

type SignerState = {
  createdAt: number;
  declineReason: string | null;
  declinedAt: number | null;
  email: string;
  envelopeId: string;
  id: string;
  lastNotifiedAt: number | null;
  lastNudgedAt: number | null;
  name: string;
  role: "signer" | "approver";
  signatureMeaning: null;
  signedAt: number | null;
  signOrder: number;
  signingStep: number;
  signingTokenExpiresAt: number | null;
  signingTokenHash: string | null;
  spentSigningTokenHash: string | null;
  status: "pending" | "notified" | "signed" | "declined";
  turnStartedAt: number | null;
  updatedAt: number;
};

type AuditRow = {
  actorEmail: string | null;
  actorType: string;
  createdAt: number;
  envelopeId: string;
  event: string;
  id: string;
  ipAddress: string | null;
  metadata: Record<string, unknown> | null;
  rowHash: string;
  sequence: number;
  userAgent: string | null;
};

function queryResult<T>(rows: T[], rowCount = rows.length): QueryResult {
  return {
    command: "",
    fields: [],
    oid: 0,
    rowCount,
    rows,
  } as unknown as QueryResult;
}

function createFakeDb(input: {
  envelope: EnvelopeState | null;
  signers: SignerState[];
}) {
  let envelope = input.envelope ? { ...input.envelope } : null;
  const signers = input.signers.map((signer) => ({ ...signer }));
  const auditEvents: AuditRow[] = [];
  let sealKey: {
    certificatePem: string;
    encryptedPrivateKey: string;
    id: string;
  } | null = null;
  let transactionCount = 0;

  async function execute(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult> {
    const sql = text.replace(/\s+/g, " ").trim();

    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
      return queryResult([], 0);
    }

    if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
      return queryResult([{ pg_advisory_xact_lock: "" }], 1);
    }

    if (sql.toLowerCase().includes("app_settings")) {
      return queryResult([
        {
          allowed_email_domains: [],
          brand_color: null,
          consent_disclosure: null,
          email_ready_at: null,
          logo_hash: null,
          organization_name: "Acme Test",
          part11_mode: false,
          privacy_url: null,
          require_two_factor: false,
          retention_days: null,
          sender_address: null,
          session_idle_minutes: null,
          session_max_hours: null,
          setup_completed_at: 1_700_000_000,
          signup_mode: "open",
          support_address: null,
          terms_url: null,
        },
      ]);
    }

    if (sql.includes("FROM seal_keys")) {
      return queryResult(sealKey ? [sealKey] : []);
    }

    if (sql.startsWith("UPDATE seal_keys")) {
      sealKey = null;
      return queryResult([], 0);
    }

    if (sql.startsWith("INSERT INTO seal_keys")) {
      sealKey = {
        certificatePem: String(values[1]),
        encryptedPrivateKey: String(values[2]),
        id: String(values[0]),
      };
      return queryResult([], 1);
    }

    if (sql.includes("SELECT status FROM envelopes")) {
      if (
        envelope &&
        envelope.id === values[0] &&
        envelope.userId === values[1]
      ) {
        return queryResult([{ status: envelope.status }]);
      }

      return queryResult([]);
    }

    if (sql.includes("FROM envelopes WHERE id = $1 AND user_id = $2")) {
      if (
        envelope &&
        envelope.id === values[0] &&
        envelope.userId === values[1]
      ) {
        return queryResult([{ ...envelope }]);
      }

      return queryResult([]);
    }

    if (sql.includes("SELECT id, status FROM signers")) {
      return queryResult(
        signers
          .filter((signer) => signer.envelopeId === values[0])
          .map((signer) => ({ id: signer.id, status: signer.status })),
      );
    }

    if (sql.includes("FROM signers WHERE envelope_id IN")) {
      return queryResult(
        signers
          .filter((signer) => values.includes(signer.envelopeId))
          .map((signer) => ({ ...signer })),
      );
    }

    if (sql.startsWith("UPDATE envelopes SET status = 'voided'")) {
      if (
        envelope &&
        envelope.id === values[3] &&
        envelope.userId === values[4] &&
        envelope.status === "sent"
      ) {
        envelope = {
          ...envelope,
          evidenceKey: String(values[0]),
          status: "voided",
          updatedAt: Number(values[2]),
          voidedAt: Number(values[1]),
        };
        return queryResult([], 1);
      }

      return queryResult([], 0);
    }

    if (
      sql.startsWith(
        "UPDATE signers SET spent_signing_token_hash = signing_token_hash",
      )
    ) {
      let updated = 0;

      for (const signer of signers) {
        if (signer.envelopeId === values[1] && signer.status === "notified") {
          signer.spentSigningTokenHash = signer.signingTokenHash;
          signer.signingTokenHash = null;
          signer.signingTokenExpiresAt = null;
          signer.updatedAt = Number(values[0]);
          updated += 1;
        }
      }

      return queryResult([], updated);
    }

    if (
      sql.includes('SELECT sequence, row_hash AS "rowHash" FROM audit_events')
    ) {
      const latest = auditEvents
        .filter((row) => row.envelopeId === values[0])
        .sort((left, right) => right.sequence - left.sequence)[0];

      return queryResult(
        latest ? [{ rowHash: latest.rowHash, sequence: latest.sequence }] : [],
      );
    }

    if (sql.includes("FROM audit_events WHERE envelope_id = $1")) {
      return queryResult(
        auditEvents
          .filter((row) => row.envelopeId === values[0])
          .sort((left, right) => left.sequence - right.sequence)
          .map((row) => ({ ...row })),
      );
    }

    if (sql.startsWith("INSERT INTO audit_events")) {
      auditEvents.push({
        actorEmail: (values[4] as string | null) ?? null,
        actorType: String(values[3]),
        createdAt: Number(values[8]),
        envelopeId: String(values[1]),
        event: String(values[2]),
        id: String(values[0]),
        ipAddress: (values[5] as string | null) ?? null,
        metadata: (values[7] as Record<string, unknown> | null) ?? null,
        rowHash: String(values[11]),
        sequence: Number(values[9]),
        userAgent: (values[6] as string | null) ?? null,
      });
      return queryResult([], 1);
    }

    if (sql.startsWith("INSERT INTO webhook_deliveries")) {
      return queryResult([], 0);
    }

    throw new Error(`Unexpected SQL in void-envelope.test.ts: ${sql}`);
  }

  const client = {
    query: (text: string, values?: unknown[]) => execute(text, values),
    release: () => undefined,
  } as unknown as PoolClient;

  const pool = {
    connect: async () => {
      transactionCount += 1;
      return client;
    },
    query: (text: string, values?: unknown[]) => execute(text, values),
    totalCount: 1,
  } as unknown as Pool;

  return {
    auditEvents,
    getEnvelope: () => envelope,
    getSigners: () => signers,
    getTransactionCount: () => transactionCount,
    pool,
  };
}

function createFakeStorage() {
  const objects = new Map<string, Uint8Array>();
  let headCalls = 0;

  const service: StorageService = {
    async deleteObject(key) {
      objects.delete(key);
    },
    async getObject(key) {
      const body = objects.get(key);

      if (!body) {
        throw new Error(`Missing object: ${key}`);
      }

      return {
        body,
        bucketName: "test-bucket",
        contentLength: body.byteLength,
        contentType: "application/pdf",
        key,
      };
    },
    async getObjectStream() {
      throw new Error("Not implemented");
    },
    async headObject(key) {
      headCalls += 1;
      const body = objects.get(key);

      return body
        ? {
            bucketName: "test-bucket",
            contentLength: body.byteLength,
            contentType: "application/pdf",
            exists: true,
            key,
          }
        : {
            bucketName: "test-bucket",
            exists: false,
            key,
          };
    },
    async putObject({ body, key }) {
      objects.set(key, body);
      return {
        bucketName: "test-bucket",
        key,
      };
    },
  };

  return {
    getHeadCalls: () => headCalls,
    objects,
    service,
  };
}

function makeFixture(
  overrides: {
    envelope?: Partial<EnvelopeState>;
    signerStatuses?: Array<"pending" | "notified" | "signed">;
  } = {},
) {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const now = Math.floor(Date.now() / 1000) - 60;
  const sourcePdfKey = `envelopes/${userId}/${envelopeId}/source.pdf`;
  const envelope: EnvelopeState = {
    completedAt: null,
    createdAt: now,
    declinedAt: null,
    evidenceKey: null,
    expiresAt: now + 86_400,
    id: envelopeId,
    pageCount: 1,
    part11: false,
    reminderIntervalDays: null,
    sentAt: now,
    signatureLevel: "simple",
    signatureProvider: null,
    signedPdfKey: null,
    sourcePdfFilename: "agreement.pdf",
    sourcePdfHash,
    sourcePdfKey,
    sourcePdfSizeBytes: sourcePdfBytes.byteLength,
    status: "sent",
    title: "Service agreement",
    updatedAt: now,
    userId,
    voidedAt: null,
    ...overrides.envelope,
  };
  const statuses = overrides.signerStatuses ?? ["notified"];
  const signers: SignerState[] = statuses.map((status, index) => ({
    createdAt: now,
    declineReason: null,
    declinedAt: null,
    email: `signer-${String(index + 1)}@example.test`,
    envelopeId,
    id: randomUUID(),
    lastNotifiedAt: status === "pending" ? null : now,
    lastNudgedAt: null,
    name: `Signer ${String(index + 1)}`,
    role: "signer",
    signatureMeaning: null,
    signedAt: status === "signed" ? now : null,
    signOrder: index + 1,
    signingStep: index + 1,
    signingTokenExpiresAt: status === "notified" ? now + 86_400 : null,
    signingTokenHash: status === "notified" ? "b".repeat(64) : null,
    spentSigningTokenHash: null,
    status,
    turnStartedAt: status === "pending" ? null : now,
    updatedAt: now,
  }));

  return { envelope, signers };
}

async function withEmailEnv<T>(
  env: {
    EMAIL_CAPTURE_DIR?: string;
    EMAIL_DRIVER?: string;
    RESEND_API_KEY?: string;
  },
  run: () => Promise<T>,
): Promise<T> {
  const keys = ["EMAIL_CAPTURE_DIR", "EMAIL_DRIVER", "RESEND_API_KEY"] as const;
  const previous = new Map<string, string | undefined>(
    keys.map((key) => [key, process.env[key]]),
  );

  for (const key of keys) {
    const nextValue = env[key];

    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

before(async () => {
  routeModule = await import("./api/route.ts");
  workDir = await mkdtemp(path.join(tmpdir(), "signudoc-void-unit-"));
  outboxDir = path.join(workDir, "outbox");

  const doc = await PDFDocument.create();

  doc.addPage([612, 792]);
  sourcePdfBytes = await doc.save();
  sourcePdfHash = createHash("sha256").update(sourcePdfBytes).digest("hex");
});

after(async () => {
  resetSealIdentityCache();

  if (replacedPool) {
    replaceDbPoolForTests(replacedPool);
  }

  await rm(workDir, { force: true, recursive: true });
});

test("voiding a sent envelope with unconfigured email rejects with 503 and leaves state unchanged (issue #225)", async () => {
  const fixture = makeFixture({ signerStatuses: ["notified"] });
  const db = createFakeDb(fixture);
  const storage = createFakeStorage();

  storage.objects.set(fixture.envelope.sourcePdfKey, sourcePdfBytes);
  replacedPool = replaceDbPoolForTests(db.pool) ?? replacedPool;

  let caught: unknown;

  await withEmailEnv({}, async () => {
    try {
      await voidSentEnvelope(
        fixture.envelope.userId,
        fixture.envelope.id,
        { senderEmail: "sam@example.test", senderName: "Sam Sender" },
        { database: db.pool, storageService: storage.service },
      );
    } catch (error) {
      caught = error;
    }
  });

  assert.ok(caught instanceof EnvelopeMutationError);
  assert.equal(caught.statusCode, 503);
  assert.equal(caught.message, EMAIL_NOT_CONNECTED_MESSAGE);

  // Refused before touching storage or opening a write transaction.
  assert.equal(storage.getHeadCalls(), 0);
  assert.equal(db.getTransactionCount(), 0);
  assert.equal(db.getEnvelope()?.status, "sent");
  assert.equal(db.getEnvelope()?.voidedAt, null);
  assert.equal(db.getSigners()[0]?.signingTokenHash, "b".repeat(64));
  assert.equal(db.auditEvents.length, 0);

  // Public API /api/v1/envelopes/{id}/void maps this error to HTTP 503.
  const apiResponse = routeModule.apiErrorFor(caught);

  assert.ok(apiResponse);
  assert.equal(apiResponse.status, 503);
  assert.equal(apiResponse.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await apiResponse.json(), {
    error: {
      code: "internal_error",
      message: EMAIL_NOT_CONNECTED_MESSAGE,
    },
  });
});

test("voiding a sent envelope succeeds with EMAIL_DRIVER=capture and notifies invited signers", async () => {
  const fixture = makeFixture({
    signerStatuses: ["signed", "notified", "pending"],
  });
  const db = createFakeDb(fixture);
  const storage = createFakeStorage();

  storage.objects.set(fixture.envelope.sourcePdfKey, sourcePdfBytes);
  replacedPool = replaceDbPoolForTests(db.pool) ?? replacedPool;

  const result = await withEmailEnv(
    { EMAIL_CAPTURE_DIR: outboxDir, EMAIL_DRIVER: "capture" },
    () =>
      voidSentEnvelope(
        fixture.envelope.userId,
        fixture.envelope.id,
        { senderEmail: "sam@example.test", senderName: "Sam Sender" },
        { database: db.pool, storageService: storage.service },
      ),
  );

  assert.equal(result.envelopeId, fixture.envelope.id);
  assert.ok(result.voidedAt > 0);
  assert.equal(db.getEnvelope()?.status, "voided");
  assert.equal(db.getEnvelope()?.voidedAt, result.voidedAt);
  assert.equal(db.getSigners()[1]?.signingTokenHash, null);
  assert.equal(db.getSigners()[1]?.spentSigningTokenHash, "b".repeat(64));
  assert.equal(
    db.auditEvents.filter((event) => event.event === "voided").length,
    1,
  );
  assert.equal(
    db.auditEvents.filter((event) => event.event === "email_sent").length,
    2,
  );

  const capturedFiles = (await readdir(outboxDir)).filter((file) =>
    file.endsWith(".json"),
  );
  const captured = await Promise.all(
    capturedFiles.map(
      async (file) =>
        JSON.parse(await readFile(path.join(outboxDir, file), "utf8")) as {
          template: string;
          to: string[];
        },
    ),
  );
  const recipients = captured
    .filter((message) => message.template === "void_notification")
    .flatMap((message) => message.to)
    .sort();

  assert.deepEqual(recipients, [
    "signer-1@example.test",
    "signer-2@example.test",
  ]);
});

test("voiding does not require email setup when no signer was invited yet", async () => {
  const fixture = makeFixture({ signerStatuses: ["pending"] });
  const db = createFakeDb(fixture);
  const storage = createFakeStorage();

  storage.objects.set(fixture.envelope.sourcePdfKey, sourcePdfBytes);
  replacedPool = replaceDbPoolForTests(db.pool) ?? replacedPool;

  const result = await withEmailEnv({}, () =>
    voidSentEnvelope(
      fixture.envelope.userId,
      fixture.envelope.id,
      { senderEmail: "sam@example.test", senderName: "Sam Sender" },
      { database: db.pool, storageService: storage.service },
    ),
  );

  assert.equal(result.envelopeId, fixture.envelope.id);
  assert.equal(db.getEnvelope()?.status, "voided");
  assert.equal(db.getEnvelope()?.voidedAt, result.voidedAt);
  assert.equal(
    db.auditEvents.filter((event) => event.event === "email_sent").length,
    0,
  );
});

test("voiding still validates envelope state and Part 11 reason before checking email setup", async () => {
  const draftFixture = makeFixture({ envelope: { status: "draft" } });
  const draftDb = createFakeDb(draftFixture);

  await withEmailEnv({}, async () => {
    await assert.rejects(
      voidSentEnvelope(
        draftFixture.envelope.userId,
        draftFixture.envelope.id,
        { senderEmail: "sam@example.test", senderName: "Sam Sender" },
        { database: draftDb.pool },
      ),
      (error: unknown) =>
        error instanceof EnvelopeMutationError && error.statusCode === 409,
    );
  });

  const part11Fixture = makeFixture({ envelope: { part11: true } });
  const part11Db = createFakeDb(part11Fixture);

  await withEmailEnv({}, async () => {
    await assert.rejects(
      voidSentEnvelope(
        part11Fixture.envelope.userId,
        part11Fixture.envelope.id,
        { senderEmail: "sam@example.test", senderName: "Sam Sender" },
        { database: part11Db.pool },
      ),
      (error: unknown) =>
        error instanceof EnvelopeMutationError && error.statusCode === 400,
    );
  });
});
