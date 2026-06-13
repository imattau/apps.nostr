export function toggleChoiceValue(values, value, limit) {
  const next = Array.isArray(values) ? [...values] : [];
  const index = next.indexOf(value);
  if (index >= 0) {
    next.splice(index, 1);
  } else if (next.length < limit) {
    next.push(value);
  }
  return next;
}
