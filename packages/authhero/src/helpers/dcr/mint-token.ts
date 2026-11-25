import { nanoid } from "nanoid";
import { generateTicketId, hashTicketId } from "../self-service-tickets";

export interface GeneratedRegistrationToken {
  id: string;
  token: string;
  token_hash: string;
}

/**
 * Registration tokens (IATs, RATs) are self-service tickets: an invite or
 * edit link carries the token itself as its ticket id.
 */
export async function hashRegistrationToken(token: string): Promise<string> {
  return hashTicketId(token);
}

export async function mintRegistrationToken(): Promise<GeneratedRegistrationToken> {
  const token = generateTicketId();
  return {
    id: nanoid(),
    token,
    token_hash: await hashTicketId(token),
  };
}
