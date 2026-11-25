import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import type pg from "pg";

import { openTestDatabase } from "./db/test-database.ts";
import {
  deleteScheduledEnvelope,
  ENVELOPE_DELETION_WAIT_DAYS,
  scheduleEnvelopeDeletion,
} from "./envelope-deletion.ts";
import { deleteEnvelopesAndFiles } from "./retention.ts";
import type { EmailService } from "./services/email.ts";
import { getRecipientCertificateKey } from "./services/storage-keys.ts";
import {
  createStorageService,
  type StorageService,
} from "./services/storage.ts";
import {
  listSystemAuditEvents,
  verifySystemAuditChain,
} from "./services/system-audit.ts";
import { verifyDocumentHash } from "./verify.ts";

// Verifying unchanged signed PDFs and audit certificates before and after an
// administrator's scheduled deletion, against a real Postgres. Run with
// `npm run test:db`.

const DAY = 24 * 60 * 60;
const WAIT = ENVELOPE_DELETION_WAIT_DAYS * DAY;

let database: pg.Pool;
let storageDir: string;
let storageService: StorageService;
const createdUsers: string[] = [];

before(async () => {
  database = await openTestDatabase();
  storageDir = await mkdtemp(path.join(tmpdir(), "signudoc-verify-"));
  Object.assign(process.env, {
    STORAGE_DRIVER: "local",
    STORAGE_LOCAL_DIR: storageDir,
  });
  storageService = createStorageService();
});

after(async () => {
  await database.query(`delete from public."user" where id = any($1)`, [
    createdUsers,
  ]);
  await database.end();
  await rm(storageDir, { force: true, recursive: true });
});

function randomSha256(): string {
  return randomBytes(32).toString("hex");
}

function createNoopOutbox(): EmailService {
  return {
    async send(message) {
      return { accepted: [message.to], rejected: [] };
    },
    async sendBatch(messages) {
      return Promise.all(messages.map((message) => this.send(message)));
    },
  };
}

async function createUser(role: "admin" | "user") {
  const id = randomUUID();
  const email = `${id}@example.test`;

  createdUsers.push(id);
  await database.query(
    `insert into public."user" (id, name, email, role) values ($1, 'Avery Admin', $2, $3)`,
    [id, email, role],
  );

  return { email, userId: id };
}

async function createFinishedEnvelope(
  userId: string,
  {
    status,
    title = "Lease Agreement",
  }: {
    status: "completed" | "declined" | "voided";
    title?: string;
  },
) {
  const envelopeId = randomUUID();
  const base = `users/${userId}/envelopes/${envelopeId}`;
  const keys = {
    evidence: `${base}/evidence/internal.pdf`,
    signed: `${base}/signed.pdf`,
    source: `${base}/source.pdf`,
  };
  const stored = [
    keys.source,
    keys.evidence,
    getRecipientCertificateKey(keys.evidence),
    ...(status === "completed" ? [keys.signed] : []),
  ];

  for (const key of stored) {
    await storageService.putObject({
      body: new Uint8Array([37, 80, 68, 70]),
      contentType: "application/pdf",
      key,
    });
  }

  const finishedAt = Math.floor(Date.now() / 1000) - 60;
  const sourcePdfHash = randomSha256();
  const signedPdfSha256 = status === "completed" ? randomSha256() : null;
  const evidenceSha256 = randomSha256();
  const recipientEvidenceSha256 = randomSha256();

  await database.query(
    `
      insert into envelopes (
        id, user_id, title, status, source_pdf_key, source_pdf_filename,
        source_pdf_size_bytes, page_count, source_pdf_hash, sent_at,
        completed_at, declined_at, voided_at, signed_pdf_key, evidence_key,
        signed_pdf_sha256, evidence_sha256, part11, recipient_evidence_sha256
      ) values (
        $1, $2, $3, $4, $5, 'lease.pdf', 4, 1, $6, $7,
        $8, $9, $10, $11, $12, $13, $14, false, $15
      )
    `,
    [
      envelopeId,
      userId,
      title,
      status,
      keys.source,
      sourcePdfHash,
      finishedAt - 100,
      status === "completed" ? finishedAt : null,
      status === "declined" ? finishedAt : null,
      status === "voided" ? finishedAt : null,
      status === "completed" ? keys.signed : null,
      keys.evidence,
      signedPdfSha256,
      evidenceSha256,
      recipientEvidenceSha256,
    ],
  );
  await database.query(
    `
      insert into signers (id, envelope_id, name, email, sign_order, role, status)
      values ($1, $2, 'Riley Recipient', 'riley@example.test', 1, 'signer', $3)
    `,
    [randomUUID(), envelopeId, status === "completed" ? "signed" : "declined"],
  );

  return {
    envelopeId,
    evidenceSha256,
    finishedAt,
    recipientEvidenceSha256,
    signedPdfSha256,
    sourcePdfHash,
    title,
  };
}

