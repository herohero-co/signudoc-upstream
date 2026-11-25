import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import type { Pool, PoolClient, QueryResult } from "pg";

import {
  EnvelopeMutationError,
  FIELDS_CHANGED_MESSAGE,
  replaceDraftEnvelopeFields,
  replaceDraftEnvelopeSigners,
} from "./envelopes.ts";

// Transactional in-memory Postgres stand-in for draft field/signer races
// (issue #224). Enforces FOR NO KEY UPDATE serialization, ON DELETE CASCADE on
// fields_signer_envelope_fk, FK violation 23503 on INSERT INTO fields, and the
// fields_not_for_approvers trigger (23514).

type MockEnvelope = {
  completedAt: number | null;
  createdAt: number;
  declinedAt: number | null;
  evidenceKey: string | null;
  expiresAt: number | null;
  fieldsRevision: number;
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

type MockSigner = {
  accessCodeHash: string | null;
  createdAt: number;
  declineReason: string | null;
  declinedAt: number | null;
  email: string;
  envelopeId: string;
  id: string;
  lastNotifiedAt: number | null;
  lastNudgedAt: number | null;
  name: string;
  requireEmailCode: boolean;
  role: "signer" | "approver" | "cc";
  signatureMeaning: string | null;
  signedAt: number | null;
  signOrder: number;
  signingStep: number | null;
  signingTokenExpiresAt: number | null;
  signingTokenHash: string | null;
  status: "pending" | "notified" | "signed" | "declined";
  turnStartedAt: number | null;
  updatedAt: number;
};

type MockField = {
  checked: boolean | null;
  createdAt: number;
  envelopeId: string;
  groupId: string | null;
  height: number;
  id: string;
  imageKey: string | null;
  inputMethod: null;
  label: string | null;
  options: string[] | null;
  page: number;
  required: boolean;
  signerId: string;
  submittedAt: number | null;
  type:
    | "signature"
    | "initials"
    | "date"
    | "name"
    | "text"
    | "checkbox"
    | "number"
    | "dropdown"
    | "radio";
  updatedAt: number;
  value: string | null;
  width: number;
  x: number;
  y: number;
};

type DbSnapshot = {
  envelope: MockEnvelope;
  fields: MockField[];
  signers: MockSigner[];
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

function cloneSnapshot(state: DbSnapshot): DbSnapshot {
  return {
    envelope: { ...state.envelope },
    fields: state.fields.map((field) => ({
      ...field,
      options: field.options ? [...field.options] : null,
    })),
    signers: state.signers.map((signer) => ({ ...signer })),
  };
}

function createDraftDb() {
  const userId = randomUUID();
  const envelopeId = randomUUID();
  const rileyId = randomUUID();
  const caseyId = randomUUID();
  const rileyEmail = `riley-${randomUUID()}@example.test`;
  const caseyEmail = `casey-${randomUUID()}@example.test`;
  const now = Math.floor(Date.now() / 1000) - 60;

  let committed: DbSnapshot = {
    envelope: {
      completedAt: null,
      createdAt: now,
      declinedAt: null,
      evidenceKey: null,
      expiresAt: null,
      fieldsRevision: 1,
      id: envelopeId,
      pageCount: 1,
      part11: false,
      reminderIntervalDays: null,
      sentAt: null,
      signatureLevel: "simple",
      signatureProvider: null,
      signedPdfKey: null,
      sourcePdfFilename: "lease.pdf",
      sourcePdfHash: "a".repeat(64),
      sourcePdfKey: `test/${envelopeId}.pdf`,
      sourcePdfSizeBytes: 1024,
      status: "draft",
      title: "Lease",
      updatedAt: now,
      userId,
      voidedAt: null,
    },
    fields: [
      {
        checked: null,
        createdAt: now,
        envelopeId,
        groupId: null,
        height: 0.05,
        id: randomUUID(),
        imageKey: null,
        inputMethod: null,
        label: null,
        options: null,
        page: 1,
        required: true,
        signerId: rileyId,
        submittedAt: null,
        type: "signature",
        updatedAt: now,
        value: null,
        width: 0.2,
        x: 0.1,
        y: 0.1,
      },
      {
        checked: null,
        createdAt: now + 1,
        envelopeId,
        groupId: null,
        height: 0.05,
        id: randomUUID(),
        imageKey: null,
        inputMethod: null,
        label: null,
        options: null,
        page: 1,
        required: true,
        signerId: caseyId,
        submittedAt: null,
        type: "signature",
        updatedAt: now,
        value: null,
        width: 0.2,
        x: 0.1,
        y: 0.2,
      },
    ],
    signers: [
      {
        accessCodeHash: null,
        createdAt: now,
        declineReason: null,
        declinedAt: null,
        email: rileyEmail,
        envelopeId,
        id: rileyId,
        lastNotifiedAt: null,
        lastNudgedAt: null,
        name: "Riley Recipient",
        requireEmailCode: false,
        role: "signer",
        signatureMeaning: null,
        signedAt: null,
        signOrder: 1,
        signingStep: 1,
        signingTokenExpiresAt: null,
        signingTokenHash: null,
        status: "pending",
        turnStartedAt: null,
        updatedAt: now,
      },
      {
        accessCodeHash: null,
        createdAt: now,
        declineReason: null,
        declinedAt: null,
        email: caseyEmail,
        envelopeId,
        id: caseyId,
        lastNotifiedAt: null,
        lastNudgedAt: null,
        name: "Casey Second",
        requireEmailCode: false,
        role: "signer",
        signatureMeaning: null,
        signedAt: null,
        signOrder: 2,
        signingStep: 2,
        signingTokenExpiresAt: null,
        signingTokenHash: null,
        status: "pending",
        turnStartedAt: null,
        updatedAt: now,
      },
    ],
  };

  let lockHolder: object | null = null;
  const lockWaiters: Array<() => void> = [];

  async function acquireDraftLock(owner: object) {
    while (lockHolder !== null && lockHolder !== owner) {
      await new Promise<void>((resolve) => {
        lockWaiters.push(resolve);
      });
    }

    lockHolder = owner;
  }

  function releaseDraftLock(owner: object) {
    if (lockHolder === owner) {
      lockHolder = null;
      const next = lockWaiters.shift();

      next?.();
    }
  }

  function runQuery(
    state: DbSnapshot,
    text: string,
    values: unknown[] = [],
  ): QueryResult {
    const sql = text.replace(/\s+/g, " ").trim();

    if (
      sql.includes("SELECT id FROM envelopes") &&
      sql.includes("FOR NO KEY UPDATE")
    ) {
      const matches =
        state.envelope.id === values[0] &&
        state.envelope.userId === values[1] &&
        state.envelope.status === "draft";

      return queryResult(matches ? [{ id: state.envelope.id }] : []);
    }

    if (sql.includes("SELECT fields_revision FROM envelopes WHERE id = $1")) {
      return queryResult(
        state.envelope.id === values[0]
          ? [{ fields_revision: state.envelope.fieldsRevision }]
          : [],
      );
    }

    if (sql.includes("FROM envelopes WHERE id = $1 AND user_id = $2")) {
      return queryResult(
        state.envelope.id === values[0] && state.envelope.userId === values[1]
          ? [{ ...state.envelope }]
          : [],
      );
    }

    if (sql.includes("FROM envelope_pages WHERE envelope_id = $1")) {
      return queryResult(
        state.envelope.id === values[0]
          ? [
              {
                envelopeId,
                heightPt: 792,
                id: "page-1",
                pageNumber: 1,
                widthPt: 612,
              },
            ]
          : [],
      );
    }

    if (
      sql.includes("FROM signers WHERE envelope_id IN") &&
      sql.includes("AND role IN ('signer', 'approver')")
    ) {
      return queryResult(
        state.signers
          .filter(
            (signer) =>
              values.includes(signer.envelopeId) &&
              (signer.role === "signer" || signer.role === "approver"),
          )
          .sort((left, right) => left.signOrder - right.signOrder)
          .map((signer) => ({ ...signer })),
      );
    }

    if (
      sql.includes("FROM signers WHERE envelope_id IN") &&
      sql.includes("AND role = 'cc'")
    ) {
      return queryResult(
        state.signers
          .filter(
            (signer) =>
              values.includes(signer.envelopeId) && signer.role === "cc",
          )
          .sort((left, right) => left.signOrder - right.signOrder)
          .map((signer) => ({
            email: signer.email,
            envelopeId: signer.envelopeId,
            id: signer.id,
            name: signer.name,
          })),
      );
    }

    if (sql.includes('access_code_hash IS NOT NULL AS "hasAccessCode"')) {
      return queryResult(
        state.signers
          .filter((signer) => signer.envelopeId === values[0])
          .map((signer) => ({
            hasAccessCode: signer.accessCodeHash !== null,
            id: signer.id,
            requireEmailCode: signer.requireEmailCode,
            signatureMeaning: signer.signatureMeaning,
          })),
      );
    }

    if (sql.includes("FROM fields WHERE envelope_id IN")) {
      return queryResult(
        state.fields
          .filter((field) => values.includes(field.envelopeId))
          .sort((left, right) => left.createdAt - right.createdAt)
          .map((field) => ({ ...field })),
      );
    }

    if (
      sql.startsWith(
        "DELETE FROM fields WHERE envelope_id = $1 AND signer_id = $2",
      )
    ) {
      const before = state.fields.length;

      state.fields = state.fields.filter(
        (field) =>
          !(field.envelopeId === values[0] && field.signerId === values[1]),
      );

      return queryResult([], before - state.fields.length);
    }

    if (sql.startsWith("DELETE FROM fields WHERE envelope_id = $1")) {
      const before = state.fields.length;

      state.fields = state.fields.filter(
        (field) => field.envelopeId !== values[0],
      );

      return queryResult([], before - state.fields.length);
    }

    if (sql.startsWith("INSERT INTO fields")) {
      const signerId = String(values[2]);
      const targetEnvelopeId = String(values[1]);
      const signer = state.signers.find(
        (entry) =>
          entry.id === signerId && entry.envelopeId === targetEnvelopeId,
      );

      if (!signer) {
        const error = Object.assign(
          new Error(
            'insert or update on table "fields" violates foreign key constraint "fields_signer_envelope_fk"',
          ),
          {
            code: "23503",
            constraint: "fields_signer_envelope_fk",
          },
        );

        throw error;
      }

      if (signer.role === "approver") {
        const error = Object.assign(new Error("An approver has no fields."), {
          code: "23514",
        });

        throw error;
      }

      state.fields.push({
        checked: null,
        createdAt: Number(values[11]),
        envelopeId: targetEnvelopeId,
        groupId: (values[14] as string | null) ?? null,
        height: Number(values[8]),
        id: String(values[0]),
        imageKey: null,
        inputMethod: null,
        label: (values[10] as string | null) ?? null,
        options: values[13]
          ? (JSON.parse(String(values[13])) as string[])
          : null,
        page: Number(values[4]),
        required: Boolean(values[9]),
        signerId,
        submittedAt: null,
        type: values[3] as MockField["type"],
        updatedAt: Number(values[12]),
        value: null,
        width: Number(values[7]),
        x: Number(values[5]),
        y: Number(values[6]),
      });

      return queryResult([], 1);
    }

    if (
      sql.startsWith(
        "DELETE FROM signers WHERE envelope_id = $1 AND role = 'cc'",
      )
    ) {
      const before = state.signers.length;

      state.signers = state.signers.filter(
        (signer) => !(signer.envelopeId === values[0] && signer.role === "cc"),
      );

      return queryResult([], before - state.signers.length);
    }

    if (sql.includes("SET email = id || '@temp.invalid'")) {
      let updated = 0;

      for (const signer of state.signers) {
        if (signer.envelopeId === values[1]) {
          signer.email = `${signer.id}@temp.invalid`;
          signer.signOrder += 1000;
          signer.updatedAt = Number(values[0]);
          updated += 1;
        }
      }

      return queryResult([], updated);
    }

    if (sql.startsWith("UPDATE signers SET name = $1")) {
      const signer = state.signers.find(
        (entry) => entry.id === values[4] && entry.envelopeId === values[5],
      );

      if (!signer) {
        return queryResult([], 0);
      }

      signer.name = String(values[0]);
      signer.email = String(values[1]);
      signer.signOrder = Number(values[2]);
      signer.updatedAt = Number(values[3]);
      if (values[6]) {
        signer.accessCodeHash = (values[7] as string | null) ?? null;
      }
      if (values[8] !== null && values[8] !== undefined) {
        signer.requireEmailCode = Boolean(values[8]);
      }
      if (values[9]) {
        signer.signatureMeaning = (values[10] as string | null) ?? null;
      }
      signer.signingStep = Number(values[11]);
      signer.role = values[12] as MockSigner["role"];

      return queryResult([], 1);
    }

    if (sql.startsWith("INSERT INTO signers") && sql.includes("'cc'")) {
      state.signers.push({
        accessCodeHash: null,
        createdAt: Number(values[5]),
        declineReason: null,
        declinedAt: null,
        email: String(values[3]),
        envelopeId: String(values[1]),
        id: String(values[0]),
        lastNotifiedAt: null,
        lastNudgedAt: null,
        name: String(values[2]),
        requireEmailCode: false,
        role: "cc",
        signatureMeaning: null,
        signedAt: null,
        signOrder: Number(values[4]),
        signingStep: null,
        signingTokenExpiresAt: null,
        signingTokenHash: null,
        status: "pending",
        turnStartedAt: null,
        updatedAt: Number(values[5]),
      });

      return queryResult([], 1);
    }

    if (sql.startsWith("INSERT INTO signers")) {
      state.signers.push({
        accessCodeHash: (values[7] as string | null) ?? null,
        createdAt: Number(values[5]),
        declineReason: null,
        declinedAt: null,
        email: String(values[3]),
        envelopeId: String(values[1]),
        id: String(values[0]),
        lastNotifiedAt: null,
        lastNudgedAt: null,
        name: String(values[2]),
        requireEmailCode: Boolean(values[8]),
        role: values[11] as MockSigner["role"],
        signatureMeaning: (values[9] as string | null) ?? null,
        signedAt: null,
        signOrder: Number(values[4]),
        signingStep: Number(values[10]),
        signingTokenExpiresAt: null,
        signingTokenHash: null,
        status: "pending",
        turnStartedAt: null,
        updatedAt: Number(values[6]),
      });

      return queryResult([], 1);
    }

    if (
      sql.startsWith("DELETE FROM signers WHERE envelope_id = $1 AND id NOT IN")
    ) {
      const keepIds = new Set(values.slice(1).map(String));
      const removedIds = new Set<string>();

      state.signers = state.signers.filter((signer) => {
        if (signer.envelopeId === values[0] && !keepIds.has(signer.id)) {
          removedIds.add(signer.id);
          return false;
        }

        return true;
      });

      // ON DELETE CASCADE from fields_signer_envelope_fk.
      state.fields = state.fields.filter(
        (field) =>
          !(field.envelopeId === values[0] && removedIds.has(field.signerId)),
      );

      return queryResult([], removedIds.size);
    }

    if (
      sql.startsWith(
        "UPDATE envelopes SET updated_at = $1, fields_revision = fields_revision + 1",
      )
    ) {
      if (
        state.envelope.id === values[1] &&
        state.envelope.userId === values[2]
      ) {
        state.envelope.updatedAt = Number(values[0]);
        state.envelope.fieldsRevision += 1;
        return queryResult(
          [{ fields_revision: state.envelope.fieldsRevision }],
          1,
        );
      }

      return queryResult([], 0);
    }

    if (sql.startsWith("UPDATE envelopes SET updated_at = $1")) {
      if (
        state.envelope.id === values[1] &&
        state.envelope.userId === values[2]
      ) {
        state.envelope.updatedAt = Number(values[0]);
        return queryResult([], 1);
      }

      return queryResult([], 0);
    }

    throw new Error(`Unexpected SQL in draft-fields-race.test.ts: ${sql}`);
  }

  function createPool(
    options: {
      onAfterQuery?: (sql: string, values: unknown[]) => Promise<void>;
      onBeforeLock?: () => Promise<void>;
    } = {},
  ): Pool {
    return {
      async connect() {
        const owner = {};
        let txState: DbSnapshot | null = null;
        let holdsLock = false;

        const client = {
          async query(text: string, values?: unknown[]) {
            const sql = text.replace(/\s+/g, " ").trim();

            if (sql === "BEGIN") {
              txState = cloneSnapshot(committed);
              return queryResult([], 0);
            }

            if (sql === "COMMIT") {
              if (txState) {
                committed = txState;
                txState = null;
              }

              if (holdsLock) {
                holdsLock = false;
                releaseDraftLock(owner);
              }

              return queryResult([], 0);
            }

            if (sql === "ROLLBACK") {
              txState = null;

              if (holdsLock) {
                holdsLock = false;
                releaseDraftLock(owner);
              }

              return queryResult([], 0);
            }

            if (sql.includes("FOR NO KEY UPDATE")) {
              await options.onBeforeLock?.();
              await acquireDraftLock(owner);
              holdsLock = true;
              // READ COMMITTED: after waiting on a row lock, refresh the
              // transaction snapshot to see what the prior holder committed.
              txState = cloneSnapshot(committed);
            }

            const result = runQuery(txState ?? committed, text, values);

            await options.onAfterQuery?.(sql, values ?? []);
            return result;
          },
          release() {
            if (holdsLock) {
              holdsLock = false;
              releaseDraftLock(owner);
            }
          },
        } as unknown as PoolClient;

        return client;
      },
      async query(text: string, values?: unknown[]) {
        const sql = text.replace(/\s+/g, " ").trim();
        const result = runQuery(committed, text, values);

        await options.onAfterQuery?.(sql, values ?? []);
        return result;
      },
    } as unknown as Pool;
  }

  return {
    caseyEmail,
    caseyId,
    createPool,
    envelopeId,
    getState: () => cloneSnapshot(committed),
    rileyEmail,
    rileyId,
    userId,
  };
}

function signatureField(signerId: string, y: number, id?: string) {
  return {
    height: 0.05,
    ...(id ? { id } : {}),
    page: 1,
    required: true,
    signerId,
    type: "signature" as const,
    width: 0.2,
    x: 0.1,
    y,
  };
}

test("field save with expectedRevision overlapping signer removal returns 409 reload guidance, never 23503/500 (issue #224)", async () => {
  const db = createDraftDb();
  const basePool = db.createPool();
  let removed = false;
  const racingPool = db.createPool({
    async onAfterQuery(sql) {
      if (!removed && sql.includes("FROM envelope_pages")) {
        removed = true;
        await replaceDraftEnvelopeSigners(
          db.userId,
          db.envelopeId,
          {
            signers: [
              {
                email: db.rileyEmail,
                id: db.rileyId,
                name: "Riley Recipient",
              },
            ],
          },
          basePool,
        );
      }
    },
  });

  await assert.rejects(
    replaceDraftEnvelopeFields(
      db.userId,
      db.envelopeId,
      {
        expectedRevision: 1,
        fields: [
          signatureField(db.rileyId, 0.3),
          signatureField(db.caseyId, 0.4),
        ],
      },
      racingPool,
    ),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, FIELDS_CHANGED_MESSAGE);
      return true;
    },
  );

  assert.equal(removed, true);
  assert.deepEqual(
    db.getState().signers.map((signer) => signer.id),
    [db.rileyId],
  );
  assert.deepEqual(
    db.getState().fields.map((field) => field.signerId),
    [db.rileyId],
  );
  assert.equal(db.getState().envelope.fieldsRevision, 2);
});

