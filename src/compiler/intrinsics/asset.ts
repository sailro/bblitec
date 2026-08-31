import ts from "typescript";
import type {
    CompileAsset,
    ResolvedCompileOptions,
    SplatFragmentManifest,
    Value,
} from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { compressedTextureUrl } from "../compressed-texture.js";
import { isSplatFragmentExport } from "../../pinned-splat-fragments.js";
import { addressModeByPin } from "../../pinned-address-modes.js";
import { compileDynamicPackagedAsset } from "../static-fetch.js";
import {
    validateObjectProperties,
    type ObjectValidationContext,
} from "../option-helpers.js";

interface CompiledEnvironmentOptions {
    groundTextureUrl: string;
    skyboxUrl: string;
    skyboxSize: string;
    brdfUrl: string;
    skipSkybox: boolean;
    skipGround: boolean;
}

interface CompiledHdrEnvironmentOptions {
    faceSize: number;
    useCubemapSkybox: boolean;
    skipGround: boolean;
    skyboxSize: string;
    skyboxPosition: string;
}

export interface AssetIntrinsicContext
    extends IntrinsicCallContext,
        ObjectValidationContext {
    readonly options: ResolvedCompileOptions;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
    compileNumber(
        expression: ts.Expression,
        precision?: "float" | "double",
    ): string;
    compileEnvironmentOptions(
        expression: ts.Expression,
    ): CompiledEnvironmentOptions;
    compileHdrEnvironmentOptions(
        expression: ts.Expression,
    ): CompiledHdrEnvironmentOptions;
    compileDdsEnvironmentOptions(
        expression: ts.Expression,
    ): string;
    registerAsset(
        source: string,
        kind: CompileAsset["kind"],
        faceSize?: number,
    ): CompileAsset;
    selectGltfVariant(
        asset: CompileAsset,
        variantName: string,
        node: ts.Node,
    ): void;
    resolveBundledAsset(source: string): string;
    unwrap(expression: ts.Expression): ts.Expression;
    cppString(value: string): string;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    compileBoolean(expression: ts.Expression): string;
    lookupOptional(identifier: ts.Identifier): Value | undefined;
    staticAssetUrlCandidates(): readonly string[];
    reachJsData(): void;
    requireEngine(value: Value, node: ts.Node): string;
    fail(node: ts.Node, message: string): never;
    /** Follows an identifier back to the `const` initializer that bound it. */
    resolveStaticExpression(expression: ts.Expression): ts.Expression;
    expectStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression;
    /** The shader plugins a `loadSplat` call passed, in the order it wrote. */
    recordSplatFragments(
        fragments: readonly SplatFragmentManifest[],
        node: ts.Node,
    ): void;
    assetMeshCollection(
        owner: Value,
        expression: ts.Expression,
    ): Value;
}

/**
 * The `GsShaderFragment` records a `loadSplat` call's third argument names.
 *
 * A plugin is plain data upstream, and the two shapes a scene writes are
 * the two the pin exposes: one of `gs-depth-fragments.ts`'s own exports, or
 * a record the scene declares. The first travels as its export name, so the
 * module that owns it is the one that answers what it contains.
 */
function compileSplatFragments(
    context: AssetIntrinsicContext,
    call: ts.CallExpression,
): SplatFragmentManifest[] {
    const list = context.expectStaticArrayLiteral(call.arguments[2]!);
    return list.elements.map((element) => {
        const unwrapped = context.unwrap(element);
        if (ts.isIdentifier(unwrapped)) {
            const value = context.compileValue(unwrapped);
            if (value.kind === "splat-fragment" && value.splatFragment) {
                return value.splatFragment;
            }
        }
        const object = context.expectObjectLiteral(
            context.resolveStaticExpression(element),
        );
        return sceneSplatFragment(context, object);
    });
}

