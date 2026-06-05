import { cookies } from "next/headers";
import { query } from "./pg";

const SESSION_COOKIE = "sid";

export interface SessionUser {
  userId: string;
  blueskyDid: string | null;
  blueskyHandle: string | null;
}

/**
 * Read the session cookie and look up (or create) the anonymous user.
 * Never returns null — every request gets a user.
 */
export async function getSession(): Promise<SessionUser> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;

  if (!sessionId) {
    // Middleware should always set this, but handle edge case
    throw new Error("No session cookie — middleware may not be running");
  }

  // Try to find existing user
  const existing = await query(
    "SELECT id, bluesky_did, bluesky_handle FROM users WHERE session_id = $1",
    [sessionId]
  );

  if (existing.rows[0]) {
    return {
      userId: existing.rows[0].id,
      blueskyDid: existing.rows[0].bluesky_did,
      blueskyHandle: existing.rows[0].bluesky_handle,
    };
  }

  // Create anonymous user
  const res = await query(
    `INSERT INTO users (session_id, name, email)
     VALUES ($1, 'Anonymous', '')
     ON CONFLICT (session_id) DO UPDATE SET updated_at = now()
     RETURNING id, bluesky_did, bluesky_handle`,
    [sessionId]
  );

  return {
    userId: res.rows[0].id,
    blueskyDid: res.rows[0].bluesky_did,
    blueskyHandle: res.rows[0].bluesky_handle,
  };
}
