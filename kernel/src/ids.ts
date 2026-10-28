const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID: 48-bit millisecond time + 80 random bits, Crockford base32. Sorts by creation time and is
 * created by Neo itself, never by a host (no DO ids, no inode numbers), so it survives every move.
 */
export function ulid(now: number = Date.now()): string {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32))
    time = CROCKFORD[t % 32] + time;
  const random = crypto.getRandomValues(new Uint8Array(16));
  let rest = "";
  for (let i = 0; i < 16; i++) rest += CROCKFORD[random[i]! % 32];
  return time + rest;
}