/** One `{ id, helperFunctions?, fragmentSlots }` a scene declared. */
function sceneSplatFragment(
    context: AssetIntrinsicContext,
    object: ts.ObjectLiteralExpression,
): SplatFragmentManifest {
    validateObjectProperties(
        context,
        object,
        ["id", "helperFunctions", "fragmentSlots"],
        "A reached GsShaderFragment carries id, helperFunctions and " +
            "fragmentSlots only.",
    );
    const idExpression = context.objectProperty(object, "id");
    const slotsExpression = context.objectProperty(object, "fragmentSlots");
    if (!idExpression || !slotsExpression) {
        context.fail(
            object,
            "A GsShaderFragment requires id and fragmentSlots.",
        );
    }
    const helpers = context.objectProperty(object, "helperFunctions");
    const slots = context.expectObjectLiteral(slotsExpression);
    return {
        kind: "scene",
        id: context.compileStringLiteral(idExpression),
        ...(helpers
            ? { helperFunctions: context.compileStringLiteral(helpers) }
            : {}),
        fragmentSlots: slots.properties.map((property) => {
            if (!ts.isPropertyAssignment(property)) {
                context.fail(
                    property,
                    "A GsShaderFragment's slots are plain properties.",
                );
            }
            const slot = context.propertyName(property.name);
            if (!slot) {
                context.fail(
                    property,
                    "A GsShaderFragment's slot names are plain identifiers.",
                );
            }
            return {
                slot,
                code: context.compileStringLiteral(property.initializer),
            };
        }),
    };
}

/**
 * A pinned Gaussian-splat shader plugin a scene imports by name.
 *
 * Upstream models one as a value — `{ id, helperFunctions?, fragmentSlots }`
 * — and `applyGsFragments` splices whichever records the `loadSplat` call
 * carried, so what the identifier holds here is the export's own name.
 * Generation reads that export out of the module that owns it; nothing about
 * the plugin reaches run time, which is why the value has no native
 * expression.
 */
export function compileAssetConstant(
    importedName: string,
): Value | undefined {
    if (!isSplatFragmentExport(importedName)) return undefined;
    return {
        kind: "splat-fragment",
        cpp: "",
        staticString: importedName,
        splatFragment: { kind: "pinned", exportName: importedName },
    };
}

/**
 * The container `loadKtxTexture2D(engine, baseUrl, suffixes)` fetches.
 *
 * The suffix list is the scene's own, and which of them this build can
 * sample is generation's answer — the pin asks the device, and a native
 * build has no network for a second candidate.
 */
function ktxContainerUrl(
    context: AssetIntrinsicContext,
    call: ts.CallExpression,
    baseUrl: string,
): string {
    const suffixes = context.unwrap(call.arguments[2]!);
    if (!ts.isArrayLiteralExpression(suffixes)) {
        context.fail(
            call.arguments[2]!,
            "A reached loadKtxTexture2D takes its suffixes as an array " +
                "literal: generation resolves which one the compiled " +
                "backends can sample.",
        );
    }
    const listed = suffixes.elements.map((element) =>
        context.compileStringLiteral(element),
    );
    const url = compressedTextureUrl(baseUrl, listed);
    if (url === undefined) {
        context.fail(
            call.arguments[2]!,
            `A reached loadKtxTexture2D lists no block-compression suffix ` +
                `(${listed.join(", ")}); the compiled backends report no ` +
                "other compressed-format feature, and packaging the pin's " +
                "uncompressed fallback would render a different texture.",
        );
    }
    return url;
}

