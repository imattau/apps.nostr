export const GRID_SIZE_OPTIONS = ["small", "medium", "large"];
export const SORT_OPTIONS = ["newest", "oldest", "alpha"];

export function compareBrowseApps(a, b, sortOrder = "newest") {
  if (sortOrder === "alpha") {
    return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
  }
  const aValue = Number(a.publishedAt || a.created_at || 0);
  const bValue = Number(b.publishedAt || b.created_at || 0);
  if (sortOrder === "oldest") return aValue - bValue;
  return bValue - aValue;
}

export function normalizeGridSize(value, fallback = "medium") {
  return GRID_SIZE_OPTIONS.includes(value) ? value : fallback;
}

export function normalizeSortOrder(value, fallback = "newest") {
  return SORT_OPTIONS.includes(value) ? value : fallback;
}

