import { createHash } from "node:crypto";
import ts from "typescript";
import { sceneRelativeSourceLabel } from "../source-location.js";
import { SourceSiteRegistry } from "./source-coverage.js";
import { EmissionMap } from "./emission-transaction.js";
import type { DataType } from "./data-types.js";
import { DEFERRED_DOM_OBJECTS } from "./data-types/model.js";
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
import { nativeFunctionValue } from "./native-function-values.js";
import { nativeWindowMember } from "./window-properties.js";
import { isDomReceiver } from "./dom-targets.js";

export interface DeferredCapabilitySite {
    id: string;
    origin: "dom" | "babylon" | "default-lib" | "css";
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
    origin: "dom" | "babylon" | "default-lib";
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
        "requestIdleCallback",
        "cancelIdleCallback",
        "Window.requestIdleCallback",
        "Window.cancelIdleCallback",
        "IdleDeadline.didTimeout",
        "IdleDeadline.timeRemaining",
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
        "Element.setPointerCapture",
        "Element.releasePointerCapture",
        "Element.hasPointerCapture",
        "Element.innerHTML.svg-image",
        "Element.innerHTML.form-controls",
        "ChildNode.replaceWith",
        "AbortController.abort",
        "AbortSignal.throwIfAborted",
        "AbortController.constructor",
        "AbortController.signal",
        "AbortSignal.aborted",
        "HTMLOrSVGElement.tabIndex",
        "EventTarget.addEventListener.signal",
        "MediaStream.constructor",
        "MediaStream.getTracks",
        "MediaStream.getAudioTracks",
        "MediaStream.addTrack",
        "MediaStreamTrack.stop",
        "MediaStreamTrack.clone",
        "MediaRecorder.constructor",
        "MediaRecorder.isTypeSupported",
        "MediaRecorder.start",
        "MediaRecorder.stop",
        "MediaRecorder.state",
        "MediaRecorder.addEventListener",
        "BlobEvent.data",
        "Response.headers",
        "Body.body",
        "Blob.stream",
        "ReadableStream.pipeThrough",
        "CompressionStream.constructor",
        "DecompressionStream.constructor",
        "CompressionStream.readable",
        "DecompressionStream.readable",
        "Response.constructor",
        "Headers.get",
        "HTMLCanvasElement.captureStream",
        "AudioContext.createMediaStreamSource",
        "AudioContext.createMediaStreamDestination",
        "AudioContext.createMediaElementSource",
        "MediaStreamAudioDestinationNode.stream",
        "AudioNode.disconnect",
        "Audio.constructor",
        "HTMLMediaElement.pause",
        "HTMLMediaElement.load",
        "HTMLMediaElement.preload",
        "HTMLMediaElement.loop",
        "HTMLMediaElement.duration",
        "HTMLMediaElement.currentTime",
        "HTMLAudioElement.addEventListener",
        "HTMLScriptElement.src",
        "HTMLScriptElement.async",
        "HTMLScriptElement.addEventListener",
        "HTMLScriptElement.removeEventListener",
    ].map((api): Descriptor => ({ origin: "dom", api, timing: "throw" })),
    ...[
        "Document.exitFullscreen",
        "Element.requestFullscreen",
        "Blob.text",
        "Blob.arrayBuffer",
        "Blob.bytes",
        "HTMLMediaElement.play",
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
        "SurfaceContext.maxDevicePixelRatio",
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
    if (
        ts.isTypeLiteralNode(parent) &&
        ts.isVariableDeclaration(parent.parent) &&
        ts.isIdentifier(parent.parent.name)
    )
        return `${parent.parent.name.text}.${name.text}`;
    if (ts.isInterfaceDeclaration(parent) || ts.isClassLike(parent)) {
        const namespace = parent.parent;
        const prefix =
            ts.isModuleBlock(namespace) &&
            ts.isIdentifier(namespace.parent.name) &&
            namespace.parent.name.text === "Intl"
                ? "Intl."
                : "";
        return `${prefix}${parent.name?.text}.${name.text}`;
    }
    return name.text;
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
    const declaration = symbol?.declarations?.find(ts.isPropertySignature);
    if (!declaration || !ts.isInterfaceDeclaration(declaration.parent))
        return undefined;
    return descriptors.get(
        `${declarationOrigin(declaration)}:${declaration.parent.name.text}.${symbol!.name}`,
    );
}

