// Firefox exposes the promise-based WebExtension API as `browser`; Chrome as `chrome`.
// Under Manifest V3 both return promises, so the rest of the code is browser-agnostic.
export const api = globalThis.browser ?? globalThis.chrome;
