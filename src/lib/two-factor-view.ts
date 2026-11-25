// What the Two-step sign-in panel in Settings shows for an account. Kept
// apart from the React component so every account kind (password-only,
// SSO-only, and accounts with both) can be tested without a browser.

export type TwoFactorPanelInput = {
  enabled: boolean;
  /** Whether the account has a password stored here (credential account). */
  hasPassword: boolean;
  productName: string;
  /** Whether the organization requires two-step sign-in for password accounts. */
  required: boolean;
  /** Configured identity provider name (SSO_NAME), if any. */
  ssoProviderName?: string | null;
};

export type TwoFactorPanelView =
  | {
      canDisable: false;
      canManage: false;
      description: string;
      mode: "sso-only";
      statusLabel: "Managed by identity provider";
      statusTone: "neutral";
    }
  | {
      canDisable: boolean;
      canManage: true;
      description: string;
      mode: "password";
      statusLabel: "Off" | "On";
      statusTone: "neutral" | "success";
    };

function formatSsoProviderQualifier(
  ssoProviderName: string | null | undefined,
): string {
  const trimmed = ssoProviderName?.trim() ?? "";

  if (trimmed.length === 0 || trimmed.toLowerCase() === "single sign-on") {
    return "";
  }

  return ` (${trimmed})`;
}

/**
 * Decides the badge, copy and controls for the Two-step sign-in panel.
 *
 * Two-step sign-in here protects password sign-in and requires the account's
 * password to turn on, change or turn off. An account with no password here
 * signs in through the organization's identity provider, which handles its
 * own second step and is exempt from the organization's password two-step
 * sign-in requirement.
 */
export function describeTwoFactorPanel({
  enabled,
  hasPassword,
  productName,
  required,
  ssoProviderName,
}: TwoFactorPanelInput): TwoFactorPanelView {
  if (!hasPassword) {
    const providerQualifier = formatSsoProviderQualifier(ssoProviderName);
    const requirementNote = required
      ? " The organization's two-step sign-in requirement applies only to accounts with a password, so it does not apply to this account."
      : "";

    return {
      canDisable: false,
      canManage: false,
      description: `This account signs in with single sign-on${providerQualifier} and has no ${productName} password. Two-step sign-in is managed by your identity provider instead of here.${requirementNote}`,
      mode: "sso-only",
      statusLabel: "Managed by identity provider",
      statusTone: "neutral",
    };
  }

  return {
    canDisable: enabled && !required,
    canManage: true,
    description: `After your password, ${productName} asks for a 6-digit code from an authenticator app on your phone, such as 1Password, Google Authenticator or Microsoft Authenticator. Someone who learns your password still cannot sign in.${required ? " Your organization requires it." : ""}`,
    mode: "password",
    statusLabel: enabled ? "On" : "Off",
    statusTone: enabled ? "success" : "neutral",
  };
}
