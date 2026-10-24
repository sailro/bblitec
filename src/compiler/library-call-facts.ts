/** What a default-library static or global does with what it is handed. */
export interface LibraryCallFacts {
    /**
     * Every argument only read, or the first written and the rest read;
     * absent when the table does not answer (the readers' default: may write).
     */
    readonly arguments?: "reads" | "writes-first";
    /** Whether the result may be, or hold, an argument. */
    readonly result: "computed" | "holds";
    /** The answer is a conversion of the arguments alone. */
    readonly converts?: true;
}

const reads = (result: LibraryCallFacts["result"]): LibraryCallFacts => ({
    arguments: "reads",
    result,
});
const converts: LibraryCallFacts = {
    arguments: "reads",
    result: "computed",
    converts: true,
};
const writesFirst: LibraryCallFacts = {
    arguments: "writes-first",
    result: "holds",
};

/**
 * The language library's statics and globals, by `libraryCallName`: one
 * table for the argument effects (parameter-effects.ts), what a result holds
 * (kept-values.ts) and which answers only convert their arguments
 * (evaluation-order.ts). A call it does not name may write its arguments and
 * hold them.
 */
export const LIBRARY_CALL_FACTS: ReadonlyMap<string, LibraryCallFacts> =
    new Map<string, LibraryCallFacts>([
        ["Array.from", reads("holds")],
        ["Array.isArray", reads("computed")],
        ["Array.of", reads("holds")],
        ["ArrayBuffer.isView", reads("holds")],
        ["Atomics.add", writesFirst],
        ["Atomics.and", writesFirst],
        ["Atomics.compareExchange", writesFirst],
        ["Atomics.exchange", writesFirst],
        ["Atomics.load", reads("holds")],
        ["Atomics.or", writesFirst],
        ["Atomics.store", writesFirst],
        ["Atomics.sub", writesFirst],
        ["Atomics.xor", writesFirst],
        ["BigInt", reads("holds")],
        ["Boolean", converts],
        ["JSON.parse", { result: "computed" }],
        ["JSON.stringify", reads("computed")],
        ["Number", converts],
        ["Number.isFinite", reads("holds")],
        ["Number.isInteger", reads("holds")],
        ["Number.isNaN", reads("holds")],
        ["Number.isSafeInteger", reads("holds")],
        ["Number.parseFloat", reads("holds")],
        ["Number.parseInt", reads("holds")],
        ["Object.assign", writesFirst],
        ["Object.create", reads("holds")],
        ["Object.defineProperties", writesFirst],
        ["Object.defineProperty", writesFirst],
        ["Object.entries", reads("holds")],
        ["Object.freeze", writesFirst],
        ["Object.fromEntries", reads("holds")],
        ["Object.getOwnPropertyDescriptor", reads("holds")],
        ["Object.getOwnPropertyDescriptors", reads("holds")],
        ["Object.getOwnPropertyNames", reads("computed")],
        ["Object.getOwnPropertySymbols", reads("holds")],
        ["Object.getPrototypeOf", reads("holds")],
        ["Object.hasOwn", reads("computed")],
        ["Object.is", reads("computed")],
        ["Object.isExtensible", reads("holds")],
        ["Object.isFrozen", reads("holds")],
        ["Object.isSealed", reads("holds")],
        ["Object.keys", reads("computed")],
        ["Object.preventExtensions", writesFirst],
        ["Object.seal", writesFirst],
        ["Object.setPrototypeOf", writesFirst],
        ["Object.values", reads("holds")],
        ["Promise.all", reads("holds")],
        ["Promise.allSettled", reads("holds")],
        ["Promise.any", reads("holds")],
        ["Promise.race", reads("holds")],
        ["Promise.resolve", reads("holds")],
        ["Reflect.defineProperty", writesFirst],
        ["Reflect.deleteProperty", writesFirst],
        ["Reflect.get", reads("holds")],
        ["Reflect.getOwnPropertyDescriptor", reads("holds")],
        ["Reflect.getPrototypeOf", reads("holds")],
        ["Reflect.has", reads("holds")],
        ["Reflect.isExtensible", reads("holds")],
        ["Reflect.ownKeys", reads("holds")],
        ["Reflect.set", writesFirst],
        ["Reflect.setPrototypeOf", writesFirst],
        ["String", converts],
        ["isFinite", converts],
        ["isNaN", converts],
        ["parseFloat", converts],
        ["parseInt", converts],
        ["reject", reads("holds")],
        ["resolve", reads("holds")],
        ["structuredClone", reads("computed")],
    ]);
