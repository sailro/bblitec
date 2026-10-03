import { createHash } from "node:crypto";
import ts from "typescript";
import { sceneRelativeSourceLabel } from "../source-location.js";
import { SourceSiteRegistry } from "./source-coverage.js";
import { EmissionMap } from "./emission-transaction.js";
import type { DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import {
    declarationOrigin,
    resolvedSymbol,
    declaredInDomLibrary,
} from "./symbols.js";
import { presenceCpp, type Value } from "./types.js";
import { isNullable } from "./type-facts.js";
import { ApplicationRealmRequired } from "./worker-modules.js";
import { pinDetached } from "./dom-listeners.js";

export interface DeferredCapabilitySite {
    id: string;
    origin: "dom" | "babylon" | "css";
    operation: "call" | "construct" | "read" | "write";
    signature: string;
    signatureHash: string;
    file: string;
    line: number;
    column: number;
    start: number;
    end: number;
    kind: string;
    sourceSha256: string;
    realm: "window" | "worker" | "entry";
    timing: "throw" | "reject";
}

export type DeferredCapabilityEmission = Pick<
    DeferredCapabilitySite,
    "id" | "origin" | "operation" | "signature" | "timing"
>;

interface Descriptor {
    origin: "dom" | "babylon";
    api: string;
    timing: DeferredCapabilitySite["timing"];
}

/** Explicit missing public operations; existing admitted adapters remain authoritative. */
export const deferredCapabilityDescriptors: readonly Descriptor[] = [
    ...[
        "atob",
        "btoa",
        "alert",
        "confirm",
        "prompt",
        "structuredClone",
        "Window.atob",
        "Window.btoa",
        "Window.alert",
        "Window.confirm",
        "Window.prompt",
        "Window.structuredClone",
        "WindowOrWorkerGlobalScope.atob",
        "WindowOrWorkerGlobalScope.btoa",
        "WindowOrWorkerGlobalScope.structuredClone",
        "Element.scrollIntoView",
        "Element.insertAdjacentElement",
        "Element.getAttributeNames",
        "Event.composedPath",
        "Node.insertBefore",
        "ChildNode.replaceWith",
        "AbortController.abort",
        "AbortSignal.throwIfAborted",
        "AbortController.constructor",
        "AbortController.signal",
        "AbortSignal.aborted",
        "HTMLOrSVGElement.tabIndex",
        "EventTarget.addEventListener.signal",
    ].map((api): Descriptor => ({ origin: "dom", api, timing: "throw" })),
    ...[
        "Document.exitFullscreen",
        "Element.requestFullscreen",
        "Blob.text",
        "Blob.arrayBuffer",
        "Blob.bytes",
    ].map((api): Descriptor => ({ origin: "dom", api, timing: "reject" })),
    ...[
        "createAudioEngineAsync.options",
        "createSoundSourceAsync.options",
        "createSoundAsync",
        "createSoundBufferAsync",
        "createStreamingSoundAsync",
        "createAudioBusAsync",
        "createMicrophoneSoundSourceAsync",
    ].map((api): Descriptor => ({ origin: "babylon", api, timing: "reject" })),
    ...[
        "enableSpatial",
        "enableStereo",
        "enableAnalyzer",
        "createUnmuteUI",
        "createAudioVisualizer",
        "createAudioEngineMediaStream",
        "setMasterVolume",
        "getMasterVolume",
        "addTaskAfter",
        "computeDeformedPositionToRef",
        "createNavMeshFromSources",
        "disposeEffectWrapper",
        "disposeMeshGpu",
        "disposeNavigationPlugin",
        "disposeRenderTargetTexture",
        "disposeSound",
        "enableAsyncShaderPipelineCompilation",
        "enableCsmStaticCache",
        "enableMaterialTracking",
        "enableRenderTaskTransmission",
        "enableShaderUniformRangeUpdates",
        "enableThinInstanceDynamicDrawCount",
        "findClosestPointWithinInto",
        "getProjectionMatrix",
        "getShaderUniform",
        "getViewMatrix",
        "isShaderMaterial",
        "isStandardMaterial",
        "navRayBlockedFast",
        "playSound",
        "removeMeshFromTask",
        "setGpuTimingEnabled",
        "setShaderMatrix",
        "setSoundVolume",
        "setSpatialListenerPosition",
        "setSpatialPosition",
        "setThinInstanceDrawCount",
        "setVatInstanceStorage",
        "setVatTime",
        "stopSound",
        "updateMeshColors",
        "updateMeshGeometry",
        "updateMeshGeometryCapacity",
        "updateMeshNormals",
        "updateMeshTangents",
        "updateMeshUv2",
        "updateTexture2DFromPixels",
    ].map((api): Descriptor => ({ origin: "babylon", api, timing: "throw" })),
];

const descriptors = new Map(
    deferredCapabilityDescriptors.map((d) => [`${d.origin}:${d.api}`, d]),
);

function declarationApi(
    declaration: ts.SignatureDeclaration,
): string | undefined {
    const name = declaration.name;
    if (!name || !ts.isIdentifier(name)) return undefined;
    const parent = declaration.parent;
    return ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)
        ? `${parent.name?.text}.${name.text}`
        : name.text;
}

