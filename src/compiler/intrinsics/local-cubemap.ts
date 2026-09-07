import type ts from "typescript";
import type {CompileAsset, ResolvedCompileOptions, ScenePbrMaterialManifest, Value} from "../types.js";
import type {IntrinsicCallContext} from "./context.js";
import {packLocalCubemapSync, pinnedLocalCubemapLimits, type LocalCubemapJson, type LocalCubemapPlan} from "../../pinned-local-cubemap.js";

export interface LocalCubemapIntrinsicContext extends IntrinsicCallContext {
    readonly options: ResolvedCompileOptions;
    readonly localCubemapState: {maxCandidates?: number};
    readonly scenePbrMaterials: ScenePbrMaterialManifest[];
    registerAsset(source: string, kind: CompileAsset["kind"], faceSize?: number): CompileAsset;
    expectSameEngine(left: Value, right: Value, node: ts.Node): void;
    engineHasStarted(): boolean;
    hasRegisteredScene(): boolean;
    emit(line: string): void;
    cppString(value: string): string;
    compileCondition(expression: ts.Expression): string;
    fail(node: ts.Node, message: string): never;
}

function optionsJson(context: LocalCubemapIntrinsicContext, value: Value, node: ts.Node, environments: Value[]): LocalCubemapJson {
    if (value.kind === "environment-textures" && value.environmentAsset) {
        const index = environments.findIndex(environment => environment.cpp === value.cpp);
        if (index >= 0) return index;
        environments.push(value);
        return environments.length - 1;
    }
    if (value.kind === "number" && value.staticNumber !== undefined && Number.isFinite(value.staticNumber)) return value.staticNumber;
    if (value.kind === "string" && value.staticString !== undefined) return value.staticString;
    if (value.kind === "boolean" && value.staticBoolean !== undefined) return value.staticBoolean;
    if (value.kind === "browser" && value.browserValue?.kind === "boolean") return value.browserValue.value;
    if (value.kind === "tuple" && value.tupleElements) return value.tupleElements.map(element => optionsJson(context, element, node, environments));
    if (value.recordProperties) return Object.fromEntries(Object.entries(value.recordProperties)
        .map(([key, member]) => [key, optionsJson(context, member, node, environments)]));
    return context.fail(node, `Local cubemap geometry and options must be static; environments must be retained loadEnvironment results (${value.kind}: ${value.cpp}).`);
}

function packetExpression(context: LocalCubemapIntrinsicContext, state: NonNullable<Value["localCubemap"]>, node: ts.Node): string {
    let payload: string;
    try { payload = packLocalCubemapSync(state.plan); }
    catch (error) { return context.fail(node, String(error)); }
    const asset = context.registerAsset(`data:application/json;base64,${Buffer.from(payload).toString("base64")}`, "binary");
    return `bbl::load_local_cubemap(bbl::asset_path(${context.cppString(asset.output)}), {${state.environments.map(environment => environment.cpp).join(", ")}})`;
}

