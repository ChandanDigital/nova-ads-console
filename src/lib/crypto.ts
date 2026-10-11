import type { Env } from "../env";
import { NodiError } from "./errors";

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64uEncode = (bytes: ArrayBuffer | Uint8Array): string => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const b64uDecode = (text: string): Uint8Array => {
  const pad = "=".repeat((4 - (text.length % 4)) % 4);
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));
/** URL-safe random secret with `bytes` bytes of entropy. */
export const randomToken = (bytes = 32): string => b64uEncode(randomBytes(bytes));
export const randomId = (): string => crypto.randomUUID();

export const sha256Hex = async (text: string): Promise<string> => {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};
export const sha256B64u = async (text: string): Promise<string> =>
  b64uEncode(await crypto.subtle.digest("SHA-256", enc.encode(text)));

/** Constant-time comparison of two strings (compares SHA-256 digests, so length does not leak). */
export const timingSafeEqual = async (a: string, b: string): Promise<boolean> => {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
};

// ---------------------------------------------------------------- AES-256-GCM at rest
// Format: v1.<keyId>.<iv>.<ciphertext+tag>  (all base64url). AAD binds a value to its row.
const keyCache = new Map<string, Promise<{ id: string; key: CryptoKey }>>();

const importKey = (raw: string): Promise<{ id: string; key: CryptoKey }> => {
  let hit = keyCache.get(raw);
  if (!hit) {
    hit = (async () => {
      let bytes: Uint8Array;
      try {
        bytes = Uint8Array.from(atob(raw.trim()), (c) => c.charCodeAt(0));
      } catch {
        throw new NodiError("bad_encryption_key", "TOKEN_ENCRYPTION_KEY is not valid base64.", 500);
      }
      if (bytes.length !== 32) {
        throw new NodiError("bad_encryption_key", "TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.", 500);
      }
      const id = (await sha256Hex("keyid:" + raw.trim())).slice(0, 8);
      const key = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
      return { id, key };
    })();
    keyCache.set(raw, hit);
  }
  return hit;
};

export const encryptionKeyProblem = async (env: Env): Promise<string | null> => {
  if (!env.TOKEN_ENCRYPTION_KEY) return "TOKEN_ENCRYPTION_KEY is not set.";
  try {
    await importKey(env.TOKEN_ENCRYPTION_KEY);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "invalid key";
  }
};

export const encryptText = async (env: Env, plaintext: string, aad: string): Promise<string> => {
  if (!env.TOKEN_ENCRYPTION_KEY) throw new NodiError("missing_encryption_key", "TOKEN_ENCRYPTION_KEY secret is not set.", 500);
  const { id, key } = await importKey(env.TOKEN_ENCRYPTION_KEY);
  const iv = randomBytes(12);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext));
  return `v1.${id}.${b64uEncode(iv)}.${b64uEncode(ct)}`;
};

export const decryptText = async (env: Env, sealed: string, aad: string): Promise<string> => {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new NodiError("bad_ciphertext", "Stored secret has an unknown format.", 500);
  const candidates = [env.TOKEN_ENCRYPTION_KEY, env.TOKEN_ENCRYPTION_KEY_PREVIOUS].filter(Boolean) as string[];
  for (const raw of candidates) {
    const { id, key } = await importKey(raw);
    if (id !== parts[1]) continue;
    try {
      const pt = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64uDecode(parts[2]!), additionalData: enc.encode(aad) },
        key,
        b64uDecode(parts[3]!),
      );
      return dec.decode(pt);
    } catch {
      throw new NodiError("decrypt_failed", "A stored secret could not be decrypted (wrong key or tampered data).", 500);
    }
  }
  throw new NodiError(
    "encryption_key_changed",
    "TOKEN_ENCRYPTION_KEY differs from the key that sealed the stored Google connection. Restore the old key (or set it as TOKEN_ENCRYPTION_KEY_PREVIOUS) or reconnect Google.",
    500,
  );
};

// ---------------------------------------------------------------- canonical JSON + hashing
export const canonicalJson = (value: unknown): string => {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, walk((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
};
export const fingerprint = (value: unknown): Promise<string> => sha256Hex(canonicalJson(value));
