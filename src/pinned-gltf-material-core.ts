import { asObject, type JsonObject } from "./json-fields.js";
import {
    sharedPinnedContext,
    unexportedDeclarationText,
    type LoweringContext,
} from "./lowering/context.js";
import { assertPinnedSync } from "./pinned-shader-composer.js";
import {
    createJavaScriptFunction,
    stripAsyncAndAwait,
    transpileCommonJs,
} from "./typescript-transpile.js";

type MaterialCore = (
    material: JsonObject,
    imageOf: (textureIndex: unknown) => number | undefined,
) => JsonObject;
let cached: MaterialCore | undefined;

/** Execute core material assembly with decoded images represented by identity. */
export function pinnedGltfMaterialCore(
    context?: LoweringContext,
): MaterialCore {
    if (!context && cached) return cached;
    const module = "src/loader-gltf/gltf-material.ts";
    const declaration = (context ?? sharedPinnedContext()).functionDeclaration(
        module,
        "assembleMaterial",
    ).declaration;
    const assemble = createJavaScriptFunction(
        "makeImageFetcher",
        "Promise",
        stripAsyncAndAwait(
            transpileCommonJs(unexportedDeclarationText(declaration), module),
        ) + "\nreturn assembleMaterial;",
    )(
        (
            _json: unknown,
            _binary: unknown,
            _baseUrl: unknown,
            images: unknown,
        ) => images,
        {
            all: (values: readonly unknown[]) =>
                values.map((value) =>
                    assertPinnedSync(value, "assembleMaterial image"),
                ),
        },
    );
    if (typeof assemble !== "function")
        throw new Error("Pinned glTF material assembly is not callable.");
    const result: MaterialCore = (material, imageOf) => {
        const images = new Map<number, JsonObject>();
        const fetchImage = (slot: unknown): JsonObject | null => {
            const info = asObject(slot);
            const index = info ? imageOf(info.index) : undefined;
            if (index === undefined) return null;
            let image = images.get(index);
            if (!image) images.set(index, (image = {}));
            return image;
        };
        const value: unknown = Reflect.apply(assemble, undefined, [
            { materials: [material] },
            undefined,
            0,
            undefined,
            fetchImage,
        ]);
        const core = asObject(assertPinnedSync(value, "assembleMaterial"));
        if (!core)
            throw new Error(
                "Pinned glTF material assembly returned no record.",
            );
        return core;
    };
    if (!context) cached = result;
    return result;
}