test("field save without expectedRevision overlapping signer removal fails cleanly with 400 inside the lock, never 23503/500 (issue #224)", async () => {
  const db = createDraftDb();
  const basePool = db.createPool();
  let removed = false;
  const racingPool = db.createPool({
    async onAfterQuery(sql) {
      if (!removed && sql.includes("FROM envelope_pages")) {
        removed = true;
        await replaceDraftEnvelopeSigners(
          db.userId,
          db.envelopeId,
          {
            signers: [
              {
                email: db.rileyEmail,
                id: db.rileyId,
                name: "Riley Recipient",
              },
            ],
          },
          basePool,
        );
      }
    },
  });

  await assert.rejects(
    replaceDraftEnvelopeFields(
      db.userId,
      db.envelopeId,
      {
        fields: [
          signatureField(db.rileyId, 0.3),
          signatureField(db.caseyId, 0.4),
        ],
      },
      racingPool,
    ),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /existing signer/);
      return true;
    },
  );

  assert.equal(removed, true);
  assert.deepEqual(
    db.getState().fields.map((field) => field.signerId),
    [db.rileyId],
  );
});

test("concurrent lock contention between signer removal and field save returns 409 without FK violation", async () => {
  const db = createDraftDb();
  let releaseSignerRemoval!: () => void;
  const holdSignerRemoval = new Promise<void>((resolve) => {
    releaseSignerRemoval = resolve;
  });
  let signerLocked!: () => void;
  const signerHasLock = new Promise<void>((resolve) => {
    signerLocked = resolve;
  });

  const signerPool = db.createPool({
    async onAfterQuery(sql) {
      if (
        sql.includes("DELETE FROM signers WHERE envelope_id = $1 AND id NOT IN")
      ) {
        signerLocked();
        await holdSignerRemoval;
      }
    },
  });
  const fieldsPool = db.createPool({
    async onBeforeLock() {
      // Let the signer removal commit right after field save reaches the lock.
      queueMicrotask(() => {
        releaseSignerRemoval();
      });
    },
  });

  const removalPromise = replaceDraftEnvelopeSigners(
    db.userId,
    db.envelopeId,
    {
      signers: [
        { email: db.rileyEmail, id: db.rileyId, name: "Riley Recipient" },
      ],
    },
    signerPool,
  );

  await signerHasLock;

  const fieldsPromise = replaceDraftEnvelopeFields(
    db.userId,
    db.envelopeId,
    {
      expectedRevision: 1,
      fields: [
        signatureField(db.rileyId, 0.3),
        signatureField(db.caseyId, 0.4),
      ],
    },
    fieldsPool,
  );

  await removalPromise;
  await assert.rejects(fieldsPromise, (error: unknown) => {
    assert.ok(error instanceof EnvelopeMutationError);
    assert.equal(error.statusCode, 409);
    assert.equal(error.message, FIELDS_CHANGED_MESSAGE);
    return true;
  });

  assert.equal(db.getState().envelope.fieldsRevision, 2);
  assert.deepEqual(
    db.getState().fields.map((field) => field.signerId),
    [db.rileyId],
  );
});