export function deferredCapabilityDescriptor(
    checker: ts.TypeChecker,
    call: ts.CallExpression,
): Descriptor | undefined {
    const declaration = checker.getResolvedSignature(call)?.declaration;
    if (!declaration || ts.isJSDocSignature(declaration)) return undefined;
    const origin = declarationOrigin(declaration);
    return descriptors.get(`${origin}:${declarationApi(declaration)}`);
}

export function deferredPropertyDescriptor(
    checker: ts.TypeChecker,
    node: ts.PropertyAccessExpression,
): Descriptor | undefined {
    const symbol = resolvedSymbol(checker, node);
    if (!declaredInDomLibrary(symbol)) return undefined;
    const declaration = symbol?.declarations?.find(ts.isPropertySignature);
    if (!declaration || !ts.isInterfaceDeclaration(declaration.parent))
        return undefined;
    return descriptors.get(
        `dom:${declaration.parent.name.text}.${symbol!.name}`,
    );
}

type Context = Pick<
    LoweringServices,
    | "checker"
    | "options"
    | "compileValue"
    | "dataTypes"
    | "dataLowerer"
    | "emitDiscardedValue"
    | "emit"
    | "reachJsData"
    | "fail"
    | "cppString"
    | "unwrap"
    | "bindings"
    | "libraryGlobal"
    | "symbols"
    | "probeEmission"
    | "captureEmittedLines"
>;

export class DeferredCapabilities {
    private readonly reached = new EmissionMap<
        string,
        DeferredCapabilitySite
    >();
    /** @unjournaled Immutable parsed source hashes, independent of emission attempts. */
    private readonly sourceSites = new SourceSiteRegistry();
    constructor(private readonly context: Context) {}
    get sites(): readonly DeferredCapabilitySite[] {
        return [...this.reached.values()];
    }

    compileConstructor(node: ts.NewExpression): Value | undefined {
        const context = this.context;
        if (
            !context.options.deferredCapabilities ||
            context.libraryGlobal(node.expression) !== "AbortController"
        )
            return undefined;
        const signature = context.checker.getResolvedSignature(node);
        if (
            !signature?.declaration ||
            declarationOrigin(signature.declaration) !== "dom"
        )
            return undefined;
        this.arguments(node, signature, "AbortController.constructor");
        return this.emitKnown(
            node,
            {
                id: "dom:AbortController.constructor",
                origin: "dom",
                operation: "construct",
                timing: "throw",
                signature: context.checker.signatureToString(
                    signature,
                    node,
                    ts.TypeFormatFlags.NoTruncation,
                ),
            },
            { kind: "deferred-dom-object", name: "AbortController" },
        );
    }