export function deferredWindowFunctionSymbol(
    checker: ts.TypeChecker,
    node: ts.Expression,
): ts.Symbol | undefined {
    const symbol = ts.isPropertyAccessExpression(node)
        ? nativeWindowMember(checker, node)
        : resolvedSymbol(checker, node);
    if (!(
        symbol &&
        ["requestIdleCallback", "cancelIdleCallback"].includes(symbol.name) &&
        declaredInDomLibrary(symbol)
    ))
        return undefined;
    const window = checker.resolveName(
        "Window",
        undefined,
        ts.SymbolFlags.Type,
        false,
    );
    return window
        ? checker.getPropertyOfType(
              checker.getDeclaredTypeOfSymbol(window),
              symbol.name,
          )
        : undefined;
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
    | "callbackIdentity"
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

    /** Known Window functions retain their typed callable surface through aliases. */
    functionValue(node: ts.Expression): Value | undefined {
        const context = this.context;
        if (!context.options.deferredCapabilities) return undefined;
        const property = ts.isPropertyAccessExpression(node) ? node : undefined;
        const name = property?.name.text ?? context.libraryGlobal(node);
        if (name !== "requestIdleCallback" && name !== "cancelIdleCallback")
            return undefined;
        const symbol = deferredWindowFunctionSymbol(context.checker, node);
        if (!symbol) return undefined;
        if (property) {
            const owner = context.probeEmission(() => {
                const value = context.compileValue(property.expression);
                return value.domEventTargetCpp ===
                    "bbl::DomEventTarget::window()" ||
                    value.dataType?.kind === "event-target"
                    ? value
                    : undefined;
            });
            if (!owner) return undefined;
            if (!this.windowReceiver(owner, property.expression))
                return context.fail(
                    property.expression,
                    `Deferred Window member '${name}' requires a proven Window receiver.`,
                );
            context.emitDiscardedValue(
                pinDetached(context, owner, "idle_owner", property.expression),
            );
        }
        let sourceType = context.checker.getNonNullableType(
            context.checker.getTypeAtLocation(node),
        );
        const signatures = sourceType.getCallSignatures();
        const declaration = symbol.valueDeclaration ?? symbol.declarations?.[0];
        if (
            sourceType.isIntersection() &&
            signatures.length > 0 &&
            declaration &&
            signatures.every(
                (signature) =>
                    context.checker.signatureToString(signature) ===
                    context.checker.signatureToString(signatures[0]!),
            )
        )
            sourceType = context.checker.getTypeAtLocation(declaration);
        const type = context.dataTypes.fromStoredTsType(sourceType, node);
        if (type?.kind !== "function")
            return context.fail(
                node,
                "Idle callback functions require an owned callable signature.",
            );
        const deferred = this.emitKnown(
            node,
            {
                id: `dom:Window.${name}`,
                origin: "dom",
                operation: "call",
                timing: "throw",
                signature: context.checker.typeToString(
                    context.checker.getTypeAtLocation(node),
                    node,
                    ts.TypeFormatFlags.NoTruncation,
                ),
            },
            type.result,
        )!;
        const discarded = type.parameters
            .map((_, index) => `static_cast<void>(argument_${index});`)
            .join(" ");
        return nativeFunctionValue(
            context,
            node,
            { ...type, identity: true },
            `${discarded} return ${deferred.cpp};`,
            declaration,
        );
    }

    compileConstructor(node: ts.NewExpression): Value | undefined {
        const context = this.context;
        if (!context.options.deferredCapabilities) return undefined;
        const callee = context.unwrap(node.expression);
        const intl =
            ts.isPropertyAccessExpression(callee) &&
            context.libraryGlobal(callee.expression) === "Intl";
        const name = intl
            ? `Intl.${callee.name.text}`
            : context.libraryGlobal(callee);
        const origin = intl ? "default-lib" : "dom";
        if (!name || !descriptors.has(`${origin}:${name}.constructor`))
            return undefined;
        const signature = context.checker.getResolvedSignature(node);
        if (
            !signature?.declaration ||
            declarationOrigin(signature.declaration) !== origin
        )
            return undefined;
        if (name === "Response") {
            const body = node.arguments?.[0];
            const bodyType =
                body &&
                context.dataTypes.fromTsType(
                    context.checker.getTypeAtLocation(body),
                    body,
                );
            if (
                bodyType?.kind !== "deferred-platform-object" ||
                bodyType.name !== "ReadableByteStream"
            )
                return undefined;
        }
        const type = context.dataTypes.fromTsType(
            context.checker.getTypeAtLocation(node),
            node,
        );
        if (!type)
            return context.fail(
                node,
                `Deferred constructor '${name}' requires an owned result.`,
            );
        if (
            type.kind === "handle" &&
            type.handle === "ui-element" &&
            !context.options.workers
        )
            throw new ApplicationRealmRequired();
        this.arguments(node, signature, `${name}.constructor`);
        return this.emitKnown(
            node,
            {
                id: `${origin}:${name}.constructor`,
                origin,
                operation: "construct",
                timing: "throw",
                signature: context.checker.signatureToString(
                    signature,
                    node,
                    ts.TypeFormatFlags.NoTruncation,
                ),
            },
            type,
        );
    }

    property(
        node: ts.PropertyAccessExpression,
        owner: Value,
        rhs?: ts.Expression,
    ): Value | undefined {
        const context = this.context;
        if (!context.options.deferredCapabilities) return undefined;
        const descriptor = deferredPropertyDescriptor(context.checker, node);
        if (!descriptor) return undefined;
        const api = descriptor.api;
        if (!this.receiverMatches(api, owner, node.expression))
            return undefined;
        const declaration = resolvedSymbol(
            context.checker,
            node,
        )?.declarations?.find(ts.isPropertySignature);
        if (
            rhs &&
            declaration?.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
            )
        )
            return undefined;
        const result = context.dataTypes.fromTsType(
            context.checker.getTypeAtLocation(node),
            node,
        );
        if (!result)
            return context.fail(
                node,
                `Deferred property '${api}' requires an owned representation.`,
            );
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
                id: `${descriptor.origin}:${api}`,
                origin: descriptor.origin,
                operation: rhs ? "write" : "read",
                timing: "throw",
                signature: `${api}: ${context.checker.typeToString(context.checker.getTypeAtLocation(node), node, ts.TypeFormatFlags.NoTruncation)}`,
            },
            result,
        );
    }

    assignment(expression: ts.BinaryExpression): Value | undefined {
        const context = this.context;
        const left = context.unwrap(expression.left);
        if (
            !context.options.deferredCapabilities ||
            expression.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
            !ts.isPropertyAccessExpression(left) ||
            !deferredPropertyDescriptor(context.checker, left)
        )
            return undefined;
        return context.probeEmission(() =>
            this.property(
                left,
                context.compileValue(left.expression),
                expression.right,
            ),
        );
    }

    private windowReceiver(value: Value, node: ts.Expression): boolean {
        const context = this.context;
        const receiver = context.unwrap(node);
        const global = context.libraryGlobal(receiver);
        return (
            value.domEventTargetCpp === "bbl::DomEventTarget::window()" ||
            global === "window" ||
            global === "globalThis" ||
            isDomReceiver(context, receiver, "Window")
        );
    }

    private receiverMatches(
        api: string,
        value: Value,
        node: ts.Expression,
    ): boolean {
        const owner = api.startsWith("Intl.")
            ? api.split(".")[1]!
            : api.split(".")[0];
        if (owner === "Window") return this.windowReceiver(value, node);
        const type = value.dataType;
        if (DEFERRED_DOM_OBJECTS.some((name) => name === owner))
            return (
                type?.kind === "deferred-platform-object" && type.name === owner
            );
        const handle = type?.kind === "handle" ? type.handle : value.kind;
        if (owner === "SurfaceContext") return value.kind === "engine";
        if (owner === "ReadableStream")
            return (
                type?.kind === "deferred-platform-object" &&
                type.name === "ReadableByteStream"
            );
        if (owner === "Response" || owner === "Body")
            return (
                type?.kind === "http-response" ||
                value.kind === "static-fetch-response"
            );
        if (owner === "MediaStream") return handle === "media-stream";
        if (owner === "MediaStreamTrack")
            return handle === "media-stream-track";
        if (owner === "AudioContext") return handle === "audio-context";
        if (
            owner === "AudioNode" ||
            owner === "MediaStreamAudioDestinationNode"
        )
            return handle === "audio-node";
        if (owner === "Blob")
            return [value.kind, type?.kind].some(
                (kind) => kind === "blob" || kind === "file",
            );
        if (owner === "Event")
            return (
                value.kind === "platform-mouse-event" ||
                value.kind === "platform-keyboard-event" ||
                type?.kind === "borrowed-platform-event" ||
                (type?.kind === "handle" &&
                    ["dom-event", "custom-event"].includes(type.handle))
            );
        return value.kind === "ui-element" || type?.kind === "event-target";
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
        if (
            descriptor.api === "AudioNode.disconnect" &&
            call.arguments.length === 0
        )
            return undefined;
        const target = context.unwrap(call.expression);
        if (
            descriptor.origin !== "babylon" &&
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
            descriptor.origin !== "babylon" &&
            descriptor.api.includes(".") &&
            ts.isPropertyAccessExpression(target)
        ) {
            if (
                context.libraryGlobal(target.expression) ===
                descriptor.api.split(".")[0]
            )
                return invoke();
            return context.probeEmission(() => {
                const owner = context.compileValue(target.expression);
                const run = (value: Value): Value | undefined => {
                    if (
                        !this.receiverMatches(
                            descriptor.api,
                            value,
                            target.expression,
                        )
                    )
                        return undefined;
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
