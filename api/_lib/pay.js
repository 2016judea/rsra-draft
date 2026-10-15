// The paywall, shared by api/rsra.js, api/checkout.js, api/stripe-webhook.js and
// api/session-status.js. Ported from msp-house-index/site/api/_lib.js (2026-10-11).
//
// The unit sold is ONE property's full draft. The password is stateless:
// XXXX-XXXX-XXXX, a five-character random nonce minted when the Checkout Session
// is created plus seven characters of an HMAC under ACCESS_SECRET of that nonce AND
// the property's key (county + PIN). So a paid password opens the property it was
// bought for and no other, and a password we never issued fails without a network
// call. A comp password (scripts/fulfil.py --comp-pw) opens any property.
import crypto from "node:crypto";

export const SITE = process.env.SITE_URL || "https://rsra-draft.vercel.app";
export const PRODUCT = "rsra-draft";
export const PRICE_USD = 40; // README "## Price": a hypothesis under test, not a fact
const ALPHA = "23456789BCDFGHJKMNPQRSTVWXYZ"; // no 0/O, 1/I/L, no vowels A/E/U

// The property a password is bound to: county FIPS + county PIN, else the
// geocoded address when the subject has no parcel.
export function subjectKey(subject) {
  if (!subject) return "";
  if (subject.parcel?.pin) return `pin:${subject.county_fips || ""}:${subject.parcel.pin}`;
  return `addr:${String(subject.matched || "").toUpperCase().replace(/[^0-9A-Z]+/g, " ").trim()}`;
}

function stripeKey() {
  const k = process.env.STRIPE_SECRET_KEY;
  if (!k) throw new Error("STRIPE_SECRET_KEY is not set");
  return k;
}

export async function stripe(path, { method = "GET", form } = {}) {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, {
    method,
    headers: { Authorization: `Bearer ${stripeKey()}`, ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}) },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`stripe ${path}: ${j.error?.message || r.status}`);
  return j;
}

const chars = (buf, n) => Array.from(buf.subarray(0, n), (b) => ALPHA[b % ALPHA.length]).join("");

function mac(domain, nonce) {
  const s = process.env.ACCESS_SECRET;
  if (!s) throw new Error("ACCESS_SECRET is not set");
  return chars(crypto.createHmac("sha256", s).update(domain + nonce).digest(), 7);
}
const fmt = (raw) => `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;

export function newPassword(key) {
  const nonce = chars(crypto.randomBytes(5), 5);
  return { nonce, password: fmt(nonce + mac(`prop:${key}:`, nonce)) };
}

const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// { nonce, kind } if the HMAC holds for this property, else null.
// kind "paid": minted at checkout for this property; unlocks once Stripe says paid.
// kind "comp": issued by hand, opens any property, no session behind it.
export function checkPassword(pw, key) {
  const raw = String(pw || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (raw.length !== 12) return null;
  const nonce = raw.slice(0, 5), tail = raw.slice(5);
  if (key && same(tail, mac(`prop:${key}:`, nonce))) return { nonce, kind: "paid" };
  if (same(tail, mac("comp:", nonce))) return { nonce, kind: "comp" };
  return null;
}
export const looksLikePassword = (pw) => String(pw || "").toUpperCase().replace(/[^0-9A-Z]/g, "").length === 12;

const paidCache = new Map(); // nonce -> true, per warm instance
const LAUNCH = 1792022400; // 2026-10-15; no session of ours is older

export const unlocked = (s) => s.metadata?.product === PRODUCT &&
  (s.payment_status === "paid" || (s.payment_status === "no_payment_required" && s.metadata?.comp === "1"));

export async function nonceIsPaid(nonce) {
  if (paidCache.get(nonce)) return true;
  try {
    const q = encodeURIComponent(`metadata['pw_nonce']:'${nonce}' AND metadata['product']:'${PRODUCT}' AND status:'succeeded'`);
    const s = await stripe(`payment_intents/search?query=${q}&limit=1`);
    if (s.data?.length) return paidCache.set(nonce, true), true;
  } catch (e) { console.error("[pw] search failed:", e.message); }
  let after = "";
  for (let page = 0; page < 20; page++) {
    const l = await stripe(`checkout/sessions?status=complete&limit=100&created[gte]=${LAUNCH}${after}`);
    if (l.data.find((s) => s.metadata?.pw_nonce === nonce && unlocked(s))) return paidCache.set(nonce, true), true;
    if (!l.has_more) break;
    after = `&starting_after=${l.data[l.data.length - 1].id}`;
  }
  return false;
}

export function reportLink(meta, pw) {
  const q = new URLSearchParams({ address: meta.address || "" });
  if (meta.pin) q.set("pin", meta.pin);
  if (pw) q.set("pw", pw);
  return `${SITE}/?${q}`;
}

async function mailgun(fields) {
  const { MAILGUN_API_KEY, MAILGUN_DOMAIN } = process.env;
  if (!MAILGUN_API_KEY || !MAILGUN_DOMAIN) throw new Error("Mailgun is not configured");
  const r = await fetch(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`, {
    method: "POST",
    headers: { Authorization: "Basic " + Buffer.from("api:" + MAILGUN_API_KEY).toString("base64") },
    body: new URLSearchParams(fields),
  });
  const out = await r.text();
  if (!r.ok) throw new Error(`mailgun ${r.status}: ${out.slice(0, 200)}`);
  return JSON.parse(out).id || "";
}

