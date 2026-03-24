// Shim for is-promise that works correctly in CJS/ESM bundles
export default function isPromise(obj: any): boolean {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function') && typeof obj.then === 'function';
}
export { isPromise };
