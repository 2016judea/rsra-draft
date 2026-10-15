// POST /api/stripe-webhook  (checkout.session.completed)
// Emails the buyer their password even if they closed the tab. Signature verified
// against STRIPE_WEBHOOK_SECRET (comma-separated for more than one endpoint).
// A non-2xx makes Stripe retry for up to three days.
import crypto from "node:crypto";
import { sendPasswordOnce, PRODUCT, readBody } from "./_lib/pay.js";

function verify(body, header, secrets) {
  const h = String(header || "").split(",");
  const t = (h.find((kv) => kv.startsWith("t=")) || "").slice(2);
  const sigs = h.filter((kv) => kv.startsWith("v1=")).map((kv) => kv.slice(3));
  if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 600) return false;
  return secrets.some((sec) => {
    const want = crypto.createHmac("sha256", sec).update(`${t}.${body}`).digest("hex");
    return sigs.some((s) => s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)));
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  const body = (await readBody(req)).toString("utf8");
  const secrets = String(process.env.STRIPE_WEBHOOK_SECRET || "").split(",").filter(Boolean);
  if (!verify(body, req.headers["stripe-signature"], secrets)) { res.status(400).json({ error: "bad signature" }); return; }
  const ev = JSON.parse(body);
  const s = ev.data?.object;
  if (ev.type !== "checkout.session.completed" || s?.metadata?.product !== PRODUCT) { res.status(200).json({ ignored: true }); return; }
  try {
    res.status(200).json(await sendPasswordOnce(s, { who: "webhook" }));
  } catch (e) {
    console.error("[webhook]", e.message);
    res.status(500).json({ error: e.message });
  }
}

export const config = { api: { bodyParser: false } };
