import assert from "node:assert/strict";
import { test } from "node:test";

import type { DbExecutor } from "./db/connection.ts";
import { verifyDocumentHash, verifyRequestSchema } from "./verify.ts";
import { formatVerifyVerdict } from "./verify-result.ts";

const SIGNED_HASH = "1".repeat(64);
const EVIDENCE_HASH = "2".repeat(64);
const RECIPIENT_EVIDENCE_HASH = "3".repeat(64);
const SOURCE_HASH = "4".repeat(64);
const UNKNOWN_HASH = "f".repeat(64);

type RecordedQuery = { text: string; values: readonly unknown[] };

function createMockDb(
  handler: (text: string, values: readonly unknown[]) => unknown[],
): { db: DbExecutor; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const db = {
    async query(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values });
      const rows = handler(text, values);

      return { rowCount: rows.length, rows };
    },
  } as unknown as DbExecutor;

  return { db, queries };
}

test("verifyRequestSchema accepts and normalizes 64-character hex hashes", () => {
  const upper = "ABCDEF0123456789".repeat(4);
  const parsed = verifyRequestSchema.safeParse({ sha256: `  ${upper}  ` });

  assert.equal(parsed.success, true);
  assert.equal(parsed.data?.sha256, upper.toLowerCase());

  assert.equal(verifyRequestSchema.safeParse({ sha256: "" }).success, false);
  assert.equal(
    verifyRequestSchema.safeParse({ sha256: "a".repeat(63) }).success,
    false,
  );
  assert.equal(
    verifyRequestSchema.safeParse({ sha256: "g".repeat(64) }).success,
    false,
  );
});

test("verifyDocumentHash rejects non-SHA-256 values without querying the database", async () => {
  const { db, queries } = createMockDb(() => {
    throw new Error("should not query");
  });

  assert.deepEqual(await verifyDocumentHash("", db), { match: false });
  assert.deepEqual(await verifyDocumentHash("not-a-hash", db), {
    match: false,
  });
  assert.equal(queries.length, 0);
});

test("verifyDocumentHash returns a live signed-document match without hitting system_audit_events", async () => {
  const { db, queries } = createMockDb((text) => {
    if (text.includes("FROM envelopes")) {
      return [
        {
          approverCount: 1,
          completedAt: 1_764_000_000,
          declinedAt: null,
          envelopeId: "env-live-1",
          evidenceSha256: EVIDENCE_HASH,
          recipientEvidenceSha256: RECIPIENT_EVIDENCE_HASH,
          signedPdfSha256: SIGNED_HASH,
          signerCount: 2,
          status: "completed",
          title: "Master Services Agreement",
          voidedAt: null,
        },
      ];
    }

    throw new Error("system_audit_events should not be queried for live match");
  });

  const result = await verifyDocumentHash(
    `  ${SIGNED_HASH.toUpperCase()} `,
    db,
  );

  assert.deepEqual(result, {
    approverCount: 1,
    envelopeDeleted: false,
    envelopeId: "env-live-1",
    fileKind: "signed-document",
    finishedAt: 1_764_000_000,
    match: true,
    signerCount: 2,
    status: "completed",
    title: "Master Services Agreement",
  });
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0]?.values, [SIGNED_HASH]);
});

test("verifyDocumentHash identifies both sender and recipient certificates for live envelopes", async () => {
  for (const hash of [EVIDENCE_HASH, RECIPIENT_EVIDENCE_HASH]) {
    const { db } = createMockDb(() => [
      {
        approverCount: 0,
        completedAt: null,
        declinedAt: 1_764_000_500,
        envelopeId: "env-declined-1",
        evidenceSha256: EVIDENCE_HASH,
        recipientEvidenceSha256: RECIPIENT_EVIDENCE_HASH,
        signedPdfSha256: null,
        signerCount: 1,
        status: "declined",
        title: "NDA",
        voidedAt: null,
      },
    ]);

    const result = await verifyDocumentHash(hash, db);

    assert.deepEqual(result, {
      approverCount: 0,
      envelopeDeleted: false,
      envelopeId: "env-declined-1",
      fileKind: "certificate",
      finishedAt: 1_764_000_500,
      match: true,
      signerCount: 1,
      status: "declined",
      title: "NDA",
    });
  }
});