test("changing a signer to an approver bumps fields_revision and refuses overlapping field saves cleanly", async () => {
  const db = createDraftDb();
  const basePool = db.createPool();
  let converted = false;
  const racingPool = db.createPool({
    async onAfterQuery(sql) {
      if (!converted && sql.includes("FROM envelope_pages")) {
        converted = true;
        await replaceDraftEnvelopeSigners(
          db.userId,
          db.envelopeId,
          {
            signers: [
              {
                email: db.rileyEmail,
                id: db.rileyId,
                name: "Riley Recipient",
                role: "signer",
              },
              {
                email: db.caseyEmail,
                id: db.caseyId,
                name: "Casey Second",
                role: "approver",
              },
            ],
          },
          basePool,
        );
      }
    },
  });

  await assert.rejects(
    replaceDraftEnvelopeFields(
      db.userId,
      db.envelopeId,
      {
        expectedRevision: 1,
        fields: [
          signatureField(db.rileyId, 0.3),
          signatureField(db.caseyId, 0.4),
        ],
      },
      racingPool,
    ),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, FIELDS_CHANGED_MESSAGE);
      return true;
    },
  );

  // Without expectedRevision, the in-lock role check returns 400 instead of
  // hitting the fields_not_for_approvers trigger (23514).
  await assert.rejects(
    replaceDraftEnvelopeFields(
      db.userId,
      db.envelopeId,
      {
        fields: [signatureField(db.caseyId, 0.4)],
      },
      basePool,
    ),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /Approvers/);
      return true;
    },
  );
});