export function compileLocalCubemapIntrinsic(context: LocalCubemapIntrinsicContext, name: string, call: ts.CallExpression): Value | undefined {
    const names = ["enablePbrLocalCubemap", "createPbrLocalEnvironmentProbeSet", "setPbrEnvironment",
        "setPbrLocalEnvironment", "setPbrLocalEnvironmentProbeSet", "setPbrLocalEnvironmentProbeDebug", "clearPbrLocalEnvironment"];
    if (!names.includes(name)) return undefined;
    if (context.hasRegisteredScene() || context.engineHasStarted() || context.isRuntimeResourceConstruction())
        context.fail(call, "Local cubemap configuration currently requires static calls before scene registration; live rebuilds are not represented.");
    if (name === "enablePbrLocalCubemap") {
        context.expectArgumentCount(call, 0, 1);
        const value = call.arguments[0] ? optionsJson(context, context.compileValue(call.arguments[0]), call.arguments[0], []) : {};
        if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "maxCandidates"))
            context.fail(call, "enablePbrLocalCubemap accepts only static maxCandidates.");
        const limits = pinnedLocalCubemapLimits();
        const maxCandidates = value["maxCandidates"] ?? limits.defaultCandidates;
        if (typeof maxCandidates !== "number" || !Number.isInteger(maxCandidates) || maxCandidates < 1 || maxCandidates > limits.candidateCapacity)
            context.fail(call, `Local cubemap maxCandidates must be an integer from 1 to ${limits.candidateCapacity}.`);
        if (context.localCubemapState.maxCandidates !== undefined && context.localCubemapState.maxCandidates !== maxCandidates)
            context.fail(call, "Local cubemap maxCandidates cannot change after initialization.");
        context.localCubemapState.maxCandidates = maxCandidates;
        context.reachFeature("material:local-cubemap", call);
        return {kind: "void", cpp: ""};
    }
    const maxCandidates = context.localCubemapState.maxCandidates;
    if (maxCandidates === undefined) context.fail(call, "Call enablePbrLocalCubemap before configuring local environments.");
    const argumentCount = name === "setPbrLocalEnvironment" ? 3 : name === "clearPbrLocalEnvironment" ? 1 : 2;
    context.expectArgumentCount(call, argumentCount, argumentCount);
    const first = context.compileValue(call.arguments[0]!);
    if (name === "setPbrLocalEnvironmentProbeDebug") {
        context.expectKind(first, "pbr-local-probe-set", call.arguments[0]!);
        const enabled = context.compileCondition(call.arguments[1]!);
        if ((enabled !== "true" && enabled !== "false") || !first.localCubemap) context.fail(call, "Local probe debug must be a static boolean on a retained probe set.");
        if ((first.localCubemap.plan.debug ?? false) === (enabled === "true")) return {kind: "void", cpp: ""};
        first.localCubemap.plan.debug = enabled === "true";
        return {kind: "void", cpp: `*${first.cpp} = *${packetExpression(context, first.localCubemap, call)}`};
    }
    if (name === "createPbrLocalEnvironmentProbeSet") context.expectKind(first, "scene", call.arguments[0]!);
    else {
        context.expectKind(first, "material", call.arguments[0]!);
        if (first.scenePbrMaterialIndex === undefined) context.fail(call, "Local environments currently require a statically known scene PBR material.");
        const material = context.scenePbrMaterials[first.scenePbrMaterialIndex]!;
        if (name === "clearPbrLocalEnvironment") {
            delete material.localCubemapCandidates;
            return {kind: "void", cpp: `${first.engineCpp}.materials.at(${first.cpp}.value).local_environment.reset()`};
        }
        material.localCubemapCandidates = maxCandidates;
        if (name === "setPbrLocalEnvironmentProbeSet") {
            const set = context.compileValue(call.arguments[1]!);
            context.expectKind(set, "pbr-local-probe-set", call.arguments[1]!);
            context.expectSameEngine(first, set, call);
            return {kind: "void", cpp: `${first.engineCpp}.materials.at(${first.cpp}.value).local_environment = ${set.cpp}`};
        }
    }
    const environments: Value[] = [];
    let options: LocalCubemapPlan["options"] = {};
    const optionArgument = name === "createPbrLocalEnvironmentProbeSet" ? call.arguments[1] : name === "setPbrLocalEnvironment" ? call.arguments[2] : undefined;
    if (name !== "createPbrLocalEnvironmentProbeSet") {
        const environment = context.compileValue(call.arguments[1]!);
        context.expectKind(environment, "environment-textures", call.arguments[1]!);
        if (!environment.environmentAsset) context.fail(call, "Local environments require retained loadEnvironment results.");
        environments.push(environment);
    }
    if (optionArgument) {
        const value = optionsJson(context, context.compileValue(optionArgument), optionArgument, environments);
        if (!value || typeof value !== "object" || Array.isArray(value)) context.fail(optionArgument, "Local environment options require a static object.");
        options = value;
        const allowed = name === "createPbrLocalEnvironmentProbeSet" ? ["probes", "voxelGrid", "parallaxCorrection"]
            : ["shape", "projectionPosition", "projectionSize", "projectionRadius", "capturePosition"];
        for (const key of Object.keys(options)) if (!allowed.includes(key)) context.fail(optionArgument, `Unsupported local environment option '${key}'.`);
    }
    for (const environment of environments) context.expectSameEngine(first, environment, call);
    const plan: LocalCubemapPlan = {kind: name === "createPbrLocalEnvironmentProbeSet" ? "probes" : name === "setPbrLocalEnvironment" ? "single" : "environment",
        maxCandidates, entryFileName: context.options.fileName,
        environments: environments.map(environment => environment.environmentAsset!.source), options};
    const state = {plan, environments};
    const cpp = packetExpression(context, state, call);
    return name === "createPbrLocalEnvironmentProbeSet" ? {kind: "pbr-local-probe-set", cpp, engineCpp: first.engineCpp!, localCubemap: state}
        : {kind: "void", cpp: `${first.engineCpp}.materials.at(${first.cpp}.value).local_environment = ${cpp}`};
}
