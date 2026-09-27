/**
 * The `Retry-After` header, in seconds.
 *
 * RFC 9110 allows two forms and servers use both: a delay in seconds, and an
 * HTTP-date. Only the first was read, so a date-form header was silently
 * discarded and treated as though the server had said nothing.
 *
 * Nothing is invented here. A missing, malformed or past-dated header returns
 * null, and the caller backs off on its own schedule rather than on a number
 * this function made up.
 *
 * Not exported from the package. It lives in its own module so the parsing can
 * be tested directly without widening the published surface: every export is a
 * compatibility commitment kept forever, and a helper that exists for a test is
 * a poor reason to make one. The `exports` map exposes only `.` and
 * `./package.json`, so a consumer cannot reach this file.
 */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
  if (header === null) return null;
  const raw = header.trim();
  if (!raw) return null;

  /* The delay-seconds form. Integer only: RFC 9110 defines it as digits, and
   * accepting "1.5" or "1e3" would be reading something the grammar does not
   * allow and the sender did not mean. */
  if (/^\d+$/.test(raw)) {
    const seconds = Number(raw);
    return Number.isSafeInteger(seconds) ? seconds : null;
  }

  /*
   * The HTTP-date form, but only when the value actually looks like one.
   *
   * Date.parse is far more permissive than RFC 9110, and permissive in the
   * worst direction: it reads "-5" as 30 April 2001 and "1.5" as 4 January
   * 2001. Both are in the past, so clamping at zero turned a malformed header
   * into "retry immediately", which is the most aggressive possible answer and
   * a number the server never gave.
   *
   * Every date form the specification allows carries a weekday and a month
   * name, so requiring letters is enough to keep numeric junk away from the
   * date parser without narrowing what a real server can say.
   */
  if (!/[A-Za-z]{3}/.test(raw)) return null;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  /* A date already past means retry now, which is zero rather than a negative
   * wait. That is the server's instruction, not an invention. */
  return Math.max(0, Math.round((at - now) / 1000));
}
