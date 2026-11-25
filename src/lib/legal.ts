export const PUBLIC_COPYRIGHT_YEAR = 2026;

export const publicLegalLinks = [
  {
    href: "/terms",
    longLabel: "Terms of Service",
    shortLabel: "Terms",
  },
  {
    href: "/privacy",
    longLabel: "Privacy Policy",
    shortLabel: "Privacy",
  },
  {
    href: "/contact",
    longLabel: "Contact",
    shortLabel: "Contact",
  },
] as const;

export const publicFooterLinks = [
  publicLegalLinks[0],
  publicLegalLinks[1],
  {
    href: "/accessibility",
    longLabel: "Accessibility Statement",
    shortLabel: "Accessibility",
  },
  publicLegalLinks[2],
] as const;

export type PublicSupportLink = {
  /** The bare email address shown in text, e.g. "support@example.com". */
  address: string;
  /** The `mailto:` target, stripped of any RFC 5322 display name. */
  href: string;
};

export type LegalInlinePart =
  | { text: string; type: "text" }
  | { address: string; href: string; type: "email" }
  | { href: "/contact"; label: string; type: "contact" };

export type LegalContactPassage =
  | "accessibility_assistance"
  | "accessibility_feedback"
  | "privacy_contact"
  | "privacy_rights"
  | "terms_closure"
  | "terms_contact";

const CONTACT_PAGE_LINK: LegalInlinePart = {
  href: "/contact",
  label: "Contact",
  type: "contact",
};

/**
 * Turns a configured support address (bare email or "Name <email>") into a
 * safe display string and `mailto:` href, or null when unset or invalid.
 */
export function buildPublicSupportLink(
  supportAddress: string | null | undefined,
): PublicSupportLink | null {
  const trimmed = supportAddress?.trim();

  if (!trimmed) {
    return null;
  }

  const angleMatch = /<([^<>]+)>\s*$/.exec(trimmed);
  const bareAddress = (angleMatch?.[1] ?? trimmed).trim();

  if (!bareAddress || !bareAddress.includes("@") || /\s/.test(bareAddress)) {
    return null;
  }

  return {
    address: bareAddress,
    href: `mailto:${bareAddress}`,
  };
}

/**
 * Builds the contact sentences for the hosted legal pages. When no support
 * address is configured yet (for example on a fresh hosted install before
 * setup finishes), every passage points to the Contact page instead of
 * failing or rendering a broken mailto link.
 */
export function buildLegalContactParts(
  passage: LegalContactPassage,
  supportAddress: string | null | undefined,
): LegalInlinePart[] {
  const email = buildPublicSupportLink(supportAddress);
  const emailPart: LegalInlinePart | null = email
    ? { address: email.address, href: email.href, type: "email" }
    : null;

  switch (passage) {
    case "privacy_rights":
      return emailPart
        ? [
            {
              text: "To request access, correction, deletion, or account closure, email ",
              type: "text",
            },
            emailPart,
            {
              text: " or use the in-app account-closure request flow when available.",
              type: "text",
            },
          ]
        : [
            {
              text: "To request access, correction, deletion, or account closure, submit a request through the ",
              type: "text",
            },
            CONTACT_PAGE_LINK,
            {
              text: " page or use the in-app account-closure request flow when available.",
              type: "text",
            },
          ];

    case "privacy_contact":
      return emailPart
        ? [
            {
              text: "Privacy questions, requests, and complaints may be sent to ",
              type: "text",
            },
            emailPart,
            { text: " or through the ", type: "text" },
            CONTACT_PAGE_LINK,
            { text: " page.", type: "text" },
          ]
        : [
            {
              text: "Privacy questions, requests, and complaints may be sent through the ",
              type: "text",
            },
            CONTACT_PAGE_LINK,
            { text: " page.", type: "text" },
          ];

    case "terms_closure":
      return emailPart
        ? [
            {
              text: "Account-closure requests may be submitted through the settings page or by contacting ",
              type: "text",
            },
            emailPart,
            { text: ".", type: "text" },
          ]
        : [
            {
              text: "Account-closure requests may be submitted through the settings page or through the ",
              type: "text",
            },
            CONTACT_PAGE_LINK,
            { text: " page.", type: "text" },
          ];

    case "terms_contact":
      return emailPart
        ? [
            {
              text: "Questions about these Terms may be sent to ",
              type: "text",
            },
            emailPart,
            { text: " or through the ", type: "text" },
            CONTACT_PAGE_LINK,
            { text: " page.", type: "text" },
          ]
        : [
            {
              text: "Questions about these Terms may be sent through the ",
              type: "text",
            },
            CONTACT_PAGE_LINK,
            { text: " page.", type: "text" },
          ];

    case "accessibility_assistance":
      return emailPart
        ? [
            {
              text: "If you need help creating, sending, reviewing, or signing a document, email ",
              type: "text",
            },
            emailPart,
            { text: ".", type: "text" },
          ]
        : [
            {
              text: "If you need help creating, sending, reviewing, or signing a document, reach out through the ",
              type: "text",
            },
            CONTACT_PAGE_LINK,
            { text: " page.", type: "text" },
          ];

    case "accessibility_feedback":
      return emailPart
        ? [
            {
              text: "Accessibility feedback helps us prioritize the right fixes. If you find a barrier, email ",
              type: "text",
            },
            emailPart,
            { text: " or use the ", type: "text" },
            CONTACT_PAGE_LINK,
            { text: " page.", type: "text" },
          ]
        : [
            {
              text: "Accessibility feedback helps us prioritize the right fixes. If you find a barrier, use the ",
              type: "text",
            },
            CONTACT_PAGE_LINK,
            { text: " page.", type: "text" },
          ];
  }
}

export function formatLegalInlineParts(
  parts: readonly LegalInlinePart[],
): string {
  return parts
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "email":
          return part.address;
        case "contact":
          return part.label;
      }
    })
    .join("");
}
