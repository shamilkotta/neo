
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("An AES key must be 32 bytes");
  return crypto.subtle.importKey(
    "raw",
    raw as Uint8Array<ArrayBuffer>,
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
}

export async function seal(
  key: CryptoKey,
  plaintext: Uint8Array | string,
  aad = "",
): Promise<string> {
  const iv = randomBytes(12);
  const data =
    typeof plaintext === "string" ? encoder.encode(plaintext) : plaintext;
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    data as Uint8Array<ArrayBuffer>,
  );
  return `${toBase64(iv)}.${toBase64(new Uint8Array(ct))}`;
}

export async function open(
  key: CryptoKey,
  sealed: string,
  aad = "",
): Promise<Uint8Array> {
  const [iv, ct] = sealed.split(".");
  if (!iv || !ct) throw new Error("Malformed ciphertext");
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64(iv),
      additionalData: encoder.encode(aad),
    },
    key,
    fromBase64(ct),
  );
  return new Uint8Array(pt);
}

export async function openText(
  key: CryptoKey,
  sealed: string,
  aad = "",
): Promise<string> {
  return decoder.decode(await open(key, sealed, aad));
}

export const PASSPHRASE_ITERATIONS = 100_000;

export async function passphraseKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = PASSPHRASE_ITERATIONS,
): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as Uint8Array<ArrayBuffer>,
      iterations,
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function hmacSha256Hex(
  secret: string,
  body: Uint8Array,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, body as Uint8Array<ArrayBuffer>),
  );
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 24): string {
  return toBase64(randomBytes(bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
