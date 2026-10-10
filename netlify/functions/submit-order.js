// netlify/functions/submit-order.mjs
// Reçoit le formulaire client APRÈS paiement, revérifie Stripe côté serveur,
// empêche les doublons, enregistre la commande dans Firebase (visible dans
// CraftWeb Admin) et envoie un e-mail récapitulatif au propriétaire.
//
// Secrets via variables d'environnement Netlify (jamais dans le HTML) :
//   STRIPE_SECRET_KEY   (obligatoire)  clé secrète Stripe
//   NOTIFY_EMAIL        (obligatoire)  adresse qui reçoit les commandes
//   RESEND_API_KEY      (recommandé)   clé API Resend pour l'envoi d'e-mail
//   FROM_EMAIL          (recommandé)   expéditeur vérifié dans Resend (défaut: onboarding@resend.dev)
//   FIREBASE_DB_URL     (optionnel)    URL Realtime DB (défaut: projet CraftWeb)
//   FIREBASE_DB_SECRET  (optionnel)    jeton pour écrire dans la base (sinon règles publiques)

import { offerFromAmount } from "./_offers.mjs";

const STRIPE_API = "https://api.stripe.com/v1";
const DEFAULT_DB = "https://craftweb-428b0-default-rtdb.firebaseio.com";
const MAX_FILES = 6;
const MAX_FILE_BYTES = 3 * 1024 * 1024;      // 3 Mo par fichier
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;     // 8 Mo au total (stockés)
const MAX_ATTACH_BYTES = 4 * 1024 * 1024;    // au-delà, on n'attache pas à l'e-mail (mais on stocke)

