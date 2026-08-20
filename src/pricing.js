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

  // OpenCode Go's published usage-accounting rates, captured 2026-08-20.
  //
  // NOT provider-reported per-request spend. Go meters its subscription in dollar value -- the plan
  // states $12/5h, $30/week, $60/month -- so this basis approximates the resource the subscription
  // itself is denominated in, which makes it a far better comparison basis than an arbitrary one.
  // It is still a reference cost: no card is charged per request, and delegate-wave must not present
  // it as though one were.
  //
  // Deliberately separate from the DeepSeek basis. The same model priced under a route's published
  // rates and under a direct-API tariff are two different claims, and merging them would make an
  // arithmetic answer right while making its provenance false.
  "opencode-go-2026-08-20-v1": Object.freeze({
    id: "opencode-go-2026-08-20-v1",
    description: "OpenCode Go published usage-accounting rates, captured 2026-08-20. "
      + "Not provider-reported per-request spend.",
    recorded_at: "2026-08-20",
    source: "https://opencode.ai/docs/go/",
    models: Object.freeze({
      "gpt-5.6-luna": Object.freeze({
        input_per_mtok: 0.20,
        cache_read_per_mtok: 0.02,
        cache_write_per_mtok: 0.25,
        output_per_mtok: 1.20,
        // OpenCode publishes a second tier above 272K tokens -- $0.40 input, $0.04 cached read,
        // $0.50 cached write, $1.80 output -- but labels the boundary only as "272K tokens" without
        // stating WHICH count it is measured against: uncached input, effective context, or some
        // other total. Two readings can put the same observation on opposite sides of it.
        //
        // So the boundary is recorded as the limit of what this basis can price, not as a second
        // rate table to guess with. An observation that could exceed it prices as NULL, which is the
        // same rule this module already applies to a dimension a basis does not tariff: refuse
        // rather than invent. Establishing the metric is what unlocks the upper tier.
        rates_valid_up_to_tokens: 272_000,
      }),
    }),
  }),
});

export const DEFAULT_PRICING_BASIS = "deepseek-direct-2026-08-14-v2";

// The manager's own turns price under the route that actually serves them.
//
// Named separately from DEFAULT_PRICING_BASIS rather than replacing it: worker attempts keep
// pricing under the direct-API basis their ceiling was calibrated against, and nothing about
// measuring the scarce side is allowed to move the cheap side's numbers underneath it.
export const MANAGER_PRICING_BASIS = "opencode-go-2026-08-20-v1";

// The basis id, split into the two facts a receipt records separately.
//
// A receipt keeps the family ("which price list") apart from the revision ("which reading of it"),
// because those answer different questions later: comparing two runs needs the family to match,
// while auditing a figure needs the exact revision that produced it. The id remains the single
// source -- these are derived from it, never stored independently and allowed to drift.
export function pricingBasisParts(basisId) {
  if (typeof basisId !== "string" || !basisId) return { basis: null, version: null };
  const match = /^(.*)-(v\d+)$/.exec(basisId);
  return match ? { basis: match[1], version: match[2] } : { basis: basisId, version: null };
}

// Whether any known basis can price this model at all.
//
// Asked before a turn is bought rather than after, so "we cannot price the scarce side" is a fact
// the operator can see in advance instead of discovering across a column of NULLs.
export function isPriceable(model, basisId = DEFAULT_PRICING_BASIS) {
  const basis = PRICING_BASES[basisId];
  return Boolean(basis && basis.models[pricedModelName(model)]);
}

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
  // Refuse rather than guess when the observation may fall outside the band these rates cover.
  //
  // Compared against the largest count the receipt can support -- its stated total, or the sum of
  // its parts, whichever is greater. Every candidate reading of a published threshold (uncached
  // input, effective context, some other total) is bounded by that figure, so staying under it means
  // the rates apply on ANY reading. Above it the answer depends on which reading was meant, and a
  // number that depends on an unestablished definition is not evidence.
  if (rates.rates_valid_up_to_tokens !== undefined) {
    const parts = (usage.input_tokens ?? 0) + (usage.cache_read_tokens ?? 0)
      + (usage.cache_write_tokens ?? 0) + (usage.output_tokens ?? 0) + (usage.reasoning_tokens ?? 0);
    if (Math.max(parts, usage.total_tokens ?? 0) > rates.rates_valid_up_to_tokens) {
      return { reference_cost_usd: null, pricing_basis_id: null };
    }
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
