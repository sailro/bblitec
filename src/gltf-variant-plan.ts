import { asIndex, asObject, asRecords, gltfVariantNames, instantiatedPrimitiveRecords, GLTF_VARIANT_PLAN, type JsonObject } from "./gltf-document.js";
import { LoweringContext } from "./lowering/context.js";
import { gltfVariantMaterialSource } from "./lowering/gltf/material-variants.js";
import { transpileCommonJs } from "./typescript-transpile.js";

export interface GltfVariantPlan {
    baseCount: number;
    /** Source material indices in the variant phase's construction order. */
    materials: number[];
    /** Physical material slots after the source selection function runs. */
    selections: Record<string, number[]>;
}
interface Material { index: number }
interface Mesh { material: Material }
interface VariantData {
    names: string[];
    originals: Array<{mesh: Mesh; material: Material}>;
    variants: Record<string, Array<{mesh: Mesh; material: Material}>>;
}
type Schedule = (json: JsonObject, binChunk: DataView, baseUrl: string, names: string[], meshes: Mesh[],
    assemble: (json: JsonObject, bin: DataView, index: number, base: string, cache: unknown[]) => Material,
    build: (material: Material) => Material) => Promise<VariantData>;
type Select = (container: {materialVariants: VariantData}, name: string) => void;
let pinnedRunners: {schedule: Schedule; select: Select} | undefined;

function variantRunners(context: LoweringContext): {schedule: Schedule; select: Select} {
    const source = gltfVariantMaterialSource(context);
    const schedule = new Function("json", "binChunk", "baseUrl", "variantNames", "meshes", "assembleMaterial", "buildMaterial",
        transpileCommonJs(`return (async () => { ${source.schedule} })();`, "gltf-variant-schedule.ts")) as Schedule;
    const { declaration } = context.functionDeclaration("src/loader-gltf/material-variants.ts", "selectVariant");
    const select = new Function(transpileCommonJs(`${declaration.getText().replace(/^export\s+/, "")}\nreturn selectVariant;`,
        "gltf-variant-select.ts"))() as Select;
    return {schedule, select};
}

/** The current base loader's slot count; variant slots form a separate phase. */
export function gltfBaseMaterialCount(document: JsonObject): number {
    return asRecords(document.materials).length + Number(asRecords(document.meshes).some(mesh =>
        asRecords(mesh.primitives).some(primitive => typeof primitive.material !== "number")));
}

/** Execute the source caches, complete mapping walk and selection over recording handles. */
export async function gltfVariantPlan(document: JsonObject, context?: LoweringContext): Promise<GltfVariantPlan> {
    const names = gltfVariantNames(document);
    const baseCount = gltfBaseMaterialCount(document);
    if (!context && GLTF_VARIANT_PLAN in document) {
        const plan = asObject(document[GLTF_VARIANT_PLAN]);
        const selections = asObject(plan?.selections);
        const indices = (value: unknown, limit: number): value is number[] => Array.isArray(value) &&
            value.every(index => asIndex(index) !== undefined && index < limit);
        if (!plan || plan.baseCount !== baseCount || !indices(plan.materials, asRecords(document.materials).length) || !selections)
            throw new Error("Invalid packaged glTF variant material metadata.");
        const materials = plan.materials;
        const meshCount = instantiatedPrimitiveRecords(document).length;
        if (Object.keys(selections).length !== new Set(names).size || names.some(name => !Object.hasOwn(selections, name)) ||
            Object.values(selections).some(slots => !indices(slots, baseCount + materials.length) || slots.length !== meshCount))
            throw new Error("Invalid packaged glTF variant selection metadata.");
        return {baseCount, materials, selections: selections as Record<string, number[]>};
    }
    const materials: number[] = [];
    const selections: Record<string, number[]> = Object.create(null) as Record<string, number[]>;
    if (!names.length) return {baseCount, materials, selections};
    const {schedule, select} = context ? variantRunners(context) : pinnedRunners ??= variantRunners(new LoweringContext());
    const definitions = asRecords(document.materials);
    const meshes = instantiatedPrimitiveRecords(document).map(primitive => ({material: {index: asIndex(primitive.material) ?? definitions.length}}));
    const bin = new DataView(new ArrayBuffer(0));
    const data = await schedule(document, bin, "", names, meshes, (json, bytes, index, base, cache) => {
        if (json !== document || bytes !== bin || base !== "" || !Array.isArray(cache))
            throw new Error("Variant material scheduling changed its resource ownership.");
        if (asIndex(index) === undefined || !asObject(definitions[index]))
            throw new Error("Variant mapping references an invalid glTF material.");
        return {index};
    }, material => {
        const index = baseCount + materials.length;
        materials.push(material.index);
        return {index};
    });
    const initialMaterials = meshes.map(mesh => mesh.material);
    for (const name of names) {
        // Each entry describes one selection immediately after loading.
        meshes.forEach((mesh, index) => { mesh.material = initialMaterials[index]!; });
        select({materialVariants: data}, name);
        selections[name] = meshes.map(mesh => mesh.material.index);
    }
    return {baseCount, materials, selections};
}

export async function packageVariantPlan(document: JsonObject): Promise<void> {
    if (GLTF_VARIANT_PLAN in document) throw new Error("glTF source already carries compiler variant material metadata.");
    if (gltfVariantNames(document).length) document[GLTF_VARIANT_PLAN] = await gltfVariantPlan(document);
}
