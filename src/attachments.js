export function mergeSelectedFiles(existingFiles, selectedFiles) {
  const merged = [...(existingFiles || [])];
  for (const file of selectedFiles || []) {
    if (!merged.some((current) => sameFile(current, file))) {
      merged.push(file);
    }
  }
  return merged;
}

function sameFile(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.name === b.name && a.size === b.size && a.type === b.type && a.lastModified === b.lastModified;
}