test("verifyDocumentHash falls back to envelope_deleted audit events for deleted signed PDFs and certificates", async () => {
  const cases = [
    {
      expectedFileKind: "signed-document" as const,
      hash: SIGNED_HASH,
      isSignedDocument: true,
      status: "completed" as const,
    },
    {
      expectedFileKind: "certificate" as const,
      hash: EVIDENCE_HASH,
      isSignedDocument: false,
      status: "completed" as const,
    },
    {
      expectedFileKind: "certificate" as const,
      hash: RECIPIENT_EVIDENCE_HASH,
      isSignedDocument: false,
      status: "declined" as const,
    },
    {
      expectedFileKind: "certificate" as const,
      hash: EVIDENCE_HASH,
      isSignedDocument: false,
      status: "voided" as const,
    },
  ];

  for (const testCase of cases) {
    const { db, queries } = createMockDb((text) => {
      if (text.includes("FROM envelopes")) {
        return [];
      }

      if (text.includes("FROM system_audit_events")) {
        return [
          {
            deletedAt: 1_765_209_600,
            envelopeId: "env-deleted-1",
            finishedAt: 1_764_000_000,
            isSignedDocument: testCase.isSignedDocument,
            status: testCase.status,
            title: "Consulting Agreement",
          },
        ];
      }

      return [];
    });

    const result = await verifyDocumentHash(testCase.hash, db);

    assert.deepEqual(result, {
      deletedAt: 1_765_209_600,
      envelopeDeleted: true,
      envelopeId: "env-deleted-1",
      fileKind: testCase.expectedFileKind,
      finishedAt: 1_764_000_000,
      match: true,
      status: testCase.status,
      title: "Consulting Agreement",
    });
    assert.equal(queries.length, 2);
    assert.deepEqual(queries[1]?.values, [testCase.hash]);
  }
});

test("deleted-envelope lookup never selects PII, admin-only fields, or sourcePdfHash", async () => {
  const { db, queries } = createMockDb((text) => {
    if (text.includes("FROM system_audit_events")) {
      // Simulate extra columns to verify the return object is strictly allowlisted.
      return [
        {
          actorEmail: "admin@example.test",
          actorUserId: "admin-1",
          deletedAt: 1_765_209_600,
          envelopeId: "env-deleted-privacy",
          finishedAt: 1_764_000_000,
          isSignedDocument: true,
          ownerEmail: "sender@example.test",
          ownerUserId: "user-1",
          part11: true,
          reason: "Sensitive legal settlement",
          requestedAt: 1_764_500_000,
          senderNotifiedAt: 1_764_500_010,
          sourcePdfHash: SOURCE_HASH,
          status: "completed",
          title: "Agreement",
        },
      ];
    }

    return [];
  });

  const result = await verifyDocumentHash(SIGNED_HASH, db);
  const auditSql = queries[1]?.text ?? "";

  assert.match(auditSql, /event = 'envelope_deleted'/);
  assert.match(auditSql, /metadata->>'signedPdfSha256' = \$1/);
  assert.match(auditSql, /metadata->>'evidenceSha256' = \$1/);
  assert.match(auditSql, /metadata->>'recipientEvidenceSha256' = \$1/);
  assert.match(auditSql, /ORDER BY sequence DESC/);

  for (const forbidden of [
    "sourcePdfHash",
    "actor_email",
    "actor_user_id",
    "target_user_id",
    "ip_address",
    "user_agent",
    "ownerEmail",
    "ownerUserId",
    "reason",
    "part11",
    "requestedAt",
    "senderNotifiedAt",
  ]) {
    assert.equal(
      auditSql.includes(forbidden),
      false,
      `SQL must not reference ${forbidden}`,
    );
  }

  assert.deepEqual(Object.keys(result).sort(), [
    "deletedAt",
    "envelopeDeleted",
    "envelopeId",
    "fileKind",
    "finishedAt",
    "match",
    "status",
    "title",
  ]);
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes("admin@example.test"), false);
  assert.equal(serialized.includes("sender@example.test"), false);
  assert.equal(serialized.includes("Sensitive legal settlement"), false);
  assert.equal(serialized.includes(SOURCE_HASH), false);
});