    property(
        node: ts.PropertyAccessExpression,
        owner: Value,
        rhs?: ts.Expression,
    ): Value | undefined {
        const context = this.context;
        if (
            !context.options.deferredCapabilities ||
            !deferredPropertyDescriptor(context.checker, node)
        )
            return undefined;
        const type = owner.dataType;
        const api =
            type?.kind === "deferred-dom-object"
                ? type.name === "AbortController" && node.name.text === "signal"
                    ? "AbortController.signal"
                    : type.name === "AbortSignal" &&
                        node.name.text === "aborted"
                      ? "AbortSignal.aborted"
                      : undefined
                : owner.kind === "ui-element" && node.name.text === "tabIndex"
                  ? "HTMLOrSVGElement.tabIndex"
                  : undefined;
        if (!api || (rhs && api !== "HTMLOrSVGElement.tabIndex"))
            return undefined;
        const result: DataType =
            api === "AbortController.signal"
                ? { kind: "deferred-dom-object", name: "AbortSignal" }
                : {
                      kind:
                          api === "AbortSignal.aborted" ? "boolean" : "number",
                  };
        context.emitDiscardedValue(
            pinDetached(context, owner, "deferred_receiver", node.expression),
        );
        if (rhs)
            context.emit({
                kind: "expression",
                code: `static_cast<void>(${context.dataLowerer.compileForRetainedSink(rhs, result, "a deferred DOM property")});`,
            });
        return this.emitKnown(
            rhs ? node.parent : node,
            {
                id: `dom:${api}`,
                origin: "dom",
                operation: rhs ? "write" : "read",
                timing: "throw",
                signature: `${api}: ${context.checker.typeToString(context.checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation)}`,
            },
            rhs ? undefined : result,
        );
    }

    /** Opaque capabilities retain arguments without projecting object properties. */
    private argumentType(
        argument: ts.Expression,
        value: Value,
        parameterType: ts.Type | undefined,
    ): DataType | undefined {
        const context = this.context;
        const sourceType = context.checker.getTypeAtLocation(argument);
        if (
            !parameterType ||
            context.checker.isTypeAssignableTo(sourceType, parameterType)
        ) {
            const owned =
                value.dataType ??
                context.dataTypes.fromTsType(sourceType, argument);
            if (owned) return owned;
        }
        return (
            parameterType &&
            context.dataTypes.fromTsType(parameterType, argument)
        );
    }

    private arguments(
        node: ts.CallExpression | ts.NewExpression,
        signature: ts.Signature,
        api: string,
    ): void {
        const context = this.context;
        for (const [index, argument] of (node.arguments ?? []).entries()) {
            if (ts.isSpreadElement(argument))
                context.fail(
                    argument,
                    "Deferred capability argument spreads require an explicit expanded signature.",
                );
            const parameter = signature.parameters[index];
            const parameterType =
                parameter &&
                context.checker.getTypeOfSymbolAtLocation(parameter, node);
            const value = context.compileValue(argument);
            const owned = this.argumentType(argument, value, parameterType);
            if (!owned)
                return context.fail(
                    argument,
                    `Deferred capability '${api}' argument has no owned native representation.`,
                );
            context.dataTypes.cppType(owned);
            const cpp = context.dataLowerer.compileKnownValueForSink(
                value,
                owned,
                argument,
            );
            context.emit({
                kind: "expression",
                code: `static_cast<void>(${cpp});`,
            });
        }
    }

