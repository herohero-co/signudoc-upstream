import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ContactSubmissionError,
  submitPublicContactMessage,
} from "./contact.ts";
import { replaceDbPoolForTests, type DbPool } from "./db/connection.ts";
import {
  buildLegalContactParts,
  buildPublicSupportLink,
  formatLegalInlineParts,
  type LegalContactPassage,
} from "./legal.ts";
import {
  findPublicSupportAddress,
  resolvePublicSupportAddress,
} from "./public-contact.ts";
import { ServiceConfigurationError } from "./services/service-config.ts";
import { invalidateSettingsCache } from "./settings.ts";

const ALL_LEGAL_PASSAGES: readonly LegalContactPassage[] = [
  "privacy_rights",
  "privacy_contact",
  "terms_closure",
  "terms_contact",
  "accessibility_assistance",
  "accessibility_feedback",
];

async function withFakeSettingsDb(
  query: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>,
  run: () => Promise<void>,
): Promise<void> {
  const previous = replaceDbPoolForTests({ query } as unknown as DbPool);
  invalidateSettingsCache();

  try {
    await run();
  } finally {
    replaceDbPoolForTests(previous as unknown as DbPool);
    invalidateSettingsCache();
  }
}

test("findPublicSupportAddress returns null when neither SUPPORT_EMAIL nor DB settings configure one", async () => {
  const address = await findPublicSupportAddress(
    { HOSTED_MODE: "1" },
    async () => ({ supportAddress: null }),
  );

  assert.equal(address, null);

  const blankDb = await findPublicSupportAddress(
    { HOSTED_MODE: "1", SUPPORT_EMAIL: "   " },
    async () => ({ supportAddress: "   " }),
  );

  assert.equal(blankDb, null);
});

test("findPublicSupportAddress prefers SUPPORT_EMAIL over stored settings and ignores placeholders", async () => {
  let loadedFromDb = false;
  const fromEnv = await findPublicSupportAddress(
    { HOSTED_MODE: "1", SUPPORT_EMAIL: "  support@example.com  " },
    async () => {
      loadedFromDb = true;
      return { supportAddress: "db-help@example.com" };
    },
  );

  assert.equal(fromEnv, "support@example.com");
  assert.equal(loadedFromDb, false);

  const fromDbWhenPlaceholder = await findPublicSupportAddress(
    { HOSTED_MODE: "1", SUPPORT_EMAIL: "replace-with-support-email" },
    async () => ({ supportAddress: "  db-help@example.com  " }),
  );

  assert.equal(fromDbWhenPlaceholder, "db-help@example.com");
});

test("findPublicSupportAddress returns null instead of throwing when settings cannot be loaded", async () => {
  const withoutDatabase = await findPublicSupportAddress(
    { HOSTED_MODE: "1" },
    async () => {
      throw new ServiceConfigurationError("database", ["DATABASE_URL"]);
    },
  );

  assert.equal(withoutDatabase, null);

  const unreachableDb = await findPublicSupportAddress(
    { HOSTED_MODE: "1" },
    async () => {
      throw new Error("connection refused");
    },
  );

  assert.equal(unreachableDb, null);

  // Env SUPPORT_EMAIL still resolves even when the database is unavailable.
  const envDespiteDbError = await findPublicSupportAddress(
    { HOSTED_MODE: "1", SUPPORT_EMAIL: "support@example.com" },
    async () => {
      throw new Error("connection refused");
    },
  );

  assert.equal(envDespiteDbError, "support@example.com");
});

test("resolvePublicSupportAddress throws ServiceConfigurationError when unconfigured, and resolves env or DB when configured", async () => {
  await assert.rejects(
    resolvePublicSupportAddress({ HOSTED_MODE: "1" }, async () => ({
      supportAddress: null,
    })),
    (error: unknown) => {
      assert.ok(error instanceof ServiceConfigurationError);
      assert.match(error.message, /SUPPORT_EMAIL/);
      return true;
    },
  );

  assert.equal(
    await resolvePublicSupportAddress(
      { SUPPORT_EMAIL: "env@example.com" },
      async () => ({ supportAddress: "db@example.com" }),
    ),
    "env@example.com",
  );

  assert.equal(
    await resolvePublicSupportAddress({}, async () => ({
      supportAddress: "db@example.com",
    })),
    "db@example.com",
  );
});

test("public contact helpers integrate with getSettings across fresh DB, stored DB row, and env override", async () => {
  // Fresh migrated hosted install: app_settings has no rows yet, SUPPORT_EMAIL unset.
  await withFakeSettingsDb(
    async () => ({ rows: [] }),
    async () => {
      assert.equal(await findPublicSupportAddress({ HOSTED_MODE: "1" }), null);

      await assert.rejects(
        resolvePublicSupportAddress({ HOSTED_MODE: "1" }),
        ServiceConfigurationError,
      );
    },
  );

  // Completed setup / saved organization settings row in DB.
  await withFakeSettingsDb(
    async () => ({
      rows: [
        {
          allowed_email_domains: [],
          brand_color: null,
          consent_disclosure: null,
          email_ready_at: null,
          logo_hash: null,
          organization_name: "Acme Corp",
          part11_mode: false,
          privacy_url: null,
          require_two_factor: false,
          retention_days: null,
          sender_address: null,
          session_idle_minutes: null,
          session_max_hours: null,
          setup_completed_at: 1_800_000_000,
          signup_mode: "open",
          support_address: "help@acme.com",
          terms_url: null,
        },
      ],
    }),
    async () => {
      assert.equal(
        await findPublicSupportAddress({ HOSTED_MODE: "1" }),
        "help@acme.com",
      );
      assert.equal(
        await resolvePublicSupportAddress({ HOSTED_MODE: "1" }),
        "help@acme.com",
      );

      // SUPPORT_EMAIL env var overrides the stored DB support address.
      assert.equal(
        await findPublicSupportAddress({
          HOSTED_MODE: "1",
          SUPPORT_EMAIL: "override@acme.com",
        }),
        "override@acme.com",
      );
      assert.equal(
        await resolvePublicSupportAddress({
          HOSTED_MODE: "1",
          SUPPORT_EMAIL: "override@acme.com",
        }),
        "override@acme.com",
      );
    },
  );
});

