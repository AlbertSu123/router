export type ResetCredit = { expiresAt?: number | null; supported?: boolean };
export type ResetCredits = {
  available: number;
  applicable?: number;
  credits: ResetCredit[];
  detailsComplete: boolean;
};

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function parseResetCredits(summary: any, details?: any): ResetCredits | undefined {
  const available = count(details?.available_count) ?? count(summary?.available_count);
  if (available === undefined) return;
  const source = Array.isArray(details?.credits) ? details.credits : summary?.credits;
  const credits: ResetCredit[] = [];
  for (const credit of Array.isArray(source) ? source : []) {
    if (credit?.status !== "available") continue;
    const raw = credit.expires_at;
    const epoch = typeof raw === "number" ? raw : typeof raw === "string" ? Date.parse(raw) / 1000 : NaN;
    credits.push({
      expiresAt: raw === null ? null : Number.isFinite(epoch) && epoch > 0 ? epoch : undefined,
      supported: typeof credit.is_supported_by_plan === "boolean" ? credit.is_supported_by_plan : undefined,
    });
  }
  credits.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return {
    available, applicable: count(summary?.applicable_available_count), credits,
    detailsComplete: credits.length === available && credits.every(c => c.expiresAt !== undefined),
  };
}
