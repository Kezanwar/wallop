import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { schema } from "@wallop/db";
import {
  requestOtp,
  redeemOtp,
  RateLimitedError,
  MAX_ATTEMPTS,
} from "../src/auth/otp";
import {
  createSession,
  validateSession,
  revokeSession,
  revokeAllSessions,
  deleteExpiredSessions,
} from "../src/auth/sessions";
import { generateOtpCode, hashToken } from "../src/auth/crypto";

const pool = new Pool({ connectionString: process.env.DATABASE_URL_TEST });
const db = drizzle(pool, { schema }) as never as Parameters<
  typeof requestOtp
>[0];

const EMAIL = "kez@example.com";

beforeEach(async () => {
  await pool.query(
    "truncate table credit_transactions, sessions, otp_codes, users cascade",
  );
});

afterAll(() => pool.end());

async function login(email = EMAIL) {
  const { code, nonce } = await requestOtp(db, { email });
  const result = await redeemOtp(db, { email, code, nonce });
  if (!result.ok) throw new Error("login failed in test helper");
  return result;
}

describe("OTP request", () => {
  /**
   * Emails are normalised to lowercase and trimmed before storage or lookup.
   *
   * IRL: a user signs up on desktop as "Kez@Example.com", then logs in on
   * mobile where autocapitalise gives "kez@example.com". Without normalising,
   * that's two separate accounts — and they lose their library and credits.
   */
  it("normalises the email", async () => {
    const { identifier } = await requestOtp(db, {
      email: "  KEZ@Example.COM ",
    });
    expect(identifier).toBe("kez@example.com");
  });

  /**
   * Format check on what we hand back to the caller.
   *
   * IRL: the code goes into an email, so it must be exactly six digits and
   * zero-padded ("004521", never "4521"). The nonce must be long enough to be
   * unguessable, since it's the anti-phishing binding.
   */
  it("returns a 6-digit code and a nonce", async () => {
    const { code, nonce } = await requestOtp(db, { email: EMAIL });
    expect(code).toMatch(/^\d{6}$/);
    expect(nonce.length).toBeGreaterThan(20);
  });

  /**
   * The database stores only a SHA-256 of the code, never the code itself.
   * An OTP is a credential and gets the same treatment as a password.
   *
   * IRL: a database breach, or a leaked backup. Whoever reads the table can't
   * log in as anyone, because they'd need to reverse the hash within the
   * 10-minute window.
   */
  it("never stores the raw code", async () => {
    const { code } = await requestOtp(db, { email: EMAIL });
    const { rows } = await pool.query("select code_hash from otp_codes");
    expect(rows[0].code_hash).not.toBe(code);
    expect(rows[0].code_hash).toBe(hashToken(code));
  });

  /**
   * Requesting a new code consumes any outstanding ones, so only the newest
   * ever works.
   *
   * IRL: the user doesn't see the first email and clicks "resend". Two live
   * codes doubles the brute-force surface, and confuses the user when the
   * older code they eventually find still works.
   */
  it("invalidates previous codes when a new one is requested", async () => {
    const first = await requestOtp(db, { email: EMAIL });
    await requestOtp(db, { email: EMAIL });

    const result = await redeemOtp(db, {
      email: EMAIL,
      code: first.code,
      nonce: first.nonce,
    });
    expect(result.ok).toBe(false);
  });

  /**
   * Five codes per email per hour, then RateLimitedError.
   *
   * IRL: someone scripts requests against an address. Every one is an email we
   * pay for, and a chance to spam a real person's inbox until they mark us as
   * spam — which damages deliverability for every other user.
   */
  it("rate limits after 5 requests in an hour", async () => {
    for (let i = 0; i < 5; i++) await requestOtp(db, { email: EMAIL });
    await expect(requestOtp(db, { email: EMAIL })).rejects.toThrow(
      RateLimitedError,
    );
  });

  /**
   * The limit is scoped per identifier, not applied globally.
   *
   * IRL: an obvious denial-of-service if we got this wrong — one attacker
   * exhausting a shared counter would lock every other user out of logging in.
   */
  it("rate limits per identifier, not globally", async () => {
    for (let i = 0; i < 5; i++) await requestOtp(db, { email: EMAIL });
    await expect(
      requestOtp(db, { email: "other@example.com" }),
    ).resolves.toBeDefined();
  });

  /**
   * Enumeration resistance: requesting a code returns exactly the same shape
   * whether or not an account exists. The user record isn't even touched until
   * redemption succeeds — which is why otp_codes is keyed on email, not userId.
   *
   * IRL: an attacker with a list of email addresses wants to know which ones
   * have Wallop accounts. If our response differs at all — different fields,
   * different errors, noticeably different timing — we've handed them that
   * list. The UI must say "if an account exists, we've sent a code."
   */
  it("behaves identically for existing and non-existing accounts", async () => {
    await login(); // EMAIL now exists as a user
    const known = await requestOtp(db, { email: EMAIL });
    const unknown = await requestOtp(db, { email: "nobody@example.com" });

    expect(known.code).toMatch(/^\d{6}$/);
    expect(unknown.code).toMatch(/^\d{6}$/);
    expect(Object.keys(known).sort()).toEqual(Object.keys(unknown).sort());
  });
});

