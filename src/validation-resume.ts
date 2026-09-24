// Transitional re-export: the record writer lives in `src/tooling/records.ts`.
// Remove this file once its remaining importers (shipping-demos.ts and
// shipping-mobile.ts) import that module directly.
export { writeJsonRecord } from "./tooling/records.js";