    /** A missing options contract leaves the existing absent-options adapter intact. */
    compileOptions(
        call: ts.CallExpression,
        argumentIndex: number,
        supported: () => Value,
    ): Value | undefined {
        const context = this.context;
        const argument = call.arguments[argumentIndex];
        if (!context.options.deferredCapabilities || !argument)
            return undefined;
        const signature = context.checker.getResolvedSignature(call);
        const declaration = signature?.declaration;
        if (!signature || !declaration || ts.isJSDocSignature(declaration))
            return undefined;
        const descriptor = descriptors.get(
            `${declarationOrigin(declaration)}:${declarationApi(declaration)}.options`,
        );
        if (!descriptor) return undefined;
        const value = context.compileValue(argument);
        if (
            value.kind === "json-null" ||
            value.dataType?.kind === "undefined"
        ) {
            context.emitDiscardedValue(value);
            return supported();
        }
        if (descriptor.timing === "reject" && !context.options.workers)
            throw new ApplicationRealmRequired();
        const parameter = signature.parameters[argumentIndex];
        const type = this.argumentType(
            argument,
            value,
            parameter &&
                context.checker.getTypeOfSymbolAtLocation(parameter, call),
        );
        if (!type)
            return context.fail(
                argument,
                `Deferred capability '${descriptor.api}' options have no owned native representation.`,
            );
        context.dataTypes.cppType(type);
        const owned = context.bindings.pinValueToTemporary(
            context.dataLowerer.leafValue(
                context.dataLowerer.compileKnownValueForSink(
                    value,
                    type,
                    argument,
                ),
                type,
            ),
            "deferred_options",
            argument,
        );
        context.emitDiscardedValue(owned);
        const resultType = context.dataTypes.fromTsType(
            context.checker.getReturnTypeOfSignature(signature),
            call,
        );
        if (!resultType)
            return context.fail(
                call,
                `Deferred capability '${descriptor.api}' requires an owned representation of its declared result.`,
            );
        const rejected = this.emitKnown(
            call,
            {
                id: `${descriptor.origin}:${descriptor.api}`,
                origin: descriptor.origin,
                operation: "call",
                timing: descriptor.timing,
                signature: context.checker.signatureToString(
                    signature,
                    call,
                    ts.TypeFormatFlags.NoTruncation,
                ),
            },
            resultType,
        )!;
        if (!isNullable(context.checker.getTypeAtLocation(argument)))
            return rejected;
        const present = presenceCpp(owned);
        if (!present)
            return context.fail(
                argument,
                `Deferred capability '${descriptor.api}' options require represented presence.`,
            );
        let accepted: Value | undefined;
        const lines = context.captureEmittedLines(() => {
            accepted = supported();
        });
        if (!accepted)
            return context.fail(
                call,
                "Absent options require a represented native result.",
            );
        const cppType = context.dataTypes.cppType(resultType);
        const acceptedCpp =
            resultType.kind === "promise" && accepted.kind !== "promise"
                ? `${cppType}::resolved(${accepted.cpp})`
                : accepted.cpp;
        return {
            ...context.dataLowerer.leafValue(
                `([&]() -> ${cppType} { if (${present}) return ${rejected.cpp}; ${lines.join(" ")} return ${acceptedCpp}; })()`,
                resultType,
            ),
            impure: true,
        };
    }

    compile(call: ts.CallExpression): Value | undefined {
        const context = this.context;
        if (!context.options.deferredCapabilities) return undefined;
        const descriptor = deferredCapabilityDescriptor(context.checker, call);
        if (!descriptor) return undefined;
        const target = context.unwrap(call.expression);
        if (
            descriptor.origin === "dom" &&
            descriptor.api.includes(".") &&
            !ts.isPropertyAccessExpression(target)
        )
            return undefined;
        if (
            descriptor.origin === "babylon" &&
            !context.symbols.importedName(call.expression) &&
            !(
                ts.isIdentifier(target) &&
                context.bindings.lookupOptional(target)?.intrinsicName
            )
        )
            return undefined;
        if (
            descriptor.origin === "dom" &&
            !descriptor.api.includes(".") &&
            context.libraryGlobal(target) !== descriptor.api
        )
            return undefined;
        const invoke = (): Value => {
            if (descriptor.timing === "reject" && !context.options.workers)
                throw new ApplicationRealmRequired();
            const signature = context.checker.getResolvedSignature(call)!;
            const parameters = signature.declaration!.parameters.filter(
                ts.isParameter,
            );
            const required = parameters.reduce(
                (count, parameter, index) =>
                    parameter.questionToken ||
                    parameter.initializer ||
                    parameter.dotDotDotToken
                        ? count
                        : index + 1,
                0,
            );
            if (call.arguments.length < required)
                return context.fail(
                    call,
                    `Deferred capability '${descriptor.api}' requires at least ${required} arguments.`,
                );
            const resultType =
                context.checker.getReturnTypeOfSignature(signature);
            const resultMembers = resultType.isUnion()
                ? resultType.types
                : [resultType];
            const voidResult =
                resultMembers.some(
                    (member) => (member.flags & ts.TypeFlags.Void) !== 0,
                ) &&
                resultMembers.every(
                    (member) =>
                        (member.flags &
                            (ts.TypeFlags.Void | ts.TypeFlags.Undefined)) !==
                        0,
                );
            const type = voidResult
                ? undefined
                : context.dataTypes.fromTsType(resultType, call);
            if (!voidResult && !type)
                return context.fail(
                    call,
                    `Deferred capability '${descriptor.api}' requires an owned representation of its declared result.`,
                );
            if (descriptor.timing === "reject") {
                if (type?.kind !== "promise")
                    return context.fail(
                        call,
                        "Deferred rejection requires a declared Promise result.",
                    );
            }
            this.arguments(call, signature, descriptor.api);
            return this.emitKnown(
                call,
                {
                    id: `${descriptor.origin}:${descriptor.api}`,
                    origin: descriptor.origin,
                    operation: "call",
                    timing: descriptor.timing,
                    signature: context.checker.signatureToString(
                        signature,
                        call,
                        ts.TypeFormatFlags.NoTruncation,
                    ),
                },
                type,
            )!;
        };
        if (
            descriptor.origin === "dom" &&
            descriptor.api.includes(".") &&
            ts.isPropertyAccessExpression(target)
        ) {
            return context.probeEmission(() => {
                const owner = context.compileValue(target.expression);
                const run = (value: Value): Value | undefined => {
                    const ownerType = descriptor.api.split(".")[0];
                    const valid =
                        ownerType === "AbortController" ||
                        ownerType === "AbortSignal"
                            ? value.dataType?.kind === "deferred-dom-object" &&
                              value.dataType.name === ownerType
                            : ownerType === "Blob"
                              ? value.kind === "blob" ||
                                value.kind === "file" ||
                                value.dataType?.kind === "blob" ||
                                value.dataType?.kind === "file"
                              : ownerType === "Event"
                                ? value.kind === "platform-mouse-event" ||
                                  value.kind === "platform-keyboard-event" ||
                                  value.dataType?.kind ===
                                      "borrowed-platform-event" ||
                                  (value.dataType?.kind === "handle" &&
                                      ["dom-event", "custom-event"].includes(
                                          value.dataType.handle,
                                      ))
                                : value.kind === "ui-element" ||
                                  value.dataType?.kind === "event-target";
                    if (!valid) return undefined;
                    context.emitDiscardedValue(
                        context.bindings.pinValueToTemporary(
                            value,
                            "deferred_receiver",
                            target.expression,
                        ),
                    );
                    return invoke();
                };
                return target.questionDotToken
                    ? context.dataLowerer.optionalAccess(owner, call, run)
                    : run(
                          context.dataLowerer.narrowOptional(
                              owner,
                              target.expression,
                          ),
                      );
            });
        }
        if (!ts.isIdentifier(target) && descriptor.origin === "dom")
            return context.fail(
                call,
                "Deferred global calls require a declared global receiver.",
            );
        return invoke();
    }