export function compileAssetIntrinsic(
    context: AssetIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "getContainerMeshes": {
            context.expectArgumentCount(call, 1, 1);
            const container = context.compileValue(call.arguments[0]!);
            return context.assetMeshCollection(container, call);
        }

        case "loadGltf": {
            context.expectArgumentCount(call, 2, 2);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const source =
                context.compileStringLiteral(
                    call.arguments[1]!,
                );
            const asset = context.registerAsset(
                source,
                "gltf",
            );
            // One record can back several containers, because assets are
            // keyed by source. A fact generation stamps on the record
            // reaches all of them, so the count is what lets such a fact
            // refuse instead of widening silently.
            asset.containerCount = (asset.containerCount ?? 0) + 1;
            context.reachFeature("loader:gltf", call);
            context.reachFeature("renderer:pbr", call);
            return {
                kind: "asset",
                cpp:
                    `bbl::load_gltf(${engine.cpp}, ` +
                    `bbl::asset_path(` +
                    `${context.cppString(asset.output)}))`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
                asset,
            };
        }

        case "loadSplat": {
            // `loadSplat(scene, url, fragments?)`. The third parameter is
            // the pin's own opt-in for splat shader plugins: with none the
            // stock module composes and the mangling table upstream inlines
            // for them tree-shakes away, with some the pin's own splicer
            // builds the module at generation.
            context.expectArgumentCount(call, 2, 3);
            const scene = context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            const source = context.compileStringLiteral(
                call.arguments[1]!,
            );
            const asset = context.registerAsset(source, "splat");
            if (call.arguments.length === 3) {
                context.recordSplatFragments(
                    compileSplatFragments(context, call),
                    call,
                );
            }
            context.reachFeature("loader:splat", call);
            // A splat cloud is a scene renderable -- upstream pushes it onto
            // the SceneContext's own `_renderables` -- so it reaches the
            // scene renderer the way a loaded glTF does. Nothing here needs
            // the PBR material family; that feature is what names the scene
            // render loop in this port.
            context.reachFeature("renderer:pbr", call);
            return {
                kind: "splat-mesh",
                cpp:
                    `bbl::load_splat(${scene.cpp}, ` +
                    `bbl::asset_path(` +
                    `${context.cppString(asset.output)}))`,
                engineCpp: context.requireEngine(scene, call.arguments[0]!),
                asset,
            };
        }

        case "bakeCurrentTransformIntoVertices": {
            // src/mesh/GaussianSplatting/gaussian-splatting-bake.ts. The pin
            // reads the cloud's own world matrix, rewrites every row through
            // it, hands the result to `updateData`, and resets the TRS; each
            // of those is lowered from its own declaration and the emitted
            // entry point is where they meet.
            //
            // Reaching it is what makes the loader retain the row buffer:
            // upstream keeps it on every cloud, and this port keeps it for a
            // scene that reads it back.
            context.expectArgumentCount(call, 1, 1);
            const splat = context.compileValue(call.arguments[0]!);
            context.expectKind(
                splat,
                "splat-mesh",
                call.arguments[0]!,
            );
            context.reachFeature("loader:splat-bake", call);
            return {
                kind: "void",
                cpp:
                    `bbl::bake_current_transform_into_vertices(` +
                    `${context.requireEngine(splat, call)}, ${splat.cpp})`,
            };
        }

        case "selectVariant": {
            // src/loader-gltf/material-variants.ts: `selectVariant` restores
            // every original material and then applies the chosen variant's
            // mapped entries. The reached shape is one static selection made
            // before the container is added to the scene, so generation
            // resolves the material each mapped primitive draws with and the
            // call itself emits nothing — the pin's run-time variant table
            // has no reached mutation to serve.
            context.expectArgumentCount(call, 2, 2);
            const container =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                container,
                "asset",
                call.arguments[0]!,
            );
            if (!container.asset) {
                context.fail(
                    call.arguments[0]!,
                    "selectVariant requires the container a glTF load returned.",
                );
            }
            context.selectGltfVariant(
                container.asset,
                context.compileStringLiteral(call.arguments[1]!),
                call,
            );
            context.reachFeature("loader:gltf-variants", call);
            return { kind: "void", cpp: "" };
        }

        case "enableGltfCameras": {
            // src/loader-gltf/gltf-feature-camera.ts enableGltfCameras:
            // registers the `_camera` feature for subsequent loadGltf
            // calls, gated per asset by `!!json.cameras?.length`. The
            // generated loader carries the lowered applyAsset walk for
            // every glTF load, which is the pin's behaviour for a scene
            // that enables cameras before loading — the corpus shape.
            // The call itself creates nothing, so it emits no statement.
            // Each imported camera is the pin's own parented FreeCamera,
            // so the free-camera record family is part of this feature.
            context.expectArgumentCount(call, 0, 0);
            context.reachFeature("loader:gltf-cameras", call);
            context.reachFeature("camera:free", call);
            return { kind: "void", cpp: "" };
        }

        case "loadBabylon": {
            context.expectArgumentCount(call, 2, 3);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const source =
                context.compileStringLiteral(
                    call.arguments[1]!,
                );
            if (call.arguments[2]) {
                context.expectObjectLiteral(
                    call.arguments[2],
                );
            }
            const asset = context.registerAsset(
                source,
                "babylon",
            );
            context.reachFeature("camera:free", call);
            context.reachFeature("loader:babylon", call);
            context.reachFeature("material:standard", call);
            context.reachFeature("renderer:pbr", call);
            return {
                kind: "asset",
                cpp:
                    `bbl::load_babylon(${engine.cpp}, ` +
                    `bbl::asset_path(` +
                    `${context.cppString(asset.output)}))`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "loadTexture2D": {
            context.expectArgumentCount(call, 2, 3);
            const engine =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                engine,
                "engine",
                call.arguments[0]!,
            );
            const dynamic = compileDynamicPackagedAsset(
                context,
                call.arguments[1]!,
                "texture",
                (source) => /\.(?:png|jpe?g|webp)(?:[?#]|$)/i.test(source),
            );
            const url = dynamic
                ? undefined
                : context.compileStringLiteral(call.arguments[1]!);
            const asset = url === undefined
                ? undefined
                : context.registerAsset(url, "texture");
            const texturePathCpp = dynamic?.dynamicAssetPathCpp ??
                `bbl::asset_path(${context.cppString(asset!.output)})`;
            // Pinned defaults from src/texture/texture-2d.ts: linear
            // filters, repeat addressing, mipMaps true, invertY true,
            // srgb false. Mip sampling clamps to the base level when
            // mipMaps is false, matching the pinned nearest mip filter.
            let minFilter = "linear";
            let magFilter = "linear";
            let mipMaps = true;
            let invertY = true;
            let srgb = false;
            let premultiplyAlpha = false;
            let addressModeU = "bbl::TextureAddressMode::repeat";
            let addressModeV = "bbl::TextureAddressMode::repeat";
            if (call.arguments[2]) {
                const options =
                    context.expectObjectLiteral(
                        call.arguments[2],
                    );
                for (const property of options.properties) {
                    const name =
                        property.name &&
                        (ts.isIdentifier(property.name) ||
                            ts.isStringLiteral(
                                property.name,
                            ))
                            ? property.name.text
                            : undefined;
                    if (
                        ![
                            "invertY",
                            "addressModeU",
                            "addressModeV",
                            "magFilter",
                            "minFilter",
                            "mipMaps",
                            "premultiplyAlpha",
                            "srgb",
                        ].includes(name ?? "")
                    ) {
                        context.fail(
                            property,
                            "Reached loadTexture2D options support srgb, invertY, premultiplyAlpha, mipMaps, minFilter, magFilter, addressModeU, and addressModeV.",
                        );
                    }
                }
                const filterName = (
                    expression: ts.Expression,
                ): string => {
                    const filter =
                        context.compileStringLiteral(
                            expression,
                        );
                    if (
                        filter !== "nearest" &&
                        filter !== "linear"
                    ) {
                        context.fail(
                            expression,
                            "Reached texture filters support nearest and linear.",
                        );
                    }
                    return filter;
                };
                const minExpression =
                    context.objectProperty(
                        options,
                        "minFilter",
                    );
                if (minExpression) {
                    minFilter = filterName(minExpression);
                }
                const magExpression =
                    context.objectProperty(
                        options,
                        "magFilter",
                    );
                if (magExpression) {
                    magFilter = filterName(magExpression);
                }
                const addressMode = (
                    expression: ts.Expression,
                ): string => {
                    const unwrapped = context.unwrap(expression);
                    if (ts.isConditionalExpression(unwrapped)) {
                        return `(${context.compileBoolean(unwrapped.condition)} ? ${addressMode(unwrapped.whenTrue)} : ${addressMode(unwrapped.whenFalse)})`;
                    }
                    const mode = context.compileStringLiteral(expression);
                    const mapped = addressModeByPin[mode];
                    if (!mapped) {
                        context.fail(
                            expression,
                            "Reached texture address modes support clamp-to-edge, mirror-repeat, and repeat.",
                        );
                    }
                    return `bbl::${mapped}`;
                };
                const addressUExpression = context.objectProperty(
                    options,
                    "addressModeU",
                );
                if (addressUExpression) {
                    addressModeU = addressMode(addressUExpression);
                }
                const addressVExpression = context.objectProperty(
                    options,
                    "addressModeV",
                );
                if (addressVExpression) {
                    addressModeV = addressMode(addressVExpression);
                }
                const mipExpression =
                    context.objectProperty(
                        options,
                        "mipMaps",
                    );
                if (mipExpression) {
                    mipMaps =
                        context.compileBoolean(
                            mipExpression,
                        ) === "true";
                }
                const invertExpression =
                    context.objectProperty(
                        options,
                        "invertY",
                    );
                if (invertExpression) {
                    invertY =
                        context.compileBoolean(
                            invertExpression,
                        ) === "true";
                }
                const srgbExpression =
                    context.objectProperty(
                        options,
                        "srgb",
                    );
                if (srgbExpression) {
                    srgb =
                        context.compileBoolean(
                            srgbExpression,
                        ) === "true";
                }
                const premultiplyExpression =
                    context.objectProperty(
                        options,
                        "premultiplyAlpha",
                    );
                if (premultiplyExpression) {
                    premultiplyAlpha =
                        context.compileBoolean(
                            premultiplyExpression,
                        ) === "true";
                }
            }
            // `maxAnisotropy: allLinear ? 4 : 1` — the pin asks for
            // anisotropic filtering only when nothing in the chain is
            // nearest, and the mip filter it folds into that test is
            // `mipMaps ? "linear" : "nearest"`, so turning mips off turns
            // anisotropy off with them. The glTF sampler path already
            // carries the same rule for the same reason.
            const allLinear =
                minFilter === "linear" && magFilter === "linear" && mipMaps;
            const sampler =
                `bbl::TextureSamplerState{` +
                `bbl::TextureFilter::${minFilter}, ` +
                `bbl::TextureFilter::${magFilter}, ` +
                `bbl::TextureMipmapMode::${mipMaps ? "linear" : "nearest"}, ` +
                `${addressModeU}, ` +
                `${addressModeV}, ` +
                `${allLinear ? "4.0f" : "1.0f"}, ` +
                `${mipMaps ? "1000.0f" : "0.0f"}}`;
            context.reachFeature("texture:file", call);
            return {
                kind: "texture",
                textureStorage: "file",
                cpp:
                    `bbl::load_file_texture(${engine.cpp}, ` +
                    `${texturePathCpp}, ` +
                    `${sampler}, ${invertY ? "true" : "false"}, ` +
                    `${srgb ? "true" : "false"}, ` +
                    `${premultiplyAlpha ? "true" : "false"})`,
                textureFile: {
                    srgb,
                    ...(url === undefined
                        ? {}
                        : {
                              source: url.startsWith("data:")
                                  ? url
                                  : asset!.source,
                              entryFileName: context.options.fileName,
                          }),
                },
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
        }

        case "loadKtxTexture2D":
        case "loadBasisTexture2D": {
            // Both loaders end at the same native reader: the container's
            // blocks and its own mip chain. What differs is where the
            // container comes from — a suffix generation resolves against
            // the compiled backends' formats, or a `.basis` file the pin's
            // own loader transcodes at generation — and the texture-OBJECT
            // `invertY`, which `uploadCompressed` leaves unset and
            // `basis-loader.ts` sets. Neither takes the sampler options
            // upstream resolves against defaults no reached call moves, so
            // an options argument refuses rather than shipping an
            // unmeasured sampler.
            const basis = importedName === "loadBasisTexture2D";
            context.expectArgumentCount(call, basis ? 2 : 3, basis ? 2 : 3);
            const engine = context.compileValue(call.arguments[0]!);
            context.expectKind(engine, "engine", call.arguments[0]!);
            const url = context.compileStringLiteral(call.arguments[1]!);
            const asset = basis
                ? context.registerAsset(url, "basis")
                : context.registerAsset(
                      ktxContainerUrl(context, call, url),
                      "texture",
                  );
            context.reachFeature("texture:compressed", call);
            return {
                kind: "texture",
                textureStorage: "file",
                cpp:
                    `bbl::load_compressed_texture(${engine.cpp}, ` +
                    `bbl::asset_path(${context.cppString(asset.output)}), ` +
                    `${basis ? "true" : "false"})`,
                textureFile: { srgb: false },
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        case "loadSkybox": {
            context.expectArgumentCount(call, 3, 4);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            const baseUrl = context.compileStringLiteral(
                call.arguments[1]!,
            );
            const extension =
                context.compileStringLiteral(
                    call.arguments[2]!,
                );
            // Pinned loadCubeTexture face suffix order: layers 0-5.
            const faceAssets = [
                "_px",
                "_nx",
                "_py",
                "_ny",
                "_pz",
                "_nz",
            ].map((suffix) =>
                context.registerAsset(
                    `${baseUrl}${suffix}${extension}`,
                    "texture",
                ),
            );
            const size = call.arguments[3]
                ? context.compileNumber(call.arguments[3])
                : "100.0f";
            context.reachFeature("background:image-skybox", call);
            return {
                kind: "void",
                cpp:
                    `bbl::load_image_skybox(${scene.cpp}, ` +
                    `std::array<std::string, 6>{` +
                    faceAssets
                        .map(
                            (asset) =>
                                `bbl::asset_path(${context.cppString(asset.output)})`,
                        )
                        .join(", ") +
                    `}, ${size})`,
            };
        }

        case "loadEnvironment": {
            context.expectArgumentCount(call, 2, 3);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            const environmentUrl =
                context.compileStringLiteral(
                    call.arguments[1]!,
                );
            const environmentAsset =
                context.registerAsset(
                    environmentUrl,
                    "environment",
                );
            const options: CompiledEnvironmentOptions =
                call.arguments[2]
                    ? context.compileEnvironmentOptions(
                          call.arguments[2],
                      )
                    : {
                        groundTextureUrl: "",
                        skyboxUrl: "",
                        skyboxSize: "0.0f",
                        brdfUrl: "",
                        skipSkybox: false,
                        skipGround: false,
                    };
            const groundAsset = options.groundTextureUrl
                ? context.registerAsset(
                      options.groundTextureUrl,
                      "texture",
                  )
                : undefined;
            // src/loader-env/load-env.ts treats the skybox as .env when its
            // URL matches the lighting URL or carries the .env extension,
            // and reuses the cubemap it just parsed instead of fetching a
            // DDS. That is decided by the two URLs alone, so it is decided
            // here.
            const skyboxUsesEnvironment =
                options.skyboxUrl !== "" &&
                (options.skyboxUrl === environmentUrl ||
                    options.skyboxUrl
                        .toLowerCase()
                        .endsWith(".env"));
            const skyboxAsset =
                options.skyboxUrl && !skyboxUsesEnvironment
                    ? context.registerAsset(
                          options.skyboxUrl,
                          "texture",
                      )
                    : undefined;
            const brdfAsset = options.brdfUrl
                ? context.registerAsset(
                      context.resolveBundledAsset(options.brdfUrl),
                      "texture",
                  )
                : undefined;
            context.reachFeature("environment:ibl", call);
            context.reachFeature("environment:env", call);
            // The deferred builder's ground arm is `!bgOptions.skipGround`
            // alone: `buildGroundRenderable` takes the texture URL as
            // optional and falls back to a 1x1 white texel, so a scene that
            // names no ground texture and skips no ground still gets a
            // ground.
            if (!options.skipGround) {
                context.reachFeature("background:ground", call);
            }
            if (skyboxAsset || skyboxUsesEnvironment) {
                context.reachFeature("background:skybox", call);
            }
            // The deferred builder's own condition: a scene that names no DDS
            // or .env skybox and does not skip one gets the solid-colour cube
            // shaded from the clear colour.
            const solidSkybox =
                !skyboxAsset &&
                !skyboxUsesEnvironment &&
                !options.skipSkybox;
            const hasEnvironmentSkybox = Boolean(
                skyboxAsset || skyboxUsesEnvironment,
            );
            if (
                hasEnvironmentSkybox &&
                scene.sceneEnvironmentState!.rotationSet
            ) {
                context.fail(
                    call,
                    "Loading a visible environment skybox after setEnvironmentRotation requires native skybox rotation support.",
                );
            }
            scene.sceneEnvironmentState!
                .hasTexturedSkybox ||= hasEnvironmentSkybox;
            if (solidSkybox) {
                context.reachFeature("background:solid-skybox", call);
            }
            return {
                kind: "void",
                cpp:
                    `bbl::load_environment(${scene.cpp}, ` +
                    `bbl::EnvironmentOptions{` +
                    `bbl::asset_path(${context.cppString(
                        environmentAsset.output,
                    )}), ` +
                    `${groundAsset ? `bbl::asset_path(${context.cppString(groundAsset.output)})` : context.cppString("")}, ` +
                    `${skyboxAsset ? `bbl::asset_path(${context.cppString(skyboxAsset.output)})` : context.cppString("")}, ` +
                    `${options.skyboxSize}, ` +
                    `${brdfAsset ? `bbl::asset_path(${context.cppString(brdfAsset.output)})` : context.cppString("")}, ` +
                    `${skyboxUsesEnvironment ? "true" : "false"}, ` +
                    `${solidSkybox ? "true" : "false"}, ` +
                    `${options.skipGround ? "false" : "true"}})`,
            };
        }

        case "loadDdsEnvironment": {
            // src/loader-env/load-dds-env.ts: a prefiltered DDS cubemap is
            // the IBL source itself, uploaded mip for mip, with the
            // irradiance harmonics projected out of mip 0. Both halves are
            // settled by the asset, so both are compiled into the package
            // the runtime reads. The pinned loader takes no skybox or
            // ground of its own — `skipSkybox`/`skipGround` are accepted
            // but deliberately ignored by both the pin and this adapter.
            context.expectArgumentCount(call, 2, 3);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            const source =
                context.compileStringLiteral(
                    call.arguments[1]!,
                );
            const brdfUrl = call.arguments[2]
                ? context.compileDdsEnvironmentOptions(
                      call.arguments[2],
                  )
                : "";
            const environmentAsset =
                context.registerAsset(
                    source,
                    "dds-environment",
                );
            const brdfAsset = brdfUrl
                ? context.registerAsset(
                      context.resolveBundledAsset(brdfUrl),
                      "texture",
                  )
                : undefined;
            context.reachFeature("environment:ibl", call);
            context.reachFeature("environment:dds", call);
            return {
                kind: "void",
                cpp:
                    `bbl::load_dds_environment(${scene.cpp}, ` +
                    `bbl::DdsEnvironmentOptions{` +
                    `bbl::asset_path(${context.cppString(
                        environmentAsset.output,
                    )}), ` +
                    `${brdfAsset ? `bbl::asset_path(${context.cppString(brdfAsset.output)})` : context.cppString("")}})`,
            };
        }

        case "loadHdrEnvironment": {
            context.expectArgumentCount(call, 2, 3);
            const scene =
                context.compileValue(call.arguments[0]!);
            context.expectKind(
                scene,
                "scene",
                call.arguments[0]!,
            );
            const source =
                context.compileStringLiteral(
                    call.arguments[1]!,
                );
            const options = call.arguments[2]
                ? context.compileHdrEnvironmentOptions(
                      call.arguments[2],
                  )
                : {
                      faceSize: 256,
                      useCubemapSkybox: false,
                      skipGround: false,
                      skyboxSize: "0.0f",
                      skyboxPosition: "bbl::Vec3{}",
                  };
            if (!options.skipGround) {
                context.fail(
                    call.arguments[2] ?? call,
                    "Reached HDR environment lowering currently requires skipGround: true.",
                );
            }
            if (
                options.useCubemapSkybox &&
                scene.sceneEnvironmentState!.rotationSet
            ) {
                context.fail(
                    call,
                    "Loading a visible HDR environment skybox after setEnvironmentRotation requires native skybox rotation support.",
                );
            }
            scene.sceneEnvironmentState!
                .hasTexturedSkybox ||=
                options.useCubemapSkybox;
            const environmentAsset =
                context.registerAsset(
                    source,
                    "hdr-environment",
                    options.faceSize,
                );
            // Pinned load-hdr generates its 256x256 rgba16f BRDF LUT
            // with a compute pass instead of loading the bundled PNG.
            const brdfAsset = context.registerAsset(
                "generated:pinned-ibl-brdf-lut",
                "texture",
            );
            context.reachFeature("environment:ibl", call);
            context.reachFeature("environment:hdr", call);
            if (options.useCubemapSkybox) {
                context.reachFeature("background:skybox", call);
            }
            return {
                kind: "void",
                cpp:
                    `bbl::load_hdr_environment(${scene.cpp}, ` +
                    `bbl::HdrEnvironmentOptions{` +
                    `bbl::asset_path(${context.cppString(
                        environmentAsset.output,
                    )}), ` +
                    `bbl::asset_path(${context.cppString(
                        brdfAsset.output,
                    )}), ` +
                    `${options.useCubemapSkybox ? "true" : "false"}, ` +
                    `${options.skyboxSize}, ` +
                    `${options.skyboxPosition}})`,
            };
        }

        default:
            return undefined;
    }
}