test("submitPublicContactMessage returns 503 instead of throwing an unhandled configuration error when support email is unset", async () => {
  await withFakeSettingsDb(
    async () => ({ rows: [] }),
    async () => {
      await assert.rejects(
        submitPublicContactMessage(
          {
            email: "visitor@example.com",
            message: "Hello from a fresh hosted install.",
            name: "Jordan Lee",
          },
          { env: { HOSTED_MODE: "1" } },
        ),
        (error: unknown) => {
          assert.ok(error instanceof ContactSubmissionError);
          assert.equal(error.statusCode, 503);
          assert.equal(
            error.message,
            "Contact form is temporarily unavailable.",
          );
          return true;
        },
      );
    },
  );
});

test("buildPublicSupportLink normalizes bare emails, display-name addresses, and invalid values", () => {
  assert.deepEqual(buildPublicSupportLink("help@acme.com"), {
    address: "help@acme.com",
    href: "mailto:help@acme.com",
  });
  assert.deepEqual(buildPublicSupportLink("  Support@Acme.com  "), {
    address: "Support@Acme.com",
    href: "mailto:Support@Acme.com",
  });
  assert.deepEqual(buildPublicSupportLink("Acme Help <desk@acme.com>"), {
    address: "desk@acme.com",
    href: "mailto:desk@acme.com",
  });

  for (const invalid of [
    null,
    undefined,
    "",
    "   ",
    "not-an-email",
    "Acme <>",
    "bad email@acme.com",
  ]) {
    assert.equal(buildPublicSupportLink(invalid), null);
  }
});

test("legal page contact passages fall back cleanly to /contact when support email is unset", () => {
  const expected: Record<LegalContactPassage, string> = {
    privacy_rights:
      "To request access, correction, deletion, or account closure, submit a request through the Contact page or use the in-app account-closure request flow when available.",
    privacy_contact:
      "Privacy questions, requests, and complaints may be sent through the Contact page.",
    terms_closure:
      "Account-closure requests may be submitted through the settings page or through the Contact page.",
    terms_contact:
      "Questions about these Terms may be sent through the Contact page.",
    accessibility_assistance:
      "If you need help creating, sending, reviewing, or signing a document, reach out through the Contact page.",
    accessibility_feedback:
      "Accessibility feedback helps us prioritize the right fixes. If you find a barrier, use the Contact page.",
  };

  for (const passage of ALL_LEGAL_PASSAGES) {
    for (const unset of [null, undefined, "", "   "]) {
      const parts = buildLegalContactParts(passage, unset);
      const rendered = formatLegalInlineParts(parts);

      assert.equal(rendered, expected[passage]);
      assert.doesNotMatch(rendered, /  /);
      assert.equal(
        parts.some((part) => part.type === "email"),
        false,
        `${passage} must not include a mailto link when support email is unset`,
      );
      assert.equal(
        parts.some(
          (part) => part.type === "contact" && part.href === "/contact",
        ),
        true,
        `${passage} should link to /contact when support email is unset`,
      );
    }
  }
});

test("legal page contact passages render the configured support address with a valid mailto link", () => {
  const expected: Record<LegalContactPassage, string> = {
    privacy_rights:
      "To request access, correction, deletion, or account closure, email help@acme.com or use the in-app account-closure request flow when available.",
    privacy_contact:
      "Privacy questions, requests, and complaints may be sent to help@acme.com or through the Contact page.",
    terms_closure:
      "Account-closure requests may be submitted through the settings page or by contacting help@acme.com.",
    terms_contact:
      "Questions about these Terms may be sent to help@acme.com or through the Contact page.",
    accessibility_assistance:
      "If you need help creating, sending, reviewing, or signing a document, email help@acme.com.",
    accessibility_feedback:
      "Accessibility feedback helps us prioritize the right fixes. If you find a barrier, email help@acme.com or use the Contact page.",
  };

  for (const passage of ALL_LEGAL_PASSAGES) {
    for (const input of ["help@acme.com", "Acme Support <help@acme.com>"]) {
      const parts = buildLegalContactParts(passage, input);
      const rendered = formatLegalInlineParts(parts);

      assert.equal(rendered, expected[passage]);
      assert.doesNotMatch(rendered, /  /);
      assert.equal(
        parts.some(
          (part) =>
            part.type === "email" &&
            part.address === "help@acme.com" &&
            part.href === "mailto:help@acme.com",
        ),
        true,
        `${passage} should include a valid mailto link for ${input}`,
      );
    }
  }
});
