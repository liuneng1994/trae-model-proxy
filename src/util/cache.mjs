export function withCacheControl(value, source) {
  const control = source?.cache_control;
  if (!control) return value;
  return { ...value, cache_control: { ...control } };
}

export function stableStringify(value) {
  return JSON.stringify(value, (key, item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]]));
  });
}
