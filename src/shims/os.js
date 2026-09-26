// Browser stand-in for Node's "os": the bundled logger calls hostname() only
// if it exists.
export const hostname = undefined;
export default { hostname };