test("uncontended field save keeps fields, advances fieldsRevision, and stale revision control returns 409", async () => {
  const db = createDraftDb();
  const pool = db.createPool();
  const keptFieldId = db.getState().fields[0]!.id;
  const originalCreatedAt = db.getState().fields[0]!.createdAt;

  // Non-destructive signer edit (rename, no removals or role changes) does not
  // needlessly invalidate fieldsRevision.
  await replaceDraftEnvelopeSigners(
    db.userId,
    db.envelopeId,
    {
      signers: [
        { email: db.rileyEmail, id: db.rileyId, name: "Riley Renamed" },
        { email: db.caseyEmail, id: db.caseyId, name: "Casey Second" },
      ],
    },
    pool,
  );
  assert.equal(db.getState().envelope.fieldsRevision, 1);

  const saved = await replaceDraftEnvelopeFields(
    db.userId,
    db.envelopeId,
    {
      expectedRevision: 1,
      fields: [
        signatureField(db.rileyId, 0.35, keptFieldId),
        signatureField(db.caseyId, 0.55),
      ],
    },
    pool,
  );

  assert.equal(saved.fieldsRevision, 2);
  assert.equal(saved.fields.length, 2);
  assert.equal(
    db.getState().fields.find((field) => field.id === keptFieldId)?.createdAt,
    originalCreatedAt,
  );

  // Stale-revision control still returns 409 with reload guidance.
  await assert.rejects(
    replaceDraftEnvelopeFields(
      db.userId,
      db.envelopeId,
      {
        expectedRevision: 1,
        fields: [signatureField(db.rileyId, 0.7)],
      },
      pool,
    ),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.message, FIELDS_CHANGED_MESSAGE);
      return true;
    },
  );

  // Bogus signer ID with current revision still returns 400.
  await assert.rejects(
    replaceDraftEnvelopeFields(
      db.userId,
      db.envelopeId,
      {
        expectedRevision: 2,
        fields: [signatureField(randomUUID(), 0.7)],
      },
      pool,
    ),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 400);
      assert.match(error.message, /existing signer/);
      return true;
    },
  );
});

