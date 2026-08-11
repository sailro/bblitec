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
            const brdfAsset = context.registerAsset(
                context.resolveBundledAsset("/brdf-lut.png"),
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
