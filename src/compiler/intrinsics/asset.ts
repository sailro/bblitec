import ts from "typescript";
import type {
    CompileAsset,
    Feature,
    Value,
    ValueKind,
} from "../types.js";

interface CompiledHdrEnvironmentOptions {
    faceSize: number;
    useCubemapSkybox: boolean;
    skipGround: boolean;
    skyboxSize: string;
    skyboxPosition: string;
}

export interface AssetIntrinsicContext {
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
    compileValue(expression: ts.Expression): Value;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
    expectObjectLiteral(
        expression: ts.Expression,
    ): ts.ObjectLiteralExpression;
    compileStringLiteral(
        expression: ts.Expression,
    ): string;
    compileNumber(expression: ts.Expression): string;
    compileEnvironmentOptions(
        expression: ts.Expression,
    ): [string, string, string, string];
    compileHdrEnvironmentOptions(
        expression: ts.Expression,
    ): CompiledHdrEnvironmentOptions;
    registerAsset(
        source: string,
        kind: CompileAsset["kind"],
        faceSize?: number,
    ): CompileAsset;
    resolveBundledAsset(source: string): string;
    reachFeature(feature: Feature): void;
    cppString(value: string): string;
    objectProperty(
        object: ts.ObjectLiteralExpression,
        name: string,
    ): ts.Expression | undefined;
    compileBoolean(expression: ts.Expression): string;
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
            context.reachFeature("loader:gltf");
            context.reachFeature("renderer:pbr");
            return {
                kind: "asset",
                cpp:
                    `bbl::load_gltf(${engine.cpp}, ` +
                    `bbl::asset_path(` +
                    `${context.cppString(asset.output)}))`,
                engineCpp:
                    engine.engineCpp ?? engine.cpp,
            };
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
            context.reachFeature("camera:free");
            context.reachFeature("loader:babylon");
            context.reachFeature("material:standard");
            context.reachFeature("renderer:pbr");
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
            const sampler =
                `bbl::TextureSamplerState{` +
                `bbl::TextureFilter::${minFilter}, ` +
                `bbl::TextureFilter::${magFilter}, ` +
                `bbl::TextureMipmapMode::${mipMaps ? "linear" : "nearest"}, ` +
                `bbl::TextureAddressMode::repeat, ` +
                `bbl::TextureAddressMode::repeat, ` +
                `1.0f, ${mipMaps ? "1000.0f" : "0.0f"}}`;
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
            context.reachFeature("background:image-skybox");
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
            const options: [
                string,
                string,
                string,
                string,
            ] = call.arguments[2]
                ? context.compileEnvironmentOptions(
                      call.arguments[2],
                  )
                : ["", "", "1000.0f", ""];
            const groundAsset = options[0]
                ? context.registerAsset(
                      options[0],
                      "texture",
                  )
                : undefined;
            const skyboxAsset = options[1]
                ? context.registerAsset(
                      options[1],
                      "texture",
                  )
                : undefined;
            const brdfAsset = options[3]
                ? context.registerAsset(
                      context.resolveBundledAsset(options[3]),
                      "texture",
                  )
                : undefined;
            context.reachFeature("environment:ibl");
            context.reachFeature("environment:env");
            if (groundAsset) {
                context.reachFeature("background:ground");
            }
            if (skyboxAsset) {
                context.reachFeature("background:skybox");
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
                    `${options[2]}, ` +
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
            context.reachFeature("environment:ibl");
            context.reachFeature("environment:hdr");
            if (options.useCubemapSkybox) {
                context.reachFeature("background:skybox");
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
