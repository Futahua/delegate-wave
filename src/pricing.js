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
// A basis may omit cache_write_per_mtok when its provider publishes no separate write tariff.
// Pricing then refuses to produce a number for any observation carrying cache-write tokens, rather
// than inventing a rate.
export const PRICING_BASES = Object.freeze({
  // Superseded: recorded from an incorrect reading of DeepSeek's published rates. Retained because
  // bases are append-only and a historical receipt may still name it. Do not use for new receipts.
  "deepseek-direct-2026-08-14-v1": Object.freeze({
    id: "deepseek-direct-2026-08-14-v1",
    description: "SUPERSEDED by -v2: rates did not match DeepSeek's published pricing.",
    recorded_at: "2026-08-14",
    superseded_by: "deepseek-direct-2026-08-14-v2",
    models: Object.freeze({
      "deepseek-v4-flash": Object.freeze({
        input_per_mtok: 0.28, cache_read_per_mtok: 0.028, cache_write_per_mtok: 0.28, output_per_mtok: 0.42,
      }),
      "deepseek-v4-pro": Object.freeze({
        input_per_mtok: 0.55, cache_read_per_mtok: 0.055, cache_write_per_mtok: 0.55, output_per_mtok: 2.19,
      }),
    }),
  }),

  // DeepSeek's published rates. `input_per_mtok` is the cache-miss input price: OpenCode reports
  // `tokens.input` already excluding cache-read and cache-write tokens, so cache reads are priced
  // separately at the cache-hit rate. DeepSeek publishes no separate cache-write tariff, so
  // cache_write_per_mtok is deliberately absent.
  "deepseek-direct-2026-08-14-v2": Object.freeze({
    id: "deepseek-direct-2026-08-14-v2",
    description: "DeepSeek direct API published pricing: cache-miss input, cache-hit input, output.",
    recorded_at: "2026-08-14",
    models: Object.freeze({
      "deepseek-v4-flash": Object.freeze({
        input_per_mtok: 0.14,
        cache_read_per_mtok: 0.0028,
        output_per_mtok: 0.28,
      }),
      "deepseek-v4-pro": Object.freeze({
        input_per_mtok: 0.435,
        cache_read_per_mtok: 0.003625,
        output_per_mtok: 0.87,
      }),
    }),
  }),
});

export const DEFAULT_PRICING_BASIS = "deepseek-direct-2026-08-14-v2";

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
  // Refuse rather than guess when the observation uses a dimension the basis does not price.
  if ((usage.cache_write_tokens ?? 0) > 0 && rates.cache_write_per_mtok === undefined) {
    return { reference_cost_usd: null, pricing_basis_id: null };
  }

  const perToken = (value, rate) => ((value ?? 0) * (rate ?? 0)) / 1_000_000;
  // Reasoning tokens are billed at the output rate, and OpenCode reports `tokens.output` already
  // excluding them, so they are added rather than assumed included.
  const cost = perToken(usage.input_tokens, rates.input_per_mtok)
    + perToken(usage.cache_read_tokens, rates.cache_read_per_mtok)
    + perToken(usage.cache_write_tokens, rates.cache_write_per_mtok)
    + perToken((usage.output_tokens ?? 0) + (usage.reasoning_tokens ?? 0), rates.output_per_mtok);
  return { reference_cost_usd: cost, pricing_basis_id: basisId };
}