// The password email, once per session: a pw_emailed marker goes into the session
// metadata before the send so a second caller backs off. Aidan gets a sale notice.
export async function sendPasswordOnce(session, { who }) {
  if (!unlocked(session)) return { sent: false, why: "not ours or not paid" };
  const fresh = await stripe(`checkout/sessions/${session.id}`);
  if (fresh.metadata?.pw_emailed) return { sent: false, why: "already emailed " + fresh.metadata.pw_emailed };
  const mark = (v) => stripe(`checkout/sessions/${session.id}`, { method: "POST", form: { "metadata[pw_emailed]": v } });
  await mark(`${new Date().toISOString()} by ${who}`);
  const to = fresh.customer_details?.email;
  const m = fresh.metadata;
  const pw = m.password;
  const link = reportLink(m, pw);
  const where = m.label || m.address;
  const from = process.env.MAILGUN_FROM || "aidan@brickandmortar.dev";
  const text = [
    `Thanks for buying the draft RSRA for ${where}.`,
    ``,
    `Your password: ${pw}`,
    ``,
    `Open the full draft: ${link}`,
    ``,
    `That link opens it on any device. It reruns every register live each time you open it, so the records-searched date is always today's. Print it to PDF from the page for your Environmental Professional.`,
    ``,
    `The password opens this property only. Your receipt comes separately from Stripe. Reply to this email with any question.`,
    ``,
    `Aidan`,
    `Brick & Mortar`,
  ].join("\n");
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const html = `<div style="font:16px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:520px">
<p>Thanks for buying the draft RSRA for <b>${esc(where)}</b>.</p>
<p>Your password:<br><b style="font:600 22px ui-monospace,Menlo,monospace;letter-spacing:2px">${pw}</b></p>
<p><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;background:#16181d;color:#fff;border-radius:6px;text-decoration:none;font-weight:600">Open the full draft</a></p>
<p>That link opens it on any device. It reruns every register live each time you open it, so the records-searched date is always today's. Print it to PDF from the page for your Environmental Professional.</p>
<p>The password opens this property only. Your receipt comes separately from Stripe. Reply to this email with any question.</p>
<p>Aidan<br>Brick &amp; Mortar</p></div>`;
  let id;
  try {
    id = await mailgun({ from: `Aidan at Brick & Mortar <${from}>`, to, subject: `Your draft RSRA: ${where}`, text, html, "h:Reply-To": from });
  } catch (e) {
    await mark("").catch(() => {});
    throw e;
  }
  await stripe(`checkout/sessions/${session.id}`, { method: "POST", form: { "metadata[pw_mailgun_id]": id.slice(0, 400) } }).catch(() => {});
  console.log(`[pw] emailed ${to} for ${session.id} by ${who}`);
  await mailgun({
    from: `RSRA Draft Tool <${from}>`, to: process.env.NOTIFY_EMAIL || "aidan@brickandmortar.dev",
    subject: `Sale: RSRA draft, $${(fresh.amount_total || 0) / 100} from ${to}`,
    text: `${to} bought the draft for ${where} (${fresh.payment_status}). Session ${fresh.id}. Password ${pw} was emailed by the ${who}.\nReprint: python3 scripts/fulfil.py ${fresh.id}`,
  }).catch((e) => console.error("[pw] sale notice failed:", e.message));
  return { sent: true };
}

// Vercel's Node runtime hands an ESM function a req with no parsed query in some
// paths; read everything off the URL.
export const query = (req) => new URL(req.url, "http://x").searchParams;
export const readBody = (req) => new Promise((ok, no) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); req.on("error", no); });
