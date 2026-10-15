// GET /api/session-status?session_id=cs_... -> { paid, email, mailed }
// Never returns the password: the email is the delivery. If the webhook has not
// emailed it yet, this sends it (after a short wait so the two don't both send).
import { stripe, sendPasswordOnce, unlocked, PRODUCT, query } from "./_lib/pay.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function handler(req, res) {
  const id = String(query(req).get("session_id") || "");
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(id)) { res.status(400).json({ error: "bad session id" }); return; }
  try {
    const s = await stripe(`checkout/sessions/${id}`);
    if (s.metadata?.product !== PRODUCT) { res.status(404).json({ error: "not found" }); return; }
    const paid = unlocked(s);
    let mail = null;
    if (paid) {
      if (!s.metadata?.pw_emailed) await wait(4000);
      try { mail = await sendPasswordOnce(s, { who: "status" }); } catch (e) { console.error("[status] mail:", e.message); mail = { sent: false, error: e.message.slice(0, 200) }; }
    }
    res.status(200).json({ paid, status: s.status, email: s.customer_details?.email || null, mailed: !!(mail?.sent || /already/.test(mail?.why || "")) });
  } catch (e) {
    console.error("[status]", e.message);
    res.status(502).json({ error: "Could not check the payment. Refresh in a minute." });
  }
}
