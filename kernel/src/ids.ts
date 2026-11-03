const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now: number = Date.now()) {
  let time = "";
  for (let t = now, i = 0; i < 10; i++, t = Math.floor(t / 32))
    time = CROCKFORD[t % 32] + time;
  let rest = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16)))
    rest += CROCKFORD[byte % 32];
  return time + rest;
}
