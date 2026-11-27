export type ClaudeKeychainCandidate<T> = {
  value: T;
  /** Access-token expiry as stored by Claude Code (epoch ms or ISO string). */
  expiresAt?: number | string;
};

function expiryMs(expiresAt: number | string | undefined): number | undefined {
  if (typeof expiresAt === "number") {
    return Number.isFinite(expiresAt) ? expiresAt : undefined;
  }
  if (typeof expiresAt === "string" && expiresAt.trim()) {
    const numeric = Number(expiresAt);
    if (Number.isFinite(numeric)) {
      return numeric;
    }
    const parsed = Date.parse(expiresAt);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Claude Code can leave several "Claude Code-credentials*" Keychain items
 * behind (for example after switching accounts), and an old one may hold a
 * token that expired months ago. Prefer the credential that stays valid the
 * longest: unexpired tokens first, then the latest expiry. Candidates without
 * an expiry rank after known-valid ones but before known-expired ones, and
 * ties keep the incoming order so the existing service/account ranking still
 * breaks them.
 */
export function pickFreshestClaudeCredential<T>(
  candidates: Array<ClaudeKeychainCandidate<T>>,
  now = Date.now()
): T | null {
  const ranked = candidates.map((candidate, index) => {
    const expiry = expiryMs(candidate.expiresAt);
    const tier = expiry === undefined ? 1 : expiry > now ? 2 : 0;
    return { candidate, index, expiry: expiry ?? Number.NEGATIVE_INFINITY, tier };
  });
  ranked.sort((a, b) => b.tier - a.tier || b.expiry - a.expiry || a.index - b.index);
  return ranked[0]?.candidate.value ?? null;
}
