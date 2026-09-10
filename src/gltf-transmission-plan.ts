import {asObject, gltfVariantNames, GLTF_TRANSMISSION_PLAN, type JsonObject} from "./gltf-document.js";

export interface GltfTransmissionPlan {
    registered: boolean;
    initial: boolean;
    variants: Record<string, boolean>;
}

/** Missing means this asset has not reached material construction yet. */
export function packagedGltfTransmissionPlan(document: JsonObject): GltfTransmissionPlan | undefined {
    if (!(GLTF_TRANSMISSION_PLAN in document)) return undefined;
    const plan = asObject(document[GLTF_TRANSMISSION_PLAN]), variants = asObject(plan?.variants);
    const names = new Set(gltfVariantNames(document));
    if (!plan || typeof plan.registered !== "boolean" || typeof plan.initial !== "boolean" || !variants ||
        Object.keys(variants).length !== names.size || Object.keys(variants).some(name => !names.has(name)) ||
        Object.values(variants).some(value => typeof value !== "boolean") ||
        (!plan.registered && (plan.initial || Object.values(variants).some(Boolean))))
        throw new Error("Invalid packaged glTF transmission selection.");
    return {registered: plan.registered, initial: plan.initial, variants: variants as Record<string, boolean>};
}

export function selectedGltfTransmission(plan: GltfTransmissionPlan, selectedVariant?: string): boolean {
    if (selectedVariant === undefined) return plan.initial;
    const result = plan.variants[selectedVariant];
    if (typeof result !== "boolean") throw new Error(`Missing glTF transmission selection for variant '${selectedVariant}'.`);
    return result;
}
