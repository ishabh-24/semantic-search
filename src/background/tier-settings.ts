import type { TierSettings } from "../shared/embedding-tier";

// Persisted embedding-tier choice. chrome.storage.local (not sync): the
// cloud API key is a credential for the user's own AWS stack and shouldn't
// ride Chrome's sync fabric to every signed-in profile.

const TIER_KEY = "embeddingTier";

export async function getTierSettings(): Promise<TierSettings> {
  const stored = await chrome.storage.local.get(TIER_KEY);
  return (stored[TIER_KEY] as TierSettings | undefined) ?? { tier: "local" };
}

export async function setTierSettings(settings: TierSettings): Promise<void> {
  await chrome.storage.local.set({ [TIER_KEY]: settings });
}
