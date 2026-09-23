// Transitional re-export: the record writer and content digests live in
// `src/tooling/records.ts`. Remove this file once the remaining importers
// (cli.ts, build-stamp.ts, compile-shaders.ts, code-quality.ts,
// vcpkg-install.ts, shipping-demos.ts, shipping-mobile.ts and the
// android/ios tool scripts) import that module directly.
export {
    contentDigest,
    contentFingerprint,
    hashEntries,
    isCompiledShaderOutput,
    toolIdentity,
    writeJsonRecord,
} from "./tooling/records.js";
