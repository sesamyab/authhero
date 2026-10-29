import type { TeamMemberRecord } from "../../auth0DataProvider";

/** The name shown for a member: the name, else the address, else the id. */
export function memberLabel(member: TeamMemberRecord): string {
  return member.name || member.email || member.user_id;
}

/**
 * Up to two initials: the first letters of the first and last word of the
 * name, else the first letter of the address. A question mark only when there
 * is nothing to take them from.
 */
export function memberInitials(member: TeamMemberRecord): string {
  const words = (member.name ?? "").split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return (words[0]![0]! + words[words.length - 1]![0]!).toUpperCase();
  }
  const single = words[0] ?? member.email ?? "";
  const first = single.trim().charAt(0);
  return first ? first.toUpperCase() : "?";
}
