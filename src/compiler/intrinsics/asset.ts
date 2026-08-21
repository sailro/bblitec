import ts from "typescript";
import type {
    CompileAsset,
    Value,
} from "../types.js";
import type { IntrinsicCallContext } from "./context.js";

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
    extends IntrinsicCallContext {
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
    cppString(value: string): string;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    compileBoolean(expression: ts.Expression): string;
    requireEngine(value: Value, node: ts.Node): string;
    fail(node: ts.Node, message: string): never;
}

export function compileAssetIntrinsic(
    context: AssetIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
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
            // `loadSplat(scene, url)` -- the third parameter is the shader
            // fragment list, which splices plugin WGSL into the pin's own
            // stage and belongs with the scenes that reach it.
            context.expectArgumentCount(call, 2, 2);
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
            const url = context.compileStringLiteral(
                call.arguments[1]!,
            );
            const asset = context.registerAsset(
                url,
                "texture",
            );
            // Pinned defaults from src/texture/texture-2d.ts: linear
            // filters, repeat addressing, mipMaps true, invertY true,
            // srgb false. Mip sampling clamps to the base level when
            // mipMaps is false, matching the pinned nearest mip filter.
            let minFilter = "linear";
            let magFilter = "linear";
            let mipMaps = true;
            let invertY = true;
            let srgb = false;
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
                            "magFilter",
                            "minFilter",
                            "mipMaps",
                            "srgb",
                        ].includes(name ?? "")
                    ) {
                        context.fail(
                            property,
                            "Reached loadTexture2D options support srgb, invertY, mipMaps, minFilter, and magFilter.",
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
                `bbl::TextureAddressMode::repeat, ` +
                `bbl::TextureAddressMode::repeat, ` +
                `${allLinear ? "4.0f" : "1.0f"}, ` +
                `${mipMaps ? "1000.0f" : "0.0f"}}`;
            context.reachFeature("texture:file", call);
            return {
                kind: "texture",
                cpp:
                    `bbl::load_file_texture(${engine.cpp}, ` +
                    `bbl::asset_path(${context.cppString(asset.output)}), ` +
                    `${sampler}, ${invertY ? "true" : "false"}, ` +
                    `${srgb ? "true" : "false"})`,
                textureFile: { srgb },
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
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
            // ground of its own — `skipSkybox`/`skipGround` are the only
            // other options it accepts and no reached scene sets them.
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
