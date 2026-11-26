// Bundled by tests/web/test_play_push.py: the relay's Web Push (web/play_worker/src/push.ts), under node.
//   node play_push.mjs <public dir>
// Encryption reproduces RFC 8291 Appendix A byte for byte; a VAPID token verifies with its public key
// and names the push service's origin; only push services are accepted as endpoints.
import { b64url, encryptPayload, isPushEndpoint, senderKeyFrom, unb64url, vapidAuthorization } from "../../../web/play_worker/src/push";

const A = {
  plaintext: "V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24",
  asPublic: "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  header: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  ciphertext: "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ",
};

const sender = await senderKeyFrom(unb64url(A.asPrivate), unb64url(A.asPublic));
const body = await encryptPayload(A.uaPublic, A.auth, unb64url(A.plaintext), { salt: unb64url(A.salt), sender });
const want = new Uint8Array([...unb64url(A.header), ...unb64url(A.ciphertext)]);

// VAPID: a fresh key, a token for an FCM endpoint, verified with the public half.
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
const pub = b64url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey) as ArrayBuffer));
const auth = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", "https://example.org/", pub, jwk, 1_000_000);
const m = auth.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)!;
const verified = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, kp.publicKey, unb64url(m[3]),
                                           new TextEncoder().encode(`${m[1]}.${m[2]}`));
const claims = JSON.parse(new TextDecoder().decode(unb64url(m[2])));

const checks = {
  rfc8291_body: b64url(body) === b64url(want),
  vapid_signature: verified,
  vapid_audience: claims.aud === "https://fcm.googleapis.com" && claims.exp === 1_000_000 + 12 * 3600 && claims.sub === "https://example.org/",
  vapid_key: m[4] === pub,
  endpoints: isPushEndpoint("https://fcm.googleapis.com/fcm/send/x") && isPushEndpoint("https://web.push.apple.com/abc") && isPushEndpoint("https://jmt17.google.com/fcm/send/x") &&
    !isPushEndpoint("https://evilgoogle.com/x") && !isPushEndpoint("https://google.com.evil.example/x") &&
    isPushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x") && !isPushEndpoint("https://evil.example/push") &&
    !isPushEndpoint("http://fcm.googleapis.com/x") && !isPushEndpoint("https://fcm.googleapis.com.evil.example/x"),
};
console.log(JSON.stringify({ checks, body: b64url(body) }));
