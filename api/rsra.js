// GET /api/rsra?address=...[&pin=...][&point=1]          -> the free slice (README "## The paywall")
// GET /api/rsra?address=...&pw=XXXX-XXXX-XXXX             -> the full draft, if the password
//                                                           was bought for this property (or is a comp)
// The password rides in the query, not a header, so the CDN never answers a paid
// request out of a cached free one.
import { buildReport, freeSlice } from "./_lib/rsra.js";
import { checkPassword, looksLikePassword, nonceIsPaid, subjectKey, query } from "./_lib/pay.js";

export default async function handler(req, res) {
  const q = query(req);
  const address = (q.get("address") || "").trim().slice(0, 200);
  if (!address) { res.status(400).json({ error: "Give an address." }); return; }
  const pw = q.get("pw") || "";
  // The page sends the key it already holds (k), so a wrong password fails in
  // milliseconds instead of after a full register search.
  const k = q.get("k") || "";
  if (pw && k && !(looksLikePassword(pw) && checkPassword(pw, k))) {
    res.setHeader("Cache-Control", "private, no-store");
    res.status(401).json({ pw_error: "That password doesn't open this property. Each password opens the property it was bought for; check the address in your email." });
    return;
  }
  try {
    const r = await buildReport(address, { pin: q.get("pin") || undefined, usePoint: q.get("point") === "1" });
    if (r.error || r.choose) {
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
      res.status(r.error ? 422 : 200).json(r);
      return;
    }
    const key = subjectKey(r.subject);
    let pwError = null;
    if (pw) {
      res.setHeader("Cache-Control", "private, no-store");
      const ok = looksLikePassword(pw) ? checkPassword(pw, key) : null;
      if (!ok) pwError = "That password doesn't open this property. Each password opens the property it was bought for; check the address in your email.";
      else {
        let paid = ok.kind === "comp";
        if (!paid) {
          try { paid = await nonceIsPaid(ok.nonce); }
          catch (e) { console.error("[rsra] paid check:", e.message); pwError = "Couldn't check the password right now. Try again in a minute."; }
          if (!paid && !pwError) pwError = "That password's payment hasn't gone through. If you just paid, wait a minute and try again.";
        }
        if (paid) {
          console.log(`[unlock] ${ok.kind} ${ok.nonce} ${key}`);
          res.setHeader("X-Access", ok.kind);
          res.status(200).json({ ...r, key, free: false });
          return;
        }
      }
    } else {
      res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    }
    res.status(200).json({ ...freeSlice(r), key, ...(pwError ? { pw_error: pwError } : {}) });
  } catch (e) {
    res.status(502).json({ error: `A source did not answer: ${e.message}` });
  }
}
