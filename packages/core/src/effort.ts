/**
 * An opt-in prep-window suggestion: hour-long jobs get three days, jobs of three hours or
 * more get a week. An explicit lead (including zero) always wins. Invalid/incomplete form
 * values and quick jobs have no suggestion. This never changes a task or its planner inputs.
 */
export function suggestLeadTime({
  effortMinutes,
  leadTimeDays,
}: {
  effortMinutes: number | null | undefined;
  leadTimeDays: number | null | undefined;
}): number | null {
  if (
    leadTimeDays != null ||
    effortMinutes == null ||
    !Number.isInteger(effortMinutes) ||
    effortMinutes < 60 ||
    effortMinutes > 1440
  )
    return null;
  return effortMinutes >= 180 ? 7 : 3;
}