for (const status of ["completed", "declined", "voided"] as const) {
  test(`unchanged ${status} files still verify after scheduled deletion without leaking private deletion details`, async () => {
    const owner = await createUser("user");
    const admin = await createUser("admin");
    const envelope = await createFinishedEnvelope(owner.userId, { status });
    const now = Math.floor(Date.now() / 1000);

    // Before deletion: live envelope matches, unsigned original and altered files do not.
    if (envelope.signedPdfSha256) {
      assert.deepEqual(
        await verifyDocumentHash(envelope.signedPdfSha256, database),
        {
          approverCount: 0,
          envelopeDeleted: false,
          envelopeId: envelope.envelopeId,
          fileKind: "signed-document",
          finishedAt: envelope.finishedAt,
          match: true,
          signerCount: 1,
          status,
          title: envelope.title,
        },
      );
    }

    assert.deepEqual(
      await verifyDocumentHash(envelope.evidenceSha256, database),
      {
        approverCount: 0,
        envelopeDeleted: false,
        envelopeId: envelope.envelopeId,
        fileKind: "certificate",
        finishedAt: envelope.finishedAt,
        match: true,
        signerCount: 1,
        status,
        title: envelope.title,
      },
    );
    assert.deepEqual(
      await verifyDocumentHash(envelope.recipientEvidenceSha256, database),
      {
        approverCount: 0,
        envelopeDeleted: false,
        envelopeId: envelope.envelopeId,
        fileKind: "certificate",
        finishedAt: envelope.finishedAt,
        match: true,
        signerCount: 1,
        status,
        title: envelope.title,
      },
    );
    assert.deepEqual(
      await verifyDocumentHash(envelope.sourcePdfHash, database),
      { match: false },
    );

    // Schedule and execute deletion.
    await scheduleEnvelopeDeletion(
      envelope.envelopeId,
      {
        actor: admin,
        ipAddress: "203.0.113.10",
        reason: "Confidential HR cleanup",
        userAgent: "Test browser",
      },
      { database, emailService: createNoopOutbox(), now },
    );
    assert.equal(
      await deleteScheduledEnvelope(envelope.envelopeId, {
        database,
        now: now + WAIT,
        storageService,
      }),
      true,
    );

    const [auditEvent] = await listSystemAuditEvents({ limit: 1 }, database);

    assert.equal(auditEvent?.event, "envelope_deleted");
    assert.equal(auditEvent?.metadata?.envelopeId, envelope.envelopeId);
    assert.equal(
      auditEvent?.metadata?.signedPdfSha256,
      envelope.signedPdfSha256,
    );
    assert.equal(auditEvent?.metadata?.evidenceSha256, envelope.evidenceSha256);
    assert.equal(
      auditEvent?.metadata?.recipientEvidenceSha256,
      envelope.recipientEvidenceSha256,
    );
    assert.equal((await verifySystemAuditChain(database)).ok, true);

    // After deletion: signed PDF (if completed) and both certificates match as deleted.
    if (envelope.signedPdfSha256) {
      const signedResult = await verifyDocumentHash(
        envelope.signedPdfSha256,
        database,
      );

      assert.deepEqual(signedResult, {
        deletedAt: auditEvent.createdAt,
        envelopeDeleted: true,
        envelopeId: envelope.envelopeId,
        fileKind: "signed-document",
        finishedAt: envelope.finishedAt,
        match: true,
        status,
        title: envelope.title,
      });

      const serialized = JSON.stringify(signedResult);

      assert.equal(serialized.includes(admin.email), false);
      assert.equal(serialized.includes(owner.email), false);
      assert.equal(serialized.includes("Confidential HR cleanup"), false);
      assert.equal(serialized.includes(envelope.sourcePdfHash), false);
      assert.equal(serialized.includes(envelope.evidenceSha256), false);
    }

    for (const certHash of [
      envelope.evidenceSha256,
      envelope.recipientEvidenceSha256,
    ]) {
      assert.deepEqual(await verifyDocumentHash(certHash, database), {
        deletedAt: auditEvent.createdAt,
        envelopeDeleted: true,
        envelopeId: envelope.envelopeId,
        fileKind: "certificate",
        finishedAt: envelope.finishedAt,
        match: true,
        status,
        title: envelope.title,
      });
    }

    // Unsigned source PDF and tampered/unknown files still return no match.
    assert.deepEqual(
      await verifyDocumentHash(envelope.sourcePdfHash, database),
      { match: false },
    );
    assert.deepEqual(await verifyDocumentHash(randomSha256(), database), {
      match: false,
    });
  });
}

test("envelopes deleted without an envelope_deleted audit event return no match", async () => {
  const owner = await createUser("user");
  const envelope = await createFinishedEnvelope(owner.userId, {
    status: "completed",
  });

  assert.equal(
    await deleteEnvelopesAndFiles(
      [envelope.envelopeId],
      database,
      storageService,
    ),
    1,
  );
  assert.deepEqual(
    await verifyDocumentHash(envelope.signedPdfSha256 ?? "", database),
    { match: false },
  );
  assert.deepEqual(
    await verifyDocumentHash(envelope.evidenceSha256, database),
    {
      match: false,
    },
  );
  assert.deepEqual(
    await verifyDocumentHash(envelope.recipientEvidenceSha256, database),
    { match: false },
  );
});

test("partial indexes exist for envelope_deleted SHA-256 fallback lookups", async () => {
  const { rows } = await database.query<{ indexname: string }>(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename = 'system_audit_events'
        AND indexname = ANY($1::text[])
      ORDER BY indexname
    `,
    [
      [
        "idx_system_audit_events_deleted_evidence_sha256",
        "idx_system_audit_events_deleted_recipient_evidence_sha256",
        "idx_system_audit_events_deleted_signed_pdf_sha256",
      ],
    ],
  );

  assert.deepEqual(
    rows.map((row) => row.indexname),
    [
      "idx_system_audit_events_deleted_evidence_sha256",
      "idx_system_audit_events_deleted_recipient_evidence_sha256",
      "idx_system_audit_events_deleted_signed_pdf_sha256",
    ],
  );
});
