import ts from "typescript";
import { javascriptModuleUrl } from "./data-url.js";
import type { JsonObject } from "./json-fields.js";
import {
    type LoweringContext,
    unexportedDeclarationText,
} from "./lowering/context.js";
import {
    importPinnedModule,
    pinnedModuleUnasyncedUrl,
} from "./pinned-shader-composer.js";
import { moduleSpecifiers } from "./typescript-module-specifiers.js";
import {
    createJavaScriptFunction,
    stripAsyncAndAwait,
    transpileCommonJs,
    transpileForBrowser,
} from "./typescript-transpile.js";

export interface PinnedMaterialFeatureContext {
    _texture(texInfo: unknown, srgb: boolean): JsonObject | undefined;
}

export interface PinnedMaterialFeature {
    id: string;
    applyMaterial(
        mat: JsonObject,
        context: PinnedMaterialFeatureContext,
    ): JsonObject | null;
}

export interface PreparedMaterialFeatures {
    features: readonly PinnedMaterialFeature[];
    wrapTexture(this: void, texture: JsonObject, info: unknown): JsonObject;
    runGltfMaterialFeatures(
        mat: JsonObject,
        features: readonly PinnedMaterialFeature[],
        context: PinnedMaterialFeatureContext,
    ): JsonObject | undefined;
}

export interface PinnedMaterialRegistry {
    prepare(document: JsonObject): PreparedMaterialFeatures;
}

/** Execute source discovery, material prerequisites, wrapping and dispatch in one realm. */
export async function loadPinnedMaterialRegistry(
    context: LoweringContext,
    setterRedirects: ReadonlyMap<string, string>,
): Promise<PinnedMaterialRegistry> {
    const module = "src/loader-gltf/gltf-feature-registry.ts";
    const file = context.sourceFile(module);
    const urls = new Map<string, string>();
    const sourceUrl = (
        path: string,
        redirects: ReadonlyMap<string, string> = setterRedirects,
    ): string =>
        pinnedModuleUnasyncedUrl(
            path.slice(4).replace(/\.ts$/, ".js"),
            [],
            redirects,
            (path === "src/loader-gltf/gltf-ext-orm.ts"
                ? 'class OffscreenCanvas { constructor() { throw new Error("glTF ORM compositing requires decoded browser images; separate occlusion and metallic-roughness images are not supported by material projection."); } }\n'
                : "") +
                transpileForBrowser(context.sourceFile(path).text, path),
        );
    // Both hooks of the pointer feature must share the prepared base-colour module.
    const pointerRedirects = new Map(setterRedirects);
    for (const name of ["animation-pointer-basecolor", "animation-pointer-ext"])
        pointerRedirects.set(
            `./${name}.js`,
            sourceUrl(`src/loader-gltf/${name}.ts`),
        );
    for (const specifier of moduleSpecifiers(file)) {
        if (!ts.isCallExpression(specifier.parent)) continue;
        const path = context.store.resolveImport(module, specifier.text);
        if (!path)
            context.contractError(
                specifier,
                "Expected a pinned glTF feature module.",
            );
        const feature = context.sourceFile(path);
        const exported = feature.statements.find(ts.isExportAssignment);
        if (!exported)
            context.contractError(feature, "Expected a default glTF feature.");
        const value = context.unwrapExpression(
            ts.isIdentifier(exported.expression)
                ? context.variableInitializer(feature, exported.expression.text)
                : exported.expression,
        );
        if (!ts.isObjectLiteralExpression(value))
            context.contractError(value, "Expected a glTF feature record.");
        const material = value.properties.some(
            (property) =>
                property.name &&
                ["applyMaterial", "wrapTexture"].includes(
                    context.propertyName(property.name) ?? "",
                ),
        );
        // Binary, geometry and asset hooks have already run during packaging.
        // Their registry predicates still execute; this projection has no hook to call.
        const id = context.unwrapExpression(
            context.propertyInitializer(value, "id"),
        );
        const idValue = ts.isIdentifier(id) ? context.initializerOf(id) : id;
        urls.set(
            specifier.text,
            material
                ? sourceUrl(path, pointerRedirects)
                : javascriptModuleUrl(
                      `export default {id: ${JSON.stringify(context.stringValue(idValue, idValue.getSourceFile()))}};`,
                  ),
        );
    }
    const registry = (await import(sourceUrl(module, urls))) as {
        loadGltfFeatures(document: JsonObject): unknown;
        runGltfMaterialFeatures: PreparedMaterialFeatures["runGltfMaterialFeatures"];
    };
    const loaderModule = "src/loader-gltf/load-gltf.ts";
    const { declaration } = context.functionDeclaration(
        loaderModule,
        "loadGltf",
    );
    const statements = declaration.body!.statements;
    const variableAt = (name: string): number =>
        statements.findIndex(
            (statement) =>
                ts.isVariableStatement(statement) &&
                statement.declarationList.declarations.some(
                    (entry) =>
                        ts.isIdentifier(entry.name) && entry.name.text === name,
                ),
        );
    const discovery = variableAt("featureRegistry");
    const binary = variableAt("activeBin");
    const materials = variableAt("matExts");
    const wraps = variableAt("wrapTex");
    if (
        discovery < 0 ||
        binary <= discovery ||
        materials !== binary + 2 ||
        wraps !== materials + 2
    )
        context.contractError(
            declaration,
            "Expected the glTF feature preparation phases.",
        );
    const parser = await importPinnedModule<Record<string, unknown>>(
        "loader-gltf/gltf-parser.js",
    );
    const math = await importPinnedModule<Record<string, unknown>>(
        "math/mat4-determinant3.js",
    );
    const hooks = await importPinnedModule<Record<string, unknown>>(
        "loader-gltf/gltf-feature-hooks.js",
    );
    const builder = await importPinnedModule<Record<string, unknown>>(
        "loader-gltf/gltf-pbr-builder.js",
    );
    const loader = context.sourceFile(loaderModule);
    const factory = createJavaScriptFunction(
        "importGltfFeatureRegistry",
        "anyPrimitive",
        "needsOrmComposite",
        "mat4Determinant3",
        "_appendEnabledGltfFeatures",
        "identityTexWrap",
        stripAsyncAndAwait(
            transpileCommonJs(
                [
                    unexportedDeclarationText(
                        context.functionDeclaration(
                            loaderModule,
                            "assetUsesGltfFeatures",
                        ).declaration,
                    ),
                    "return function prepare(json) {",
                    "const binChunk = new DataView(new ArrayBuffer(0));",
                    ...statements
                        .slice(discovery, wraps + 1)
                        .map((statement) => statement.getText(loader)),
                    'if (activeBin !== binChunk) throw new Error("Material preparation changed binary storage.");',
                    "return { features: matExts, wrapTexture: wrapTex, runGltfMaterialFeatures: importGltfFeatureRegistry().runGltfMaterialFeatures };",
                    "};",
                ].join("\n"),
                loaderModule,
            ),
        ),
    )(
        () => registry,
        parser.anyPrimitive,
        parser.needsOrmComposite,
        math.mat4Determinant3,
        hooks._appendEnabledGltfFeatures,
        builder.identityTexWrap,
    );
    if (typeof factory !== "function")
        throw new Error("Pinned material preparation is not callable.");
    return {
        prepare: factory as PinnedMaterialRegistry["prepare"],
    };
}
