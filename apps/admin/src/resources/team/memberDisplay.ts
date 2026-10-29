import type { TeamMemberRecord } from "../../auth0DataProvider";

/** The text, trimmed, or undefined when there is none worth showing. */
const text = (value?: string | null) => value?.trim() || undefined;

/** The first character, as a whole code point so an emoji is not cut in two. */
const firstCharacter = (value: string) => [...value][0] ?? "";

/** The name shown for a member: the name, else the address, else the id. */
export function memberLabel(member: TeamMemberRecord): string {
  return text(member.name) ?? text(member.email) ?? member.user_id;
}

/**
 * Up to two initials: the first letters of the first and last word of the
 * name, else the first letter of the address. A question mark only when there
 * is nothing to take them from.
 */
export function memberInitials(member: TeamMemberRecord): string {
  const words = (member.name ?? "").split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return (
      firstCharacter(words[0]!) + firstCharacter(words[words.length - 1]!)
    ).toUpperCase();
  }
  const first = firstCharacter(words[0] ?? text(member.email) ?? "");
  return first ? first.toUpperCase() : "?";
}
