import { APP_STORE_TAG } from "./events.js";

export function normalizeListingChoices(values, { exclude = [] } = {}) {
  const blocked = new Set(exclude.map((value) => String(value || "").trim()).filter(Boolean));
  const next = [];
  for (const value of values || []) {
    const entry = String(value || "").trim();
    if (!entry || blocked.has(entry) || next.includes(entry)) continue;
    next.push(entry);
  }
  return next;
}

export function normalizeListingFormValues(form = {}) {
  return {
    ...form,
    categories: normalizeListingChoices(form.categories, { exclude: [APP_STORE_TAG] }),
    buildTypes: normalizeListingChoices(form.buildTypes),
  };
}
