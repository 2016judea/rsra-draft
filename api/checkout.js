// POST /api/checkout {address, pin?, key, label} -> { clientSecret } for Stripe embedded Checkout.
// One property's full draft, PRICE_USD once. The password is minted here, bound to the
// property's key, so it can ride in the invoice footer as a second copy.
import { SITE, PRODUCT, PRICE_USD, stripe, newPassword, readBody, reportLink } from "./_lib/pay.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "POST only" }); return; }
  let b = req.body;
  if (!b || typeof b !== "object") { try { b = JSON.parse((await readBody(req)).toString("utf8") || "{}"); } catch { b = {}; } }
  const address = String(b.address || "").trim().slice(0, 200);
  const pin = String(b.pin || "").replace(/[^0-9A-Za-z.-]/g, "").slice(0, 40);
  const key = String(b.key || "").slice(0, 120);
  const label = String(b.label || address).trim().slice(0, 120);
  if (!address || !/^(pin|addr):/.test(key)) { res.status(400).json({ error: "Run a report first, then buy its full draft." }); return; }
  try {
    const { nonce, password } = newPassword(key);
    const name = `Draft RSRA: ${label}`;
    const s = await stripe("checkout/sessions", {
      method: "POST",
      form: {
        ui_mode: "embedded_page",
        mode: "payment",
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(PRICE_USD * 100),
        "line_items[0][price_data][product_data][name]": name.slice(0, 250),
        "line_items[0][price_data][product_data][description]": "The full draft Records Search with Risk Assessment for this property: every record by name, distance, status and agency link; the historical record; the EP signature page. Prints to PDF.",
        "payment_method_types[0]": "card",
        "payment_method_types[1]": "link",
        customer_creation: "always",
        "invoice_creation[enabled]": "true",
        "invoice_creation[invoice_data][description]": name.slice(0, 250),
        "invoice_creation[invoice_data][custom_fields][0][name]": "Password",
        "invoice_creation[invoice_data][custom_fields][0][value]": password,
        "invoice_creation[invoice_data][custom_fields][1][name]": "Property",
        "invoice_creation[invoice_data][custom_fields][1][value]": label.slice(0, 30),
        "invoice_creation[invoice_data][footer]": `Your password: ${password}. Open the full draft at ${reportLink({ address, pin }, password)} . Brick & Mortar · aidan@brickandmortar.dev`.slice(0, 5000),
        "invoice_creation[invoice_data][metadata][product]": PRODUCT,
        "metadata[product]": PRODUCT,
        "metadata[pw_nonce]": nonce,
        "metadata[password]": password,
        "metadata[key]": key,
        "metadata[address]": address,
        "metadata[pin]": pin,
        "metadata[label]": label,
        "payment_intent_data[metadata][product]": PRODUCT,
        "payment_intent_data[metadata][pw_nonce]": nonce,
        "payment_intent_data[metadata][key]": key,
        "payment_intent_data[description]": name.slice(0, 250),
        return_url: `${reportLink({ address, pin })}&paid={CHECKOUT_SESSION_ID}`,
      },
    });
    res.status(200).json({ clientSecret: s.client_secret });
  } catch (e) {
    console.error("[checkout]", e.message);
    res.status(502).json({ error: "Checkout could not start. Please try again in a minute." });
  }
}
