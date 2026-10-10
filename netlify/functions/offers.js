// netlify/functions/_offers.mjs
// Correspondance montant Stripe (en centimes) → offre. Partagé par les fonctions.
// Les 4 prix sont fixes et distincts, donc le montant identifie l'offre de façon fiable.

export const OFFERS = {
  portfolio: { id: "portfolio", name: "Site portfolio",              amount: 69000 },
  vitrine:   { id: "vitrine",   name: "Site vitrine Pro",            amount: 129000 },
  ecommerce: { id: "ecommerce", name: "Boutique e-commerce",         amount: 279000 },
  appweb:    { id: "appweb",    name: "Application web essentielle",  amount: 349000 }
};

export function offerFromAmount(amountTotal) {
  if (amountTotal == null) return null;
  for (const k in OFFERS) {
    if (OFFERS[k].amount === amountTotal) return { id: OFFERS[k].id, name: OFFERS[k].name };
  }
  return null; // montant inconnu → pas d'offre identifiée (le formulaire n'affichera que les questions communes)
}
