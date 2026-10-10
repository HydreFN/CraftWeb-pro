// netlify/functions/verify-payment.mjs
// Vérification RÉELLE du paiement côté serveur via l'API Stripe.
// La clé secrète n'est JAMAIS exposée au frontend : elle est lue depuis
// la variable d'environnement Netlify STRIPE_SECRET_KEY.

import { offerFromAmount } from "./_offers.mjs";

const STRIPE_API = "https://api.stripe.com/v1";

function json(statusCode, data) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    body: JSON.stringify(data)
  };
}

export async function handler(event) {
  try {
    const params = event.queryStringParameters || {};
    const sessionId = (params.session_id || "").trim();
    if (!sessionId) return json(400, { paid: false, error: "missing_session_id" });

    const secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return json(500, { paid: false, error: "server_not_configured" });

    const url = STRIPE_API + "/checkout/sessions/" + encodeURIComponent(sessionId);
    const resp = await fetch(url, { method: "GET", headers: { Authorization: "Bearer " + secret } });

    if (!resp.ok) {
      let code = "";
      try { const e = await resp.json(); code = (e && e.error && e.error.code) || ""; } catch (_) {}
      return json(resp.status === 404 ? 404 : 502, { paid: false, error: "stripe_error", code });
    }

    const session = await resp.json();
    const paid = session.payment_status === "paid";
    const details = session.customer_details || {};
    const customerEmail = details.email || session.customer_email || null;
    const customerName = details.name || null;
    const amountTotal = typeof session.amount_total === "number" ? session.amount_total : null;

    return json(200, {
      paid,
      sessionId: session.id,
      customerEmail,
      customerName,
      amountTotal,
      currency: session.currency || null,
      paymentStatus: session.payment_status || null,
      offer: offerFromAmount(amountTotal) // { id, name } | null
    });
  } catch (err) {
    return json(500, { paid: false, error: "unexpected", message: String(err && err.message ? err.message : err) });
  }
}
