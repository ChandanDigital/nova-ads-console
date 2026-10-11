import { describe, it, expect } from "vitest";
import { env } from "cloudflare:workers";
import { canonicalJson, decryptText, encryptText, fingerprint, timingSafeEqual } from "../src/lib/crypto";

describe("encryption at rest", () => {
  it("round-trips and never stores plaintext", async () => {
    const sealed = await encryptText(env, "1//secret-refresh-token", "gconn:1:refresh");
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(sealed).not.toContain("secret-refresh-token");
    expect(await decryptText(env, sealed, "gconn:1:refresh")).toBe("1//secret-refresh-token");
  });
  it("uses a fresh IV every time", async () => {
    expect(await encryptText(env, "x", "a")).not.toBe(await encryptText(env, "x", "a"));
  });
  it("binds ciphertext to its row (AAD): a value copied to another row fails", async () => {
    const sealed = await encryptText(env, "token", "gconn:1:refresh");
    await expect(decryptText(env, sealed, "gconn:2:refresh")).rejects.toMatchObject({ code: "decrypt_failed" });
  });
  it("detects tampering", async () => {
    const sealed = await encryptText(env, "token", "a");
    const parts = sealed.split(".");
    parts[3] = parts[3]!.slice(0, -2) + (parts[3]!.endsWith("AA") ? "BB" : "AA");
    await expect(decryptText(env, parts.join("."), "a")).rejects.toMatchObject({ code: "decrypt_failed" });
  });
  it("explains a changed key instead of silently failing", async () => {
    const sealed = await encryptText(env, "token", "a");
    const other = { ...env, TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) };
    await expect(decryptText(other, sealed, "a")).rejects.toMatchObject({ code: "encryption_key_changed" });
  });
  it("supports key rotation through TOKEN_ENCRYPTION_KEY_PREVIOUS", async () => {
    const sealed = await encryptText(env, "token", "a");
    const rotated = { ...env, TOKEN_ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).fill(9))), TOKEN_ENCRYPTION_KEY_PREVIOUS: env.TOKEN_ENCRYPTION_KEY };
    expect(await decryptText(rotated, sealed, "a")).toBe("token");
  });
  it("rejects keys that are not 32 bytes", async () => {
    await expect(encryptText({ ...env, TOKEN_ENCRYPTION_KEY: btoa("short") }, "x", "a")).rejects.toMatchObject({ code: "bad_encryption_key" });
  });
});

describe("hashing helpers", () => {
  it("canonical JSON ignores key order", async () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: 2 } })).toBe(canonicalJson({ a: { c: 2, d: 1 }, b: 1 }));
    expect(await fingerprint({ a: 1, b: 2 })).toBe(await fingerprint({ b: 2, a: 1 }));
    expect(await fingerprint({ a: 1 })).not.toBe(await fingerprint({ a: 2 }));
  });
  it("timingSafeEqual", async () => {
    expect(await timingSafeEqual("abc", "abc")).toBe(true);
    expect(await timingSafeEqual("abc", "abd")).toBe(false);
    expect(await timingSafeEqual("abc", "abcd")).toBe(false);
  });
});
