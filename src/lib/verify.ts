import { z } from "zod";

import { getDb, queryOne, type DbExecutor } from "./db/connection.ts";
import type {
  VerifyEnvelopeStatus,
  VerifyFileKind,
  VerifyResult,
} from "./verify-result.ts";

export type { VerifyEnvelopeStatus, VerifyFileKind, VerifyResult };

// The Verify page: anyone holding a copy of a finished document or
// certificate can check that it is exactly the file this install produced.
// The browser hashes the file; only the hash is sent. A match says nothing
// the holder could not already read in the file itself.
//
// When an administrator deletes a finished envelope after the waiting period,
// its row leaves `envelopes` while `system_audit_events` keeps the
// `envelope_deleted` event with the finished file fingerprints. Checking that
// event as a fallback prevents a false negative on an unchanged file while
// reading only non-PII record fields (never sender/admin emails, deletion
// reason, or the unsigned source PDF hash).

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export const verifyRequestSchema = z.object({
  sha256: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SHA256_PATTERN, "Expected a SHA-256 value."),
});

type VerifyRow = {
  approverCount: number;
  completedAt: number | null;
  declinedAt: number | null;
  envelopeId: string;
  evidenceSha256: string | null;
  recipientEvidenceSha256: string | null;
  signedPdfSha256: string | null;
  signerCount: number;
  status: VerifyEnvelopeStatus;
  title: string;
  voidedAt: number | null;
};

type DeletedVerifyRow = {
  deletedAt: unknown;
  envelopeId: unknown;
  finishedAt: unknown;
  isSignedDocument: unknown;
  status: unknown;
  title: unknown;
};

function parseFinishedStatus(value: unknown): VerifyEnvelopeStatus | null {
  return value === "completed" || value === "declined" || value === "voided"
    ? value
    : null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value, 10);

    return Number.isSafeInteger(parsed) ? parsed : null;
  }

  return null;
}

function parseNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

export async function verifyDocumentHash(
  sha256: string,
  database: DbExecutor = getDb(),
): Promise<VerifyResult> {
  const normalizedSha256 = sha256.trim().toLowerCase();

  if (!SHA256_PATTERN.test(normalizedSha256)) {
    return { match: false };
  }

  const row = await queryOne<VerifyRow>(
    database,
    `
      SELECT
        e.id AS "envelopeId",
        e.title,
        e.status,
        e.completed_at AS "completedAt",
        e.declined_at AS "declinedAt",
        e.voided_at AS "voidedAt",
        e.signed_pdf_sha256 AS "signedPdfSha256",
        e.evidence_sha256 AS "evidenceSha256",
        e.recipient_evidence_sha256 AS "recipientEvidenceSha256",
        (SELECT count(*)::int FROM signers s WHERE s.envelope_id = e.id AND s.role = 'signer') AS "signerCount",
        (SELECT count(*)::int FROM signers s WHERE s.envelope_id = e.id AND s.role = 'approver') AS "approverCount"
      FROM envelopes e
      WHERE e.signed_pdf_sha256 = $1
         OR e.evidence_sha256 = $1
         OR e.recipient_evidence_sha256 = $1
      LIMIT 1
    `,
    [normalizedSha256],
  );

  if (row) {
    return {
      approverCount: row.approverCount,
      envelopeDeleted: false,
      envelopeId: row.envelopeId,
      fileKind:
        row.signedPdfSha256 === normalizedSha256
          ? "signed-document"
          : "certificate",
      finishedAt: row.completedAt ?? row.declinedAt ?? row.voidedAt,
      match: true,
      signerCount: row.signerCount,
      status: row.status,
      title: row.title,
    };
  }

  // Only select the public fields that live /verify already returns plus when
  // the record was deleted — never actor/owner emails, deletion reason, or
  // sibling file hashes, and never match the unsigned sourcePdfHash.
  const deletedRow = await queryOne<DeletedVerifyRow>(
    database,
    `
      SELECT
        created_at AS "deletedAt",
        metadata->>'envelopeId' AS "envelopeId",
        metadata->>'title' AS "title",
        metadata->>'status' AS "status",
        metadata->'finishedAt' AS "finishedAt",
        COALESCE(metadata->>'signedPdfSha256' = $1, false) AS "isSignedDocument"
      FROM system_audit_events
      WHERE event = 'envelope_deleted'
        AND (
          metadata->>'signedPdfSha256' = $1
          OR metadata->>'evidenceSha256' = $1
          OR metadata->>'recipientEvidenceSha256' = $1
        )
      ORDER BY sequence DESC
      LIMIT 1
    `,
    [normalizedSha256],
  );

  if (!deletedRow) {
    return { match: false };
  }

  return {
    deletedAt: parseTimestamp(deletedRow.deletedAt),
    envelopeDeleted: true,
    envelopeId: parseNonEmptyString(deletedRow.envelopeId),
    fileKind:
      deletedRow.isSignedDocument === true ? "signed-document" : "certificate",
    finishedAt: parseTimestamp(deletedRow.finishedAt),
    match: true,
    status: parseFinishedStatus(deletedRow.status),
    title: parseNonEmptyString(deletedRow.title),
  };
}