test("stale signer save referencing a concurrently removed signer returns 409 instead of recreating it without its access code", async () => {
  const db = createDraftDb();
  const basePool = db.createPool();

  // First protect Casey with an access code.
  await replaceDraftEnvelopeSigners(
    db.userId,
    db.envelopeId,
    {
      signers: [
        { email: db.rileyEmail, id: db.rileyId, name: "Riley Recipient" },
        {
          accessCode: "secret-code-42",
          email: db.caseyEmail,
          id: db.caseyId,
          name: "Casey Second",
        },
      ],
    },
    basePool,
  );
  assert.ok(
    db.getState().signers.find((signer) => signer.id === db.caseyId)
      ?.accessCodeHash,
  );

  // Another tab removes Casey right after this save reads existing signers
  // (omitting accessCode, as the UI does for unchanged saved codes) and before
  // it acquires the draft lock.
  let removedConcurrently = false;
  const racingPool = db.createPool({
    onAfterQuery: async (normalized) => {
      if (
        !removedConcurrently &&
        normalized.includes("FROM signers") &&
        normalized.includes("role = 'cc'")
      ) {
        removedConcurrently = true;
        await replaceDraftEnvelopeSigners(
          db.userId,
          db.envelopeId,
          {
            signers: [
              {
                email: db.rileyEmail,
                id: db.rileyId,
                name: "Riley Recipient",
              },
            ],
          },
          basePool,
        );
      }
    },
  });

  await assert.rejects(
    replaceDraftEnvelopeSigners(
      db.userId,
      db.envelopeId,
      {
        signers: [
          { email: db.rileyEmail, id: db.rileyId, name: "Riley Renamed" },
          { email: db.caseyEmail, id: db.caseyId, name: "Casey Second" },
        ],
      },
      racingPool,
    ),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeMutationError);
      assert.equal(error.statusCode, 409);
      assert.match(error.message, /Reload the page/);
      return true;
    },
  );

  // Casey stays removed (not recreated with accessCodeHash = null) and Riley's
  // stale rename was rolled back cleanly.
  assert.deepEqual(
    db.getState().signers.map((signer) => ({
      id: signer.id,
      name: signer.name,
    })),
    [{ id: db.rileyId, name: "Riley Recipient" }],
  );
});
