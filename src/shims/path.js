// Browser stand-in for Node's "path", for the logger bundled in
// @meshtastic/core (tslog's Node build). It only normalises a file path for
// display, so identity is enough.
export function normalize(p) {
  return p;
}
export default { normalize };
