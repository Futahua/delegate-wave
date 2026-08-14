import { tally, sum } from "./lib.js";

export function summarize(items) {
  const counts = tally(items);
  return {
    distinct: Object.keys(counts).length,
    total: sum(Object.values(counts)),
  };
}

export function busiest(items) {
  const counts = tally(items);
  let best = null;
  for (const [name, count] of Object.entries(counts)) {
    if (!best || count > best[1]) best = [name, count];
  }
  return best;
}