    /** Caller proves the exact missing operation and lowers its operands first. */
    emitKnown(
        node: ts.Node,
        descriptor: DeferredCapabilityEmission,
        type?: DataType,
    ): Value | undefined {
        const context = this.context;
        if (!context.options.deferredCapabilities) return undefined;
        if (descriptor.timing === "reject") {
            if (!context.options.workers) throw new ApplicationRealmRequired();
            if (type?.kind !== "promise")
                return context.fail(
                    node,
                    "Deferred rejection requires a declared Promise result.",
                );
        }
        context.reachJsData();
        const site = this.record(node, descriptor);
        const args = `${context.cppString(site.id)}, ${context.cppString(sceneRelativeSourceLabel(node))}`;
        const cppType = type ? context.dataTypes.cppType(type) : "void";
        const cpp =
            descriptor.timing === "reject"
                ? `${cppType}::rejected(std::make_exception_ptr(bbl::DeferredCapabilityError(${args})))`
                : `bbl::deferred_capability<${cppType}>(${args})`;
        return type
            ? { ...context.dataLowerer.leafValue(cpp, type), impure: true }
            : { kind: "void", cpp };
    }

    private record(
        node: ts.Node,
        descriptor: DeferredCapabilityEmission,
    ): DeferredCapabilitySite {
        const { sha256, ...location } = this.sourceSites.site(node);
        const site: DeferredCapabilitySite = {
            ...descriptor,
            signatureHash: createHash("sha256")
                .update(descriptor.signature)
                .digest("hex"),
            ...location,
            file: location.file.replaceAll("\\", "/"),
            sourceSha256: sha256,
            realm: this.context.options.workers
                ? this.context.options.workers.namespace
                    ? "worker"
                    : "window"
                : "entry",
        };
        this.reached.set(
            `${site.file}:${site.start}:${site.end}:${site.id}`,
            site,
        );
        return site;
    }
}