function json(statusCode, data) {
  return { statusCode, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(data) };
}
function esc(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtAmount(amount, currency) {
  if (amount == null) return "—";
  var cur = (currency || "eur").toUpperCase();
  try { return new Intl.NumberFormat("fr-FR", { style: "currency", currency: cur }).format(amount / 100); }
  catch (e) { return (amount / 100).toFixed(2) + " " + cur; }
}
function approxBytesFromDataUrl(dataUrl) {
  var i = String(dataUrl || "").indexOf(",");
  var b64 = i >= 0 ? dataUrl.slice(i + 1) : "";
  return Math.floor(b64.length * 3 / 4);
}

// ── Firebase Realtime DB via REST ──
function dbUrl(path) {
  var base = process.env.FIREBASE_DB_URL || DEFAULT_DB;
  var secret = process.env.FIREBASE_DB_SECRET;
  var u = base.replace(/\/$/, "") + "/" + path + ".json";
  return secret ? (u + "?auth=" + encodeURIComponent(secret)) : u;
}
async function dbGet(path) {
  var r = await fetch(dbUrl(path), { method: "GET" });
  if (!r.ok) throw new Error("db_get_failed_" + r.status);
  return await r.json();
}
async function dbPut(path, value) {
  var r = await fetch(dbUrl(path), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  if (!r.ok) throw new Error("db_put_failed_" + r.status);
  return await r.json();
}

async function sendEmail(subject, html, attachments) {
  var key = process.env.RESEND_API_KEY;
  var to = process.env.NOTIFY_EMAIL;
  var from = process.env.FROM_EMAIL || "CraftWeb <onboarding@resend.dev>";
  if (!key || !to) return { sent: false, reason: "email_not_configured" };
  var payload = { from: from, to: [to], subject: subject, html: html };
  if (attachments && attachments.length) payload.attachments = attachments;
  var r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!r.ok) {
    let d = ""; try { d = JSON.stringify(await r.json()); } catch (_) {}
    return { sent: false, reason: "resend_error_" + r.status, detail: d };
  }
  return { sent: true };
}

export async function handler(event) {
  try {
    if (event.httpMethod !== "POST") return json(405, { ok: false, error: "method_not_allowed" });

    var body;
    try { body = JSON.parse(event.body || "{}"); } catch (_) { return json(400, { ok: false, error: "bad_json" }); }

    var sessionId = (body.sessionId || "").trim();
    var form = body.form || {};
    var files = Array.isArray(body.files) ? body.files : [];
    if (!sessionId) return json(400, { ok: false, error: "missing_session_id" });

    // 1) REVÉRIFIER le paiement Stripe côté serveur (ne jamais faire confiance au client)
    var secret = process.env.STRIPE_SECRET_KEY;
    if (!secret) return json(500, { ok: false, error: "server_not_configured" });
    var sResp = await fetch(STRIPE_API + "/checkout/sessions/" + encodeURIComponent(sessionId), {
      method: "GET", headers: { Authorization: "Bearer " + secret }
    });
    if (!sResp.ok) return json(sResp.status === 404 ? 404 : 502, { ok: false, error: "stripe_error" });
    var session = await sResp.json();
    if (session.payment_status !== "paid") return json(200, { ok: false, paid: false });

    var amountTotal = typeof session.amount_total === "number" ? session.amount_total : null;
    var currency = session.currency || "eur";
    var details = session.customer_details || {};
    var stripeEmail = details.email || session.customer_email || null;
    var stripeName = details.name || null;
    var offer = offerFromAmount(amountTotal);

    // 2) ANTI-DOUBLON : si cette session a déjà créé une commande, on s'arrête là.
    var marker = null;
    try { marker = await dbGet("paidOrders/" + sessionId); } catch (_) { marker = null; }
    if (marker) return json(200, { ok: true, duplicate: true });

    // Poser le marqueur immédiatement (garde anti-doublon)
    try { await dbPut("paidOrders/" + sessionId, { createdAt: new Date().toISOString() }); } catch (_) {}

    // 3) Nettoyer/limiter les fichiers reçus (base64 data URLs)
    var cleanFiles = [];
    var total = 0;
    for (var i = 0; i < files.length && cleanFiles.length < MAX_FILES; i++) {
      var f = files[i] || {};
      if (!f.dataUrl || typeof f.dataUrl !== "string") continue;
      var size = approxBytesFromDataUrl(f.dataUrl);
      if (size > MAX_FILE_BYTES) continue;
      if (total + size > MAX_TOTAL_BYTES) break;
      total += size;
      cleanFiles.push({ name: String(f.name || "fichier"), type: String(f.type || ""), size: size, dataUrl: f.dataUrl });
    }

    // 4) Construire la commande (forme compatible avec l'admin existant + champs enrichis)
    var now = new Date().toISOString();
    var fullName = (form.fullname || stripeName || "").trim();
    var nameParts = fullName.split(/\s+/);
    var order = {
      id: "ord_" + sessionId.slice(-12),
      ref: "CMD-" + sessionId.slice(-6).toUpperCase(),
      status: "Nouvelle",
      createdAt: now,
      updatedAt: now,
      source: "stripe",
      paid: true,
      sessionId: sessionId,
      stripeRef: sessionId,
      serviceId: offer ? offer.id : null,
      serviceName: offer ? offer.name : "Offre",
      price: amountTotal != null ? amountTotal / 100 : 0,
      amountTotal: amountTotal,
      currency: currency,
      userId: null,
      clientName: fullName || "Client",
      firstName: nameParts[0] || "",
      lastName: nameParts.slice(1).join(" ") || "",
      email: (form.email || stripeEmail || "").trim(),
      phone: (form.phone || "").trim(),
      description: (form.projectdesc || "").trim(),
      brief: form,                          // toutes les réponses du formulaire
      hasFiles: cleanFiles.length > 0,
      fileCount: cleanFiles.length,
      fileNames: cleanFiles.map(function (x) { return x.name; })
    };

    // 5) Enregistrer dans appdata/orders (liste affichée par l'admin) — lecture/ajout/écriture
    var current = [];
    try { current = await dbGet("appdata/orders"); } catch (_) { current = []; }
    if (!Array.isArray(current)) current = current ? Object.values(current) : [];
    // Sécurité doublon supplémentaire : ne pas ajouter si déjà présent
    var already = current.some(function (o) { return o && o.sessionId === sessionId; });
    if (!already) {
      current.unshift(order);
      await dbPut("appdata/orders", current);
    }

    // 6) Notifier l'admin (notification dans le panneau) — best effort
    try {
      var notifs = await dbGet("appdata/notifs");
      if (!Array.isArray(notifs)) notifs = notifs ? Object.values(notifs) : [];
      notifs.unshift({ id: "n_" + sessionId.slice(-10), audience: "admin", type: "order", read: false,
        createdAt: now, text: "Nouvelle commande payée — " + order.serviceName + " · " + order.clientName });
      await dbPut("appdata/notifs", notifs);
    } catch (_) {}

    // 7) Stocker les fichiers séparément (hors appdata pour ne pas alourdir l'app)
    if (cleanFiles.length) {
      try { await dbPut("orderFiles/" + sessionId, { createdAt: now, files: cleanFiles }); } catch (_) {}
    }

    // 8) E-mail récapitulatif au propriétaire
    var rows = "";
    function row(k, v) { return '<tr><td style="padding:4px 10px;color:#64748B">' + esc(k) + '</td><td style="padding:4px 10px;font-weight:600;color:#0F172A">' + esc(v) + '</td></tr>'; }
    rows += row("Offre", order.serviceName);
    rows += row("Montant payé", fmtAmount(amountTotal, currency));
    rows += row("Référence Stripe", sessionId);
    rows += row("Date", new Date(now).toLocaleString("fr-FR"));
    rows += row("Client", order.clientName);
    rows += row("E-mail", order.email);
    rows += row("Téléphone", order.phone || "-");
    var briefRows = "";
    Object.keys(form).forEach(function (k) {
      if (k === "fullname" || k === "email" || k === "phone") return;
      var val = form[k];
      if (val == null || String(val).trim() === "") return;
      briefRows += row(k, String(val));
    });
    var filesList = order.fileNames.length ? ("<p style='margin:12px 0 4px;font-weight:700'>Fichiers (" + order.fileNames.length + ") :</p><ul>" + order.fileNames.map(function (n) { return "<li>" + esc(n) + "</li>"; }).join("") + "</ul>") : "<p style='color:#64748B'>Aucun fichier fourni.</p>";
    var html =
      '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#0F172A">' +
        '<h2 style="margin:0 0 12px">Nouvelle commande CraftWeb</h2>' +
        '<table style="border-collapse:collapse;font-size:14px">' + rows + '</table>' +
        '<h3 style="margin:18px 0 6px">Réponses du formulaire</h3>' +
        '<table style="border-collapse:collapse;font-size:14px">' + (briefRows || row("(vide)", "-")) + '</table>' +
        filesList +
      '</div>';

    // Pièces jointes si l'ensemble reste raisonnable
    var attachments = [];
    if (total <= MAX_ATTACH_BYTES) {
      attachments = cleanFiles.map(function (f) {
        var i2 = f.dataUrl.indexOf(",");
        return { filename: f.name, content: i2 >= 0 ? f.dataUrl.slice(i2 + 1) : "" };
      });
    }
    var emailRes = await sendEmail("Nouvelle commande — " + order.serviceName + " · " + order.clientName, html, attachments);

    return json(200, { ok: true, paid: true, ref: order.ref, email: emailRes });
  } catch (err) {
    return json(500, { ok: false, error: "unexpected", message: String(err && err.message ? err.message : err) });
  }
}
