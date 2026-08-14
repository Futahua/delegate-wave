// Immutable pricing snapshots for deriving a reference cost from observed token counts.
//
// A reference cost is NOT the provider's bill. It exists so two executors on different commercial
// arrangements can be compared on the same basis: a subscription route reporting its own figure and
// a direct-API route reporting another are not comparable as marginal dollars.
//
// Every receipt records which basis produced its reference cost, so historical receipts stay
// reproducible after prices change. Bases are append-only: correct a wrong rate by adding a new
// basis id, never by editing an existing one.
//
// Rates are USD per million tokens.
export const PRICING_BASES = Object.freeze({
  "deepseek-direct-2026-08-14-v1": Object.freeze({
    id: "deepseek-direct-2026-08-14-v1",
    description: "DeepSeek direct API list pricing recorded 2026-08-14 for the executor A/B.",
    recorded_at: "2026-08-14",
    models: Object.freeze({
      "deepseek-v4-flash": Object.freeze({
        input_per_mtok: 0.28,
        cache_read_per_mtok: 0.028,
        cache_write_per_mtok: 0.28,
        output_per_mtok: 0.42,
      }),
      "deepseek-v4-pro": Object.freeze({
        input_per_mtok: 0.55,
        cache_read_per_mtok: 0.055,
        cache_write_per_mtok: 0.55,
        output_per_mtok: 2.19,
      }),
    }),
  }),
});

export const DEFAULT_PRICING_BASIS = "deepseek-direct-2026-08-14-v1";

// Strips any provider/route prefix: routing identity belongs to the dispatcher, but pricing is a
// property of the underlying model. `opencode-go/deepseek-v4-flash` and
// `deepseek-official/deepseek-v4-flash` price identically under one basis.
export function pricedModelName(model) {
  if (typeof model !== "string" || !model) return null;
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}

// Returns null rather than guessing when the basis or model is unknown, so an unpriceable receipt
// keeps its provider evidence instead of gaining a fabricated number.
export function referenceCostUsd(usage, { model, basisId = DEFAULT_PRICING_BASIS } = {}) {
  const basis = PRICING_BASES[basisId];
  if (!basis) return { reference_cost_usd: null, pricing_basis_id: null };
  const rates = basis.models[pricedModelName(model)];
  if (!rates) return { reference_cost_usd: null, pricing_basis_id: null };
  if (!usage || usage.input_tokens === null || usage.input_tokens === undefined) {
    return { reference_cost_usd: null, pricing_basis_id: null };
  }
  const perToken = (value, rate) => ((value ?? 0) * rate) / 1_000_000;
  // Reasoning tokens are billed as output by both routes under evaluation.
  const cost = perToken(usage.input_tokens, rates.input_per_mtok)
    + perToken(usage.cache_read_tokens, rates.cache_read_per_mtok)
    + perToken(usage.cache_write_tokens, rates.cache_write_per_mtok)
    + perToken((usage.output_tokens ?? 0) + (usage.reasoning_tokens ?? 0), rates.output_per_mtok);
  return { reference_cost_usd: cost, pricing_basis_id: basisId };
}
