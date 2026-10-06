import { buildReport } from "./_lib/rsra.js";

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const address = (url.searchParams.get("address") || "").trim().slice(0, 200);
  if (!address) { res.status(400).json({ error: "Give an address." }); return; }
  try {
    const r = await buildReport(address, { pin: url.searchParams.get("pin") || undefined, usePoint: url.searchParams.get("point") === "1" });
    res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
    res.status(r.error ? 422 : 200).json(r);
  } catch (e) {
    res.status(502).json({ error: `A source did not answer: ${e.message}` });
  }
}