test("verifyDocumentHash handles partial or legacy envelope_deleted metadata cleanly", async () => {
  const { db } = createMockDb((text) => {
    if (text.includes("FROM system_audit_events")) {
      return [
        {
          deletedAt: "1765209600",
          envelopeId: "   ",
          finishedAt: "not-a-timestamp",
          isSignedDocument: false,
          status: "unexpected",
          title: null,
        },
      ];
    }

    return [];
  });

  const result = await verifyDocumentHash(EVIDENCE_HASH, db);

  assert.deepEqual(result, {
    deletedAt: 1_765_209_600,
    envelopeDeleted: true,
    envelopeId: null,
    fileKind: "certificate",
    finishedAt: null,
    match: true,
    status: null,
    title: null,
  });
});

test("verifyDocumentHash returns match false when neither envelopes nor envelope_deleted matches", async () => {
  const { db, queries } = createMockDb(() => []);

  assert.deepEqual(await verifyDocumentHash(UNKNOWN_HASH, db), {
    match: false,
  });
  assert.equal(queries.length, 2);
});

test("formatVerifyVerdict formats live matches with signer and approver counts", () => {
  const verdict = formatVerifyVerdict({
    approverCount: 2,
    envelopeDeleted: false,
    envelopeId: "env-1",
    fileKind: "signed-document",
    finishedAt: 1_764_000_000,
    match: true,
    signerCount: 1,
    status: "completed",
    title: "Lease",
  });

  assert.equal(verdict.tone, "success");
  assert.equal(
    verdict.heading,
    "This file is unchanged. It is the signed document this site produced for \u201cLease\u201d.",
  );
  assert.match(
    verdict.detail,
    /^The envelope was completed on .+ UTC with 1 signer and 2 approvers\. Envelope ID env-1\.$/,
  );
});

test("formatVerifyVerdict confirms origin and notes deletion for deleted envelopes without false claims", () => {
  const signedVerdict = formatVerifyVerdict({
    deletedAt: 1_765_209_600,
    envelopeDeleted: true,
    envelopeId: "env-deleted-2",
    fileKind: "signed-document",
    finishedAt: 1_764_000_000,
    match: true,
    status: "completed",
    title: "Lease",
  });

  assert.equal(signedVerdict.tone, "success");
  assert.equal(
    signedVerdict.heading,
    "This file is unchanged. It is the signed document this site produced for \u201cLease\u201d.",
  );
  assert.match(signedVerdict.detail, /The envelope was completed on .+ UTC\./);
  assert.match(
    signedVerdict.detail,
    /Its envelope record was deleted from this site on .+ UTC\./,
  );
  assert.match(signedVerdict.detail, /Envelope ID env-deleted-2\.$/);
  assert.doesNotMatch(
    signedVerdict.detail,
    /0 signers|kept on this site|did not produce|files were deleted/i,
  );

  const minimalCertVerdict = formatVerifyVerdict({
    deletedAt: null,
    envelopeDeleted: true,
    envelopeId: null,
    fileKind: "certificate",
    finishedAt: null,
    match: true,
    status: null,
    title: null,
  });

  assert.equal(minimalCertVerdict.tone, "success");
  assert.equal(
    minimalCertVerdict.heading,
    "This file is unchanged. It is the audit certificate this site produced.",
  );
  assert.equal(
    minimalCertVerdict.detail,
    "Its envelope record has since been deleted from this site.",
  );
});

test("formatVerifyVerdict gives an accurate no-match message without a false negative origin claim", () => {
  const verdict = formatVerifyVerdict({ match: false });

  assert.equal(verdict.tone, "danger");
  assert.equal(verdict.heading, "No match.");
  assert.doesNotMatch(
    verdict.detail,
    /This site did not produce this exact file/i,
  );
  assert.doesNotMatch(verdict.detail, /copy kept on this site/i);
  assert.match(verdict.detail, /no record of this exact file/i);
  assert.match(verdict.detail, /unsigned copy/i);
  assert.match(verdict.detail, /record that has been removed/i);
  assert.match(verdict.detail, /digital seal in a PDF reader/i);
});
