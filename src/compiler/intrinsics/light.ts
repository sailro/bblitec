import type { LoweringServices } from "../lowering-services.js";
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import type { Value } from "../types.js";
import type { IntrinsicCallContext } from "./context.js";
import { recordAt } from "../record-access.js";
import { doubleLiteral } from "../../cpp-literals.js";
import { sharedPinnedContext } from "../../lowering/context.js";
import {
    areaLightLtcSources,
    rectAreaLightDefaultIntensity,
} from "../../lowering/rect-area-light-lowerer.js";
import { areaLightImageSource } from "../../pinned-rect-area-lights.js";

export interface LightIntrinsicContext
    extends
        IntrinsicCallContext,
        Pick<
            LoweringServices,
            | "compileVec3"
            | "compileNumber"
            | "requireDefaultEngine"
            | "requireEngine"
            | "bindings"
            | "assetRegistry"
            | "cppString"
            | "fail"
        > {}

export function compileLightIntrinsic(
    context: LightIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "setLightIntensity":
        case "setLightDiffuseColor": {
            context.expectArgumentCount(call, 2, 2);
            const light = context.bindings.pinValueToTemporary(
                context.compileValue(argumentAt(call, 0)),
                "light_owner",
                call,
            );
            context.expectKind(light, "light", argumentAt(call, 0));
            const color = importedName === "setLightDiffuseColor";
            const value = color
                ? context.compileVec3(argumentAt(call, 1), "double")
                : context.compileNumber(argumentAt(call, 1), "double");
            context.reachFeature("light:parameters", call);
            const engine = context.requireEngine(light, call);
            const setter = `bbl::${color ? "set_light_diffuse_color" : "set_light_intensity"}`;
            return {
                kind: "void",
                cpp: `${setter}(${recordAt(`${engine}.lights`, light.cpp)},${value})`,
            };
        }
        case "createHemisphericLight": {
            context.expectArgumentCount(call, 0, 2);
            const engine = context.requireDefaultEngine(call);
            const direction = call.arguments[0]
                ? context.compileVec3(call.arguments[0], "float")
                : "bbl::Vec3{0.0f, 1.0f, 0.0f}";
            const intensity = call.arguments[1]
                ? context.compileNumber(call.arguments[1], "double")
                : "1.0f";
            context.reachFeature("light:hemispheric", call);
            return {
                kind: "light",
                cpp:
                    `bbl::create_hemispheric_light(` +
                    `${engine}, ${direction}, ${intensity})`,
                engineCpp: engine,
                lightKind: "hemispheric",
                lightIdentity: {},
            };
        }

        case "createDirectionalLight": {
            context.expectArgumentCount(call, 1, 2);
            const engine = context.requireDefaultEngine(call);
            const direction = context.compileVec3(argumentAt(call, 0), "float");
            const intensity = call.arguments[1]
                ? context.compileNumber(call.arguments[1], "double")
                : "1.0f";
            context.reachFeature("light:directional", call);
            return {
                kind: "light",
                cpp:
                    `bbl::create_directional_light(` +
                    `${engine}, ${direction}, ${intensity})`,
                engineCpp: engine,
                lightKind: "directional",
                lightIdentity: {},
            };
        }

        case "createPointLight": {
            context.expectArgumentCount(call, 1, 2);
            const engine = context.requireDefaultEngine(call);
            const position = context.compileVec3(argumentAt(call, 0), "float");
            const intensity = call.arguments[1]
                ? context.compileNumber(call.arguments[1], "double")
                : "1.0f";
            context.reachFeature("light:point", call);
            return {
                kind: "light",
                cpp:
                    `bbl::create_point_light(` +
                    `${engine}, ${position}, ${intensity})`,
                engineCpp: engine,
                lightKind: "point",
                lightIdentity: {},
            };
        }

        case "createSpotLight": {
            context.expectArgumentCount(call, 4, 5);
            const engine = context.requireDefaultEngine(call);
            const position = context.compileVec3(argumentAt(call, 0), "float");
            const direction = context.compileVec3(argumentAt(call, 1), "float");
            // The pinned factory evaluates Math.cos(angle * 0.5) while angle
            // is still a JavaScript number, then rounds once at its
            // Float32Array UBO store. Preserve that double through the native
            // factory boundary; rounding it here can move the hard cone test
            // by one ULP.
            const angle = context.compileNumber(argumentAt(call, 2), "double");
            const exponent = context.compileNumber(
                argumentAt(call, 3),
                "float",
            );
            const intensity = call.arguments[4]
                ? context.compileNumber(call.arguments[4], "double")
                : "1.0f";
            context.reachFeature("light:spot", call);
            return {
                kind: "light",
                cpp:
                    `bbl::create_spot_light(` +
                    `${engine}, ${position}, ${direction}, ` +
                    `${angle}, ${exponent}, ${intensity})`,
                engineCpp: engine,
                lightKind: "spot",
                lightIdentity: {},
            };
        }

        case "createRectAreaLight": {
            // src/light/rect-area-light.ts createRectAreaLight(position,
            // width, height, intensity = 1): its `validateSize` checks run
            // natively in the lowered factory, in the pin's order.
            context.expectArgumentCount(call, 3, 4);
            const engine = context.requireDefaultEngine(call);
            const position = context.compileVec3(argumentAt(call, 0), "float");
            const width = context.compileNumber(argumentAt(call, 1), "double");
            const height = context.compileNumber(argumentAt(call, 2), "double");
            const intensity = call.arguments[3]
                ? context.compileNumber(call.arguments[3], "double")
                : doubleLiteral(
                      rectAreaLightDefaultIntensity(sharedPinnedContext()),
                  );
            context.reachFeature("light:rect-area", call);
            return {
                kind: "light",
                cpp:
                    `bbl::create_rect_area_light(` +
                    `${engine}, ${position}, ${width}, ${height}, ${intensity})`,
                engineCpp: engine,
                lightKind: "rectArea",
                lightIdentity: {},
            };
        }

        case "enableRectAreaLights": {
            // src/light/enable-rect-area-lights.ts: the scene's opt-in.
            // Generation performs the pin's extension registration and its
            // LTC decode before it composes; what runs natively is the
            // scene's own half -- the disposed-scene refusal, the decoded
            // tables' load, and the flag the variant keys read.
            context.expectArgumentCount(call, 1, 1);
            const scene = context.compileValue(argumentAt(call, 0));
            context.expectKind(scene, "scene", argumentAt(call, 0));
            context.reachFeature("light:rect-area-lighting", call);
            // The pin's decoded LTC tables, packaged by generation as the
            // load-hdr BRDF LUT is.
            const tables = areaLightLtcSources.map(
                (source) =>
                    `bbl::asset_path(${context.cppString(
                        context.assetRegistry.registerAsset(source, "texture")
                            .output,
                    )})`,
            );
            return {
                kind: "void",
                cpp: `bbl::enable_rect_area_lights(${scene.cpp}, ${tables.join(", ")})`,
            };
        }

        case "processAreaLightTexture": {
            // src/light/process-area-light-texture.ts: a closed function of
            // the source's pixels and its load options, so generation runs
            // the pin's own loadTexture2D + processAreaLightTexture over the
            // same bytes and packages every level of the result
            // (`packagedAreaLightImage`). Each call is a new image, as each
            // pinned call allocates a new texture.
            context.expectArgumentCount(call, 2, 2);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const source = context.compileValue(argumentAt(call, 1));
            context.expectKind(source, "texture", argumentAt(call, 1));
            const file = source.textureFile;
            if (
                source.textureStorage !== "file" ||
                file?.source === undefined ||
                file.loaderOptions === undefined
            )
                return context.fail(
                    argumentAt(call, 1),
                    "processAreaLightTexture is reached for a loadTexture2D " +
                        "texture whose source and options generation knows: " +
                        "the processed image is baked from that load.",
                );
            const request = {
                source: file.source,
                loaderOptions: file.loaderOptions,
            };
            const asset = context.assetRegistry.registerAsset(
                areaLightImageSource(request),
                "texture",
            );
            asset.areaLightImage = request;
            context.reachFeature("light:rect-area-emission", call);
            return {
                kind: "area-light-image",
                cpp:
                    `(static_cast<void>(${source.cpp}), ` +
                    `bbl::process_area_light_texture(${engine.engineCpp ?? engine.cpp}, ` +
                    `bbl::asset_path(${context.cppString(asset.output)})))`,
                engineCpp: engine.engineCpp ?? engine.cpp,
            };
        }

        default:
            return undefined;
    }
}
