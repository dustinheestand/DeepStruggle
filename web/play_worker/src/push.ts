/**
 * Web Push from the relay, on WebCrypto alone (the Worker and node both have it), so a phone can be
 * told it is its player's move while the page is closed.
 *
 * - The payload is encrypted for the subscription (RFC 8291, "aes128gcm", RFC 8188): an ephemeral
 *   P-256 key agreed with the browser's `p256dh`, mixed with its `auth` secret, one record.
 *   tests/web/js/play_push.ts reproduces RFC 8291 Appendix A byte for byte.
 * - The request carries a VAPID token (RFC 8292): an ES256 JWT for the push service's origin,
 *   signed with the relay's key, whose public half the page subscribed with.
 */

import type { PushSubscriptionJSON } from "../../ui/src/game/online_protocol";
export type { PushSubscriptionJSON };

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64url(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** A P-256 public key from its 65-byte uncompressed point, for ECDH. */
async function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("not an uncompressed P-256 point");
  return crypto.subtle.importKey("raw", raw, { name: "ECDH", namedCurve: "P-256" }, false, []);
}

/** The sender's side: its ECDH key pair and the public half as 65 bytes. */
export interface SenderKey {
  privateKey: CryptoKey;
  publicRaw: Uint8Array;
}

async function newSenderKey(): Promise<SenderKey> {
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer) };
}

/** A sender key from a private scalar and its public point (the RFC's example keys). */
export async function senderKeyFrom(privateD: Uint8Array, publicRaw: Uint8Array): Promise<SenderKey> {
  const jwk: JsonWebKey = {
    kty: "EC", crv: "P-256", d: b64url(privateD), x: b64url(publicRaw.slice(1, 33)), y: b64url(publicRaw.slice(33, 65)),
  };
  const privateKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
  return { privateKey, publicRaw };
}

/**
 * The aes128gcm body for one push: header (salt, record size, the sender's public key) and one
 * record. `salt` and `sender` are for the test; a push gets fresh ones.
 */
export async function encryptPayload(uaPublicB64: string, authB64: string, plaintext: Uint8Array,
                                     opts: { salt?: Uint8Array; sender?: SenderKey } = {}): Promise<Uint8Array> {
  const uaPublic = unb64url(uaPublicB64);
  const auth = unb64url(authB64);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const sender = opts.sender ?? await newSenderKey();
  const peer = await importPublic(uaPublic);
  // `public` is the standard's name (node, the Workers runtime); Cloudflare's typings spell it `$public`.
  const algo = { name: "ECDH", public: peer, $public: peer } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(algo, sender.privateKey, 256));
  // RFC 8291 §3.3-3.4.
  const prkKey = await hmac(auth, ecdh);
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, sender.publicRaw);
  const ikm = await hmac(prkKey, concat(keyInfo, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, enc.encode("Content-Encoding: aes128gcm\0\x01"))).slice(0, 16);
  const nonce = (await hmac(prk, enc.encode("Content-Encoding: nonce\0\x01"))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const padded = concat(plaintext, new Uint8Array([2]));   // the last (only) record's delimiter
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, padded));
  const rs = 4096;
  const header = concat(salt, new Uint8Array([(rs >>> 24) & 255, (rs >>> 16) & 255, (rs >>> 8) & 255, rs & 255, 65]), sender.publicRaw);
  return concat(header, cipher);
}

/** The VAPID Authorization header for `endpoint` (RFC 8292): `vapid t=<jwt>, k=<public key>`. */
export async function vapidAuthorization(endpoint: string, subject: string, publicB64: string, privateJwk: JsonWebKey,
                                         now = Math.floor(Date.now() / 1000)): Promise<string> {
  const head = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: now + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // WebCrypto's ECDSA signature is r || s, 64 bytes: JOSE's ES256 form.
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${head}.${claims}`)));
  return `vapid t=${head}.${claims}.${b64url(sig)}, k=${publicB64}`;
}

/** The push services a subscription may name: the relay sends to nowhere else. */
export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  const h = u.hostname;
  return u.protocol === "https:" && (h === "fcm.googleapis.com" || h.endsWith(".push.apple.com") ||
    h.endsWith(".push.services.mozilla.com") || h === "updates.push.services.mozilla.com" || h.endsWith(".notify.windows.com"));
}

export function isSubscription(v: unknown): v is PushSubscriptionJSON {
  const s = v as PushSubscriptionJSON;
  return !!s && typeof s.endpoint === "string" && s.endpoint.length < 1024 && isPushEndpoint(s.endpoint) &&
    typeof s.keys?.p256dh === "string" && s.keys.p256dh.length < 200 && typeof s.keys?.auth === "string" && s.keys.auth.length < 100;
}

/** Send one push. The status: 201 sent; 404 or 410, the subscription is gone. */
export async function sendPush(sub: PushSubscriptionJSON, payload: object,
                               vapid: { subject: string; publicKey: string; privateJwk: JsonWebKey }): Promise<number> {
  const body = await encryptPayload(sub.keys.p256dh, sub.keys.auth, enc.encode(JSON.stringify(payload)));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(sub.endpoint, vapid.subject, vapid.publicKey, vapid.privateJwk),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body,
  });
  return res.status;
}
