/** Data mutations performed by the source pointer parser before its writers are bound. */
export type GltfAnimationMaterialValue =
    | {kind: "undefined"}
    | {kind: "number"; value: number | "NaN" | "Infinity" | "-Infinity" | "-0"}
    | {kind: "literal"; value: null | boolean | string}
    | {kind: "array"; values: GltfAnimationMaterialValue[]}
    | {kind: "object"; fields: Record<string, GltfAnimationMaterialValue>};
export type GltfAnimationMaterialPatch =
    | {path: string[]; operation: "clone" | "erase"}
    | {path: string[]; operation: "set"; value: GltfAnimationMaterialValue};
export interface GltfAnimationMaterialState {index: number; patches: GltfAnimationMaterialPatch[]}

interface Snapshot {value: unknown; fields?: Map<string, Snapshot>; length?: number}
function snapshot(value: unknown, seen = new Map<object, Snapshot>()): Snapshot {
    if (value === null || typeof value !== "object") return {value};
    const previous = seen.get(value); if (previous) return previous;
    const result: Snapshot = {value, fields: new Map(), ...(Array.isArray(value) ? {length: value.length} : {})}; seen.set(value, result);
    for (const [key, child] of Object.entries(value)) result.fields!.set(key, snapshot(child, seen));
    return result;
}
function unchanged(previous: Snapshot | undefined, value: unknown, seen = new Set<Snapshot>()): boolean {
    if (!previous || !Object.is(previous.value, value)) return false;
    if (!previous.fields || seen.has(previous)) return true;
    if (Array.isArray(value) && previous.length !== value.length) return false;
    seen.add(previous);
    const fields = Object.entries(value as object);
    return fields.length === previous.fields.size && fields.every(([key, child]) => unchanged(previous.fields!.get(key), child, seen));
}
function transport(value: unknown, ancestors = new Set<object>()): GltfAnimationMaterialValue {
    if (value === undefined) return {kind: "undefined"};
    if (value === null || typeof value === "boolean" || typeof value === "string") return {kind: "literal", value};
    if (typeof value === "number") return {kind: "number", value: Object.is(value, -0) ? "-0" :
        Number.isFinite(value) ? value : Number.isNaN(value) ? "NaN" : value > 0 ? "Infinity" : "-Infinity"};
    if (typeof value !== "object" || ancestors.has(value)) throw new Error("Unrepresented source pointer material initialization value.");
    const next = new Set(ancestors); next.add(value);
    return Array.isArray(value) ? {kind: "array", values: Array.from(value, child => transport(child, next))}
        : {kind: "object", fields: Object.fromEntries(Object.entries(value).map(([key, child]) => [key, transport(child, next)]))};
}

/** Keep unchanged texture/GPU handles native; transport only the source parser's mutations. */
export function recordAnimationMaterialState(materials: readonly object[]): () => GltfAnimationMaterialState[] {
    const before = materials.map(material => snapshot(material));
    return () => materials.flatMap((material, index) => {
        const patches: GltfAnimationMaterialPatch[] = [];
        const visit = (previous: Snapshot | undefined, value: unknown, path: string[], ancestors: ReadonlySet<object>): void => {
            if (value === null || typeof value !== "object" || Array.isArray(value)) {
                if (!unchanged(previous, value))
                    patches.push({path, operation: "set", value: transport(value)});
                return;
            }
            if (ancestors.has(value)) throw new Error("Unrepresented cyclic source pointer material mutation.");
            if (!previous?.fields || Array.isArray(previous.value)) {
                patches.push({path, operation: "set", value: transport(value)}); return;
            }
            if (previous.value !== value) patches.push({path, operation: "clone"});
            const next = new Set(ancestors); next.add(value);
            const fields = new Map(Object.entries(value));
            for (const key of previous.fields.keys()) if (!fields.has(key)) patches.push({path: [...path, key], operation: "erase"});
            for (const [key, child] of fields) visit(previous.fields.get(key), child, [...path, key], next);
        };
        visit(before[index], material, [], new Set());
        return patches.length ? [{index, patches}] : [];
    });
}

export function readAnimationMaterialState(value: unknown, count: number): GltfAnimationMaterialState[] {
    const fail = (): never => { throw new Error("Invalid packaged glTF pointer material initialization."); };
    const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown> : fail();
    const data = (value: unknown): GltfAnimationMaterialValue => {
        const item = object(value);
        if (item.kind === "undefined") return {kind: "undefined"};
        if (item.kind === "literal" && (item.value === null || typeof item.value === "string" || typeof item.value === "boolean"))
            return {kind: "literal", value: item.value};
        if (item.kind === "number" && ((typeof item.value === "number" && Number.isFinite(item.value)) ||
            item.value === "NaN" || item.value === "Infinity" || item.value === "-Infinity" || item.value === "-0"))
            return {kind: "number", value: item.value};
        if (item.kind === "array" && Array.isArray(item.values)) return {kind: "array", values: item.values.map(data)};
        if (item.kind === "object") return {kind: "object", fields: Object.fromEntries(Object.entries(object(item.fields)).map(([key, child]) => [key, data(child)]))};
        return fail();
    };
    if (!Array.isArray(value)) return fail();
    const indices = new Set<number>();
    return value.map(entry => {
        const state = object(entry), index = state.index;
        if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= count || indices.has(index) || !Array.isArray(state.patches)) return fail();
        indices.add(index);
        return {index, patches: state.patches.map((value): GltfAnimationMaterialPatch => {
            const patch = object(value);
            if (!Array.isArray(patch.path) || !patch.path.length || !patch.path.every((part): part is string => typeof part === "string")) return fail();
            if (patch.operation === "clone" || patch.operation === "erase") return {path: patch.path, operation: patch.operation};
            if (patch.operation === "set") return {path: patch.path, operation: "set", value: data(patch.value)};
            return fail();
        })};
    });
}
