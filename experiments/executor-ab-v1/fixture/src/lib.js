export function lastIndex(items) {
  return items.length;
}

export function tally(items) {
  const counts = {};
  for (const item of items) counts[item] = (counts[item] ?? 0) + 1;
  return counts;
}

export function sum(numbers) {
  return numbers.reduce((total, value) => total + value, 0);
}
