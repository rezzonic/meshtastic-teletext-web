// Browser stand-in for Node's "util", for the logger bundled in
// @meshtastic/core: it formats log lines with formatWithOptions and detects
// errors with types.isNativeError.
function show(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack || String(value);
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  } catch {
    return String(value);
  }
}

export function formatWithOptions(_options, ...args) {
  return args.map(show).join(" ");
}

export const types = {
  isNativeError: (e) => e instanceof Error,
};

export default { formatWithOptions, types };
