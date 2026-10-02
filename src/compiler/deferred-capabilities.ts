import { createHash } from "node:crypto";
import ts from "typescript";
import {
    sceneRelativeSourceLabel,
    sourceLocation,
    syntaxKindName,
} from "../source-location.js";
import { EmissionMap } from "./emission-transaction.js";
import type { DataType } from "./data-types.js";
import type { LoweringServices } from "./lowering-services.js";
import { declarationOrigin } from "./symbols.js";
import type { Value } from "./types.js";
import { ApplicationRealmRequired } from "./worker-modules.js";

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
    ].map((api): Descriptor => ({ origin: "dom", api, timing: "throw" })),
    ...[
        "Document.exitFullscreen",
        "Element.requestFullscreen",
        "Blob.text",
        "Blob.arrayBuffer",
        "Blob.bytes",
    ].map((api): Descriptor => ({ origin: "dom", api, timing: "reject" })),
    ...[
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

type Context = Pick<
    LoweringServices,
    | "checker"
    | "options"
    | "compileValue"
    | "dataTypes"
    | "dataLowerer"
    | "emitDiscardedValue"
    | "reachJsData"
    | "fail"
    | "cppString"
    | "unwrap"
    | "bindings"
    | "libraryGlobal"
    | "symbols"
>;

export class DeferredCapabilities {
    private readonly reached = new EmissionMap<
        string,
        DeferredCapabilitySite
    >();
    /** @unjournaled Immutable parsed source hashes, independent of emission attempts. */
    private readonly sourceHashes = new WeakMap<ts.SourceFile, string>();
    constructor(private readonly context: Context) {}
    get sites(): readonly DeferredCapabilitySite[] {
        return [...this.reached.values()];
    }

    compile(call: ts.CallExpression): Value | undefined {
        const context = this.context;
        if (!context.options.deferredCapabilities) return undefined;
        const descriptor = deferredCapabilityDescriptor(context.checker, call);
        if (!descriptor) return undefined;
        const target = context.unwrap(call.expression);
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
            for (const [index, argument] of call.arguments.entries()) {
                if (ts.isSpreadElement(argument))
                    return context.fail(
                        argument,
                        "Deferred capability argument spreads require an explicit expanded signature.",
                    );
                const parameter = signature.parameters[index];
                const parameterType =
                    parameter &&
                    context.checker.getTypeOfSymbolAtLocation(parameter, call);
                const expected =
                    parameterType &&
                    context.dataTypes.fromTsType(parameterType, argument);
                const value = context.compileValue(argument);
                if (expected) {
                    const cpp = context.dataLowerer.compileKnownValueForSink(
                        value,
                        expected,
                        argument,
                    );
                    context.emitDiscardedValue(
                        context.dataLowerer.leafValue(cpp, expected),
                    );
                } else {
                    // An unrepresented parameter is not permission to hide its authored value.
                    const actual = context.dataTypes.fromTsType(
                        context.checker.getTypeAtLocation(argument),
                        argument,
                    );
                    if (!actual)
                        return context.fail(
                            argument,
                            `Deferred capability '${descriptor.api}' argument has no owned native representation.`,
                        );
                    const cpp = context.dataLowerer.compileKnownValueForSink(
                        value,
                        actual,
                        argument,
                    );
                    context.emitDiscardedValue(
                        context.dataLowerer.leafValue(cpp, actual),
                    );
                }
            }
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
            const owner = context.compileValue(target.expression);
            const run = (value: Value) => {
                const ownerType = descriptor.api.split(".")[0];
                const valid =
                    ownerType === "Blob"
                        ? value.kind === "blob" || value.kind === "file"
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
                if (!valid)
                    return context.fail(
                        target.expression,
                        `Deferred '${descriptor.api}' requires its represented native receiver.`,
                    );
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
        const original = ts.getOriginalNode(node);
        const { file, line, character } = sourceLocation(original);
        let sourceSha256 = this.sourceHashes.get(file);
        if (!sourceSha256) {
            sourceSha256 = createHash("sha256").update(file.text).digest("hex");
            this.sourceHashes.set(file, sourceSha256);
        }
        const site: DeferredCapabilitySite = {
            ...descriptor,
            signatureHash: createHash("sha256")
                .update(descriptor.signature)
                .digest("hex"),
            file: file.fileName.replaceAll("\\", "/"),
            line,
            column: character,
            start: original.getStart(file),
            end: original.end,
            kind: syntaxKindName(original.kind),
            sourceSha256,
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
