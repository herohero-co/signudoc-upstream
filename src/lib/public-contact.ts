import { ServiceConfigurationError } from "./services/service-config.ts";
import { getSettings, type ResolvedSettings } from "./settings.ts";
import { getEnv, type EnvSource } from "./utils/env.ts";

export { buildPublicSupportLink, type PublicSupportLink } from "./legal.ts";

type PublicContactSettings = Pick<ResolvedSettings, "supportAddress">;
type LoadPublicContactSettings = (
  env: EnvSource,
) => Promise<PublicContactSettings>;

/**
 * The address people are told to write to: SUPPORT_EMAIL when it is set,
 * otherwise the support address saved in the install's settings, or null when
 * neither is configured yet (or the database cannot be reached).
 *
 * Public legal pages read this so they render cleanly before first-run setup
 * completes, instead of failing with HTTP 500.
 */
export async function findPublicSupportAddress(
  env: EnvSource = process.env,
  loadSettings: LoadPublicContactSettings = getSettings,
): Promise<string | null> {
  const envAddress = getEnv(env).email.supportAddress;

  if (envAddress) {
    return envAddress;
  }

  try {
    const { supportAddress } = await loadSettings(env);

    return supportAddress?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The address people are told to write to. SUPPORT_EMAIL when it is set,
 * otherwise the support address saved in the install's settings.
 *
 * Throws ServiceConfigurationError when no support address is configured, for
 * callers that must deliver mail to a mailbox (contact form, account closure).
 */
export async function resolvePublicSupportAddress(
  env: EnvSource = process.env,
  loadSettings: LoadPublicContactSettings = getSettings,
): Promise<string> {
  const envAddress = getEnv(env).email.supportAddress;

  if (envAddress) {
    return envAddress;
  }

  const { supportAddress } = await loadSettings(env);
  const trimmed = supportAddress?.trim();

  if (trimmed) {
    return trimmed;
  }

  throw new ServiceConfigurationError("email", ["SUPPORT_EMAIL"]);
}