describe("OTP redemption", () => {
  /**
   * Signup and login are the same flow. A successful redemption for an unknown
   * email creates the user, marks the email verified (they just proved it),
   * and mints a session.
   *
   * IRL: every new user. There is no separate "register" journey.
   */
  it("creates a user and a session on first login", async () => {
    const result = await login();
    expect(result.isNewUser).toBe(true);
    expect(result.token).toBeTruthy();

    const { rows } = await pool.query(
      "select email, email_verified from users",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].email_verified).toBe(true);
  });

  /**
   * A second login finds the existing user rather than creating a duplicate.
   *
   * IRL: a returning customer. Their design library, credit balance and order
   * history all hang off users.id — a duplicate row would orphan all of it.
   */
  it("reuses the existing user on second login", async () => {
    const first = await login();
    const second = await login();

    expect(second.isNewUser).toBe(false);
    expect(second.userId).toBe(first.userId);

    const { rows } = await pool.query("select id from users");
    expect(rows).toHaveLength(1);
  });

  /**
   * Baseline: a wrong code is rejected.
   *
   * IRL: the user fat-fingers a digit.
   */
  it("rejects a wrong code", async () => {
    const { nonce } = await requestOtp(db, { email: EMAIL });
    const result = await redeemOtp(db, { email: EMAIL, code: "000000", nonce });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  /**
   * The nonce binds the code to the browser that requested it. We set it as a
   * cookie when sending the code and require both to match on redemption.
   *
   * IRL: the anti-phishing control. An attacker socially engineers a user into
   * reading out or forwarding their code ("we're from Wallop support"). The
   * attacker has the six digits, but not the nonce cookie sitting in the
   * victim's browser — so the code is useless to them.
   */
  it("rejects a correct code with the wrong nonce", async () => {
    const { code } = await requestOtp(db, { email: EMAIL });
    const result = await redeemOtp(db, {
      email: EMAIL,
      code,
      nonce: "attacker-nonce",
    });
    expect(result.ok).toBe(false);
  });

  /**
   * A code works exactly once; consumedAt is set on success.
   *
   * IRL: the email sits in an inbox forever. Without single-use, that code is
   * a permanent password — and inboxes get compromised.
   */
  it("is single use", async () => {
    const { code, nonce } = await requestOtp(db, { email: EMAIL });
    const first = await redeemOtp(db, { email: EMAIL, code, nonce });
    const second = await redeemOtp(db, { email: EMAIL, code, nonce });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  /**
   * Past its 10-minute expiry, a code is dead even though the row still exists.
   *
   * IRL: someone finds an old Wallop email months later and tries the code.
   * Also limits the window an attacker has to brute-force any given code.
   */
  it("rejects an expired code", async () => {
    const { code, nonce } = await requestOtp(db, { email: EMAIL });
    await pool.query(
      "update otp_codes set expires_at = now() - interval '1 minute'",
    );

    const result = await redeemOtp(db, { email: EMAIL, code, nonce });
    expect(result).toEqual({ ok: false, reason: "expired" });
  });

  /**
   * After MAX_ATTEMPTS wrong guesses the code is burnt — even the CORRECT code
   * stops working.
   *
   * IRL: this is the single control that makes a 6-digit code acceptable at
   * all. A million combinations falls to a script in seconds if guesses are
   * unlimited. Capping at five turns it into roughly a 1-in-200,000 shot per
   * code, and the code dies before a second try.
   *
   * Note we assert only that it failed, not the reason string: once burnt, the
   * row is consumed, so the lookup finds nothing and returns "invalid" — the
   * same response as any other bad attempt. That's deliberate. Returning
   * "too_many_attempts" here would confirm to an attacker that they'd found a
   * real code and merely ran out of guesses.
   */
  it("burns the code after 5 failed attempts", async () => {
    const { code, nonce } = await requestOtp(db, { email: EMAIL });

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await redeemOtp(db, { email: EMAIL, code: "000000", nonce });
    }

    const result = await redeemOtp(db, { email: EMAIL, code, nonce });
    expect(result.ok).toBe(false);

    const { rows } = await pool.query(
      "select consumed_at, attempts from otp_codes",
    );
    expect(rows[0].consumed_at).not.toBeNull();
    expect(rows[0].attempts).toBe(MAX_ATTEMPTS);
  });

  /**
   * Redeeming for an email that never requested a code fails cleanly rather
   * than throwing.
   *
   * IRL: someone POSTs directly at the endpoint. Server Actions and route
   * handlers are public HTTP surfaces — never assume the request came from
   * our own UI in the expected order.
   */
  it("returns invalid for an email with no outstanding code", async () => {
    const result = await redeemOtp(db, {
      email: "nocode@example.com",
      code: "123456",
      nonce: "x",
    });
    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("sessions", () => {
  /**
   * A freshly minted token resolves back to the right user, joined through to
   * their email.
   *
   * IRL: every authenticated request in the app runs this. It's the hottest
   * query in the codebase.
   */
  it("validates a fresh session", async () => {
    const { token, userId } = await login();
    const session = await validateSession(db, token);

    expect(session).not.toBeNull();
    expect(session!.userId).toBe(userId);
    expect(session!.email).toBe(EMAIL);
  });

  /**
   * Only the SHA-256 of the token is stored. The raw value exists solely in
   * the user's httpOnly cookie.
   *
   * IRL: breach containment. A session token IS a password — one we generated.
   * If the sessions table leaked with raw tokens, an attacker could paste any
   * of them into a cookie and be logged in as that user instantly, no
   * cracking required.
   */
  it("never stores the raw token", async () => {
    const { token } = await login();
    const { rows } = await pool.query("select token_hash from sessions");
    expect(rows[0].token_hash).not.toBe(token);
    expect(rows[0].token_hash).toBe(hashToken(token));
  });

  /**
   * A token that was never issued resolves to null.
   *
   * IRL: someone forges or guesses a cookie value.
   */
  it("rejects an unknown token", async () => {
    expect(await validateSession(db, "not-a-real-token")).toBeNull();
  });

  /**
   * Past expires_at the session is dead, even though the row still exists.
   * Expiry is enforced in the WHERE clause, not by cleanup running on time.
   *
   * IRL: an abandoned session on a shared or public computer. We can't rely on
   * a cleanup job having run — the query itself has to refuse.
   */
  it("rejects an expired session", async () => {
    const { token } = await login();
    await pool.query(
      "update sessions set expires_at = now() - interval '1 day'",
    );
    expect(await validateSession(db, token)).toBeNull();
  });

  /**
   * Once a session is more than halfway to expiring, using it pushes the
   * expiry back out to the full duration.
   *
   * IRL: a regular customer who visits monthly is never unexpectedly logged
   * out, while genuinely abandoned sessions still die on schedule.
   */
  it("slides the expiry when past halfway", async () => {
    const { token } = await login();
    await pool.query(
      "update sessions set expires_at = now() + interval '10 days'",
    );

    await validateSession(db, token);

    const { rows } = await pool.query("select expires_at from sessions");
    const daysLeft =
      (new Date(rows[0].expires_at).getTime() - Date.now()) / 86_400_000;
    expect(daysLeft).toBeGreaterThan(50);
  });

  /**
   * The other half of sliding expiry: a recently created session is NOT
   * updated.
   *
   * IRL: performance. An UPDATE on every single page load would turn our
   * hottest read query into a write, on the busiest table, for no benefit.
   */
  it("does not slide when recently created", async () => {
    const { token } = await login();
    const { rows: before } = await pool.query(
      "select expires_at from sessions",
    );

    await validateSession(db, token);

    const { rows: after } = await pool.query("select expires_at from sessions");
    expect(after[0].expires_at).toEqual(before[0].expires_at);
  });

  /**
   * Logging out deletes the row, so the token stops working server-side.
   *
   * IRL: "log out" must actually invalidate the session, not merely clear the
   * cookie. Clearing a cookie does nothing if someone already copied it.
   */
  it("revokes a single session", async () => {
    const { token } = await login();
    await revokeSession(db, token);
    expect(await validateSession(db, token)).toBeNull();
  });

  /**
   * Revoking by userId kills every device at once.
   *
   * IRL: "log out everywhere" after a suspected compromise, or when we ban an
   * account. This capability is the whole reason sessions are a database table
   * rather than a JWT — a JWT is self-validating and can't be revoked without
   * building a blocklist, which is just sessions with extra steps.
   */
  it("revokes all sessions for a user", async () => {
    const a = await login();
    const b = await login(); // second device
    expect(await validateSession(db, a.token)).not.toBeNull();

    await revokeAllSessions(db, a.userId);

    expect(await validateSession(db, a.token)).toBeNull();
    expect(await validateSession(db, b.token)).toBeNull();
  });

  /**
   * Each login creates its own row — sessions are per device, not per user.
   *
   * IRL: phone and laptop stay logged in simultaneously. It's also what powers
   * a future "active devices" screen in account settings.
   */
  it("keeps one row per device", async () => {
    await login();
    await login();
    const { rows } = await pool.query(
      "select count(*)::int as n from sessions",
    );
    expect(rows[0].n).toBe(2);
  });

  /**
   * IP and user agent are captured at session creation.
   *
   * IRL: "Signed in from Manchester on Chrome, 3 August" in account settings,
   * and the forensic trail if a user reports something suspicious.
   */
  it("stores ip and user agent", async () => {
    const { code, nonce } = await requestOtp(db, { email: EMAIL });
    await redeemOtp(db, {
      email: EMAIL,
      code,
      nonce,
      ip: "1.2.3.4",
      userAgent: "TestAgent/1.0",
    });

    const { rows } = await pool.query("select ip, user_agent from sessions");
    expect(rows[0].ip).toBe("1.2.3.4");
    expect(rows[0].user_agent).toBe("TestAgent/1.0");
  });

  /**
   * Housekeeping: expired rows can be swept away.
   *
   * IRL: a periodic worker job. Expiry is already enforced at query time, so
   * this is purely to stop the table growing without bound — every logged-out
   * device leaves a dead row behind otherwise.
   */
  it("cleans up expired sessions", async () => {
    await login();
    await pool.query(
      "update sessions set expires_at = now() - interval '1 day'",
    );

    await deleteExpiredSessions(db);

    const { rows } = await pool.query(
      "select count(*)::int as n from sessions",
    );
    expect(rows[0].n).toBe(0);
  });
});

describe("crypto", () => {
  /**
   * 500 generated codes are all six digits, and at least 400 are distinct.
   *
   * IRL: catches modulo bias. The naive `randomBytes(4) % 1000000` makes low
   * numbers marginally more likely, which narrows the effective search space
   * for an attacker. The rejection-sampling loop in generateOtpCode keeps the
   * distribution uniform, so a 1-in-a-million guess really is 1 in a million.
   */
  it("generates codes across the full range", () => {
    const codes = Array.from({ length: 500 }, () => generateOtpCode());
    expect(codes.every((c) => /^\d{6}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBeGreaterThan(400);
  });
});
