import type { LoweringServices } from "../lowering-services.js";
import ts from "typescript";
import { argumentAt } from "../syntax.js";
import type { NamedMember } from "../symbols.js";
import { presenceFlagCpp, type Value } from "../types.js";
import type { DataStructField, DataType } from "../data-types.js";
import type { IntrinsicCallContext } from "./context.js";

/** What the handle's own methods need. The expression compiler satisfies it. */
interface VatMethodContext extends Pick<
    LoweringServices,
    | "emit"
    | "increaseIndent"
    | "decreaseIndent"
    | "cppString"
    | "compileValue"
    | "compileStringLiteral"
    | "compileNumber"
    | "requireEngine"
    | "reachFeature"
    | "unwrap"
    | "bindings"
    | "expectArgumentCount"
    | "fail"
> {}

/**
 * The per-bone captures a prepared VAT payload carries, by the pin's name,
 * as the native bake record's fields.
 */
export const VAT_BONE_CAPTURE_FIELDS: Readonly<Record<string, string>> = {
    boneOrigins: "bone_origins",
    boneMatrices: "bone_matrices",
};

export interface VatIntrinsicContext
    extends
        IntrinsicCallContext,
        VatMethodContext,
        Pick<
            LoweringServices,
            | "allocateTemporaryCppName"
            | "expectSameEngine"
            | "dataLowerer"
            | "dataTypes"
            | "reachJsData"
            | "reachJson"
            | "compileForDataSink"
            | "checker"
        > {}

/**
 * Vertex animation textures (`src/vat/vat-baker.ts`), the slice scenes 218
 * and 219 reach.
 *
 * Upstream the whole subsystem is a dynamic-import chunk a scene only pulls
 * in by calling `bakeVat`, and the VAT shader extension self-registers from
 * `attachVat` -- so a scene that never bakes one carries none of it. This
 * port reaches it at the same two calls: `mesh:vat` is what puts the bake,
 * the settings block and the per-mesh VAT texture into the build (the
 * per-instance params texture is `mesh:vat-instances`, a separate gate), and
 * a scene without it emits none of them.
 *
 * The bake itself is not re-derived here. Natively it is the ported
 * `go_to_frame` per frame with `MeshRecord::bone_matrices` copied into the
 * row -- the same palette the live skeleton path uploads, which is why
 * `VAT(frame N)` reproduces the live pose exactly.
 */
export function compileVatIntrinsic(
    context: VatIntrinsicContext,
    importedName: string,
    call: ts.CallExpression,
): Value | undefined {
    switch (importedName) {
        case "bakeVat": {
            // `bakeVat(engine, mesh, groups)`. The optional capture bag is
            // not reached by either scene, and capturing a bone origin or
            // matrix would have to survive into a native record nothing
            // reads, so a fourth argument refuses rather than being
            // silently dropped.
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const mesh = context.compileValue(argumentAt(call, 1));
            context.expectKind(mesh, "mesh", argumentAt(call, 1));
            context.expectSameEngine(engine, mesh, call);
            const groups = context.compileValue(argumentAt(call, 2));
            if (
                groups.kind !== "handle-collection" ||
                !groups.handleCollection ||
                groups.handleCollection.elementKind !== "animation-group"
            ) {
                context.fail(
                    argumentAt(call, 2),
                    "bakeVat takes the container's own animation-group collection; the bake reads each clip's posed palette frame by frame.",
                );
            }
            context.reachFeature("mesh:vat", call);
            // The baker's own imports: upstream `vat-baker.ts` pulls
            // `stopAnimation` from `animation/animation-group.ts` and
            // carries a CPU-only copy of its `goToFrame`. The bake is
            // exactly those two operations per frame, so reaching the
            // baker reaches the group module -- a scene need not have
            // driven a clip itself.
            context.reachFeature("animation:gltf-groups", call);
            const baked = context.allocateTemporaryCppName("vat_bake");
            context.emit({
                kind: "declaration",
                type: "const bbl::VatBake",
                name: baked,
                initializer: `bbl::bake_vat(${engine.cpp}, ${mesh.cpp}, ${groups.handleCollection.containerCpp})`,
            });
            return {
                kind: "vat-bake",
                cpp: baked,
                engineCpp: engine.cpp,
                dataType: { kind: "handle", handle: "vat-bake" },
            };
        }

        case "createVatBakeResult":
        case "createVatBakeResults":
            return compilePreparedVat(
                context,
                call,
                importedName === "createVatBakeResults",
            );

        case "attachVat": {
            // `attachVat(engine, mesh, baked, clip?)`: sets `mesh.vat`,
            // builds the 32-byte settings block and DROPS the live
            // skeleton, so from here the mesh deforms from the baked
            // texture alone.
            context.expectArgumentCount(call, 3, 4);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const mesh = context.compileValue(argumentAt(call, 1));
            context.expectKind(mesh, "mesh", argumentAt(call, 1));
            context.expectSameEngine(engine, mesh, call);
            const baked = context.compileValue(argumentAt(call, 2));
            context.expectKind(baked, "vat-bake", argumentAt(call, 2));
            // `clip ?? Object.keys(baked.clips)[0]`: an absent clip, or an
            // optional one at run time, takes the first natively.
            const clip = call.arguments[3]
                ? context.compileForDataSink(call.arguments[3], {
                      kind: "optional",
                      inner: { kind: "string" },
                  })
                : "std::nullopt";
            context.reachFeature("mesh:vat", call);
            const handle = context.allocateTemporaryCppName("vat_handle");
            context.emit({
                kind: "declaration",
                type: "const bbl::VatHandle",
                name: handle,
                initializer: `bbl::attach_vat(${engine.cpp}, ${mesh.cpp}, ${baked.cpp}, ${clip})`,
            });
            return {
                kind: "vat-handle",
                cpp: handle,
                engineCpp: engine.cpp,
            };
        }

        case "setVatTime": {
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const mesh = context.compileValue(argumentAt(call, 1));
            context.expectKind(mesh, "mesh", argumentAt(call, 1));
            context.expectSameEngine(engine, mesh, call);
            const seconds = context.compileNumber(
                argumentAt(call, 2),
                "double",
            );
            context.reachFeature("mesh:vat", call);
            context.reachFeature("mesh:vat-time", call);
            return {
                kind: "void",
                cpp: `bbl::set_vat_time(${engine.cpp}, ${mesh.cpp}, ${seconds})`,
            };
        }

        case "setVatInstanceStorage": {
            context.expectArgumentCount(call, 3, 3);
            const engine = context.compileValue(argumentAt(call, 0));
            context.expectKind(engine, "engine", argumentAt(call, 0));
            const mesh = context.compileValue(argumentAt(call, 1));
            context.expectKind(mesh, "mesh", argumentAt(call, 1));
            context.expectSameEngine(engine, mesh, call);
            const bufferExpression = context.unwrap(argumentAt(call, 2));
            let buffer = "std::nullopt";
            if (bufferExpression.kind !== ts.SyntaxKind.NullKeyword) {
                const value = context.compileValue(bufferExpression);
                context.expectKind(value, "storage-buffer", bufferExpression);
                context.expectSameEngine(engine, value, call);
                const present = presenceFlagCpp(value);
                buffer =
                    value.optionalStorageCpp !== undefined
                        ? value.optionalStorageCpp
                        : present !== undefined
                          ? `(${present} ? std::optional<bbl::StorageBufferHandle>{${value.cpp}} : std::nullopt)`
                          : `std::optional<bbl::StorageBufferHandle>{${value.cpp}}`;
            }
            context.reachFeature("mesh:vat", call);
            context.reachFeature("mesh:vat-instance-storage", call);
            return {
                kind: "void",
                cpp: `bbl::set_vat_instance_storage(${engine.cpp}, ${mesh.cpp}, ${buffer})`,
            };
        }

        default:
            return undefined;
    }
}

/**
 * `createVatBakeResult(s)(engine, prepared)`: offline-prepared payloads
 * become bakes without evaluating a clip. Each program record is copied
 * into the native payload field by field: counts, the matrix data, the
 * clip rows in property order, and the optional bone captures, which keep
 * their typed arrays (the pin's result holds the very arrays passed in).
 * An absent record or clip leaves NaN counts, which the pin's own checks
 * refuse as they refuse `undefined`.
 */
function compilePreparedVat(
    context: VatIntrinsicContext,
    call: ts.CallExpression,
    many: boolean,
): Value {
    context.expectArgumentCount(call, 2, 2);
    const engine = context.compileValue(argumentAt(call, 0));
    context.expectKind(engine, "engine", argumentAt(call, 0));
    const argument = argumentAt(call, 1);
    // The payload stores as the parameter's declared type, as an argument
    // does: an inline literal's own type names its clips as fields.
    const declared = context.checker.getContextualType(argument);
    const sink = declared
        ? context.dataTypes.fromTsType(declared, argument)
        : context.dataLowerer.dataTypeAt(argument);
    const record = many
        ? sink?.kind === "vector" || sink?.kind === "span"
            ? sink.element
            : undefined
        : sink;
    if (!sink || record?.kind !== "struct")
        return context.fail(
            argument,
            "createVatBakeResults takes PreparedVatBakeResult records.",
        );
    const names = {
        entry: context.allocateTemporaryCppName("vat_prepared_entry"),
        payload: context.allocateTemporaryCppName("vat_payload"),
        clip: context.allocateTemporaryCppName("vat_clip"),
        name: context.allocateTemporaryCppName("vat_clip_name"),
    };
    const fields = preparedVatFields(context, record, argument, names);
    context.reachJsData();
    // Object.entries' property order is the json header's.
    context.reachJson();
    context.reachFeature("mesh:vat", call);
    context.reachFeature("mesh:vat-prepared", call);
    const prepared = context.allocateTemporaryCppName("vat_prepared");
    context.emit({
        kind: "declaration",
        type: "const auto&",
        name: prepared,
        initializer: context.dataLowerer.compileForSink(argument, sink),
    });
    const payloads = context.allocateTemporaryCppName("vat_payloads");
    context.emit(`std::vector<bbl::PreparedVatPayload> ${payloads};`);
    context.emit({
        kind: "open",
        code: many
            ? `for (const auto& ${names.entry} : ${prepared}) {`
            : `{ const auto& ${names.entry} = ${prepared};`,
    });
    context.increaseIndent();
    context.emit(
        `bbl::PreparedVatPayload& ${names.payload} = ${payloads}.emplace_back();`,
    );
    for (const line of fields) context.emit(line);
    context.decreaseIndent();
    context.emit({ kind: "close", code: "}" });
    const created = `bbl::create_vat_bakes(${engine.cpp}, ${payloads})`;
    if (!many) {
        const baked = context.allocateTemporaryCppName("vat_bake");
        context.emit({
            kind: "declaration",
            type: "const bbl::VatBake",
            name: baked,
            initializer: `${created}[0]`,
        });
        return {
            kind: "vat-bake",
            cpp: baked,
            engineCpp: engine.cpp,
            dataType: { kind: "handle", handle: "vat-bake" },
        };
    }
    const resultType = context.dataLowerer.dataTypeAt(call);
    if (
        resultType?.kind !== "vector" ||
        resultType.element.kind !== "handle" ||
        resultType.element.handle !== "vat-bake"
    )
        return context.fail(
            call,
            "createVatBakeResults returns VatBakeResult handles.",
        );
    const results = context.allocateTemporaryCppName("vat_bakes");
    context.emit(
        `${context.dataTypes.cppType(resultType)} ${results} = ${created};`,
    );
    context.dataLowerer.registerLocal(results, "owned");
    return { kind: "data", cpp: results, dataType: resultType };
}

/**
 * The statements filling the payload from one program record of the pin's
 * `PreparedVatBakeResult` shape; a field stored any other way than the
 * native payload's refuses.
 */
function preparedVatFields(
    context: VatIntrinsicContext,
    record: DataType<"struct">,
    node: ts.Node,
    names: { entry: string; payload: string; clip: string; name: string },
): string[] {
    const { entry, payload, clip: clipName, name } = names;
    const read = structReader(context, record, node);
    const required = (name: string, kind: DataType["kind"]): string => {
        const field = read.field(name);
        if (field?.type.kind !== kind)
            context.fail(
                node,
                `A prepared VAT record stores '${name}' as ${kind}.`,
            );
        return read.cpp(entry, field);
    };
    const clipsField = read.field("clips");
    const clip =
        clipsField?.type.kind === "map" &&
        clipsField.type.key.kind === "string" &&
        clipsField.type.value.kind === "struct"
            ? clipsField.type.value
            : undefined;
    if (!clipsField || !clip)
        context.fail(
            node,
            "A prepared VAT record stores its clips as named clip records.",
        );
    const readClip = structReader(context, clip, node);
    const clipNumber = (name: string): string => {
        const field = readClip.field(name);
        if (field?.type.kind !== "number")
            context.fail(node, `A VAT clip stores '${name}' as a number.`);
        return readClip.cpp(clipName, field);
    };
    const row = `bbl::VatClipRow{${name}, ${clipNumber("fromRow")}, ${clipNumber("frameCount")}, ${clipNumber("fps")}}`;
    const lines = [
        `${payload}.bone_count = ${required("boneCount", "number")};`,
        `${payload}.frame_count = ${required("frameCount", "number")};`,
        `${payload}.data = ${required("data", "f32array")};`,
        `bbl::js::for_each_property_entry(${read.cpp(entry, clipsField)}, [&](const std::string& ${name}, const auto& ${clipName}) { ${payload}.clips.push_back(${
            readClip.reference
                ? `${clipName} ? ${row} : bbl::VatClipRow{${name}, std::numeric_limits<double>::quiet_NaN()}`
                : row
        }); });`,
    ];
    for (const [source, target] of Object.entries(VAT_BONE_CAPTURE_FIELDS)) {
        const field = read.field(source);
        if (!field) continue;
        const capture =
            field.type.kind === "optional" ? field.type.inner : undefined;
        if (
            capture?.kind !== "map" ||
            capture.weak ||
            capture.key.kind !== "number" ||
            capture.value.kind !== "f32array"
        )
            context.fail(
                node,
                `A prepared VAT record stores '${source}' as optional per-bone Float32Arrays.`,
            );
        lines.push(`${payload}.${target} = ${read.cpp(entry, field)};`);
    }
    return read.reference
        ? [`if (${entry}) {`, ...lines.map((line) => `    ${line}`), "}"]
        : lines;
}

/** Field reads of one stored record type: through its reference or in place. */
function structReader(
    context: VatIntrinsicContext,
    type: DataType<"struct">,
    node: ts.Node,
): {
    reference: boolean;
    field(name: string): DataStructField | undefined;
    cpp(owner: string, field: DataStructField): string;
} {
    return {
        reference: context.dataTypes.isReferenceStruct(type.name),
        field: (name) =>
            context.dataTypes.findStructField(type.name, name, node),
        cpp: (owner, field) =>
            `${owner}${context.dataTypes.memberAccess(type.name)}${field.name}`,
    };
}

/**
 * `handle.play(...)`, `handle.update(dt)` and `handle.setInstances(...)`.
 *
 * `VatHandle` is the second pinned surface where a resource carries methods
 * (the Web Audio family is the first), because upstream returns a closure
 * bundle rather than free functions. Natively the handle names the mesh
 * whose VAT record each method writes, so the three methods lower to three
 * writers over that record.
 *
 * Both scenes hold the handle in a nullable local -- it is only attached
 * when the file carried a skinned mesh and clips -- and read it through
 * `?.`, so an optional receiver emits its guard here rather than
 * dereferencing an empty optional.
 */
export function compileVatMethodCall(
    context: VatMethodContext,
    call: ts.CallExpression,
    callee: NamedMember,
): Value | undefined {
    const receiverExpression = context.unwrap(callee.expression);
    if (!ts.isIdentifier(receiverExpression)) return undefined;
    const receiver = context.bindings.lookupOptional(receiverExpression);
    if (!receiver || receiver.kind !== "vat-handle") return undefined;
    const method = callee.name;
    if (!["play", "update", "setInstances"].includes(method)) {
        context.fail(
            callee.key,
            `A VatHandle carries play, update and setInstances; '${method}' is not lowered.`,
        );
    }
    const engine = context.requireEngine(receiver, call);
    // `a?.f(x)` never evaluates `x` when `a` is null, so the arguments are
    // compiled inside the guard rather than before it.
    const found = presenceFlagCpp(receiver);
    const guarded = found !== undefined;
    if (guarded) {
        context.emit({ kind: "open", code: `if (${found}) {` });
        context.increaseIndent();
    }
    try {
        if (method === "play") {
            context.expectArgumentCount(call, 1, 2);
            const clip = context.cppString(
                context.compileStringLiteral(argumentAt(call, 0)),
            );
            const options = call.arguments[1]
                ? vatPlayOptions(context, call.arguments[1])
                : { offset: undefined, fps: undefined };
            context.emit({
                kind: "expression",
                code:
                    `bbl::vat_play(${engine}, ${receiver.cpp}, ${clip}, ` +
                    `${optionalDouble(options.offset)}, ` +
                    `${optionalDouble(options.fps)});`,
            });
        } else if (method === "update") {
            context.expectArgumentCount(call, 1, 1);
            const delta = context.compileNumber(argumentAt(call, 0), "double");
            context.emit({
                kind: "expression",
                code: `bbl::vat_update(${engine}, ${receiver.cpp}, ${delta});`,
            });
        } else {
            context.expectArgumentCount(call, 1, 1);
            const params = context.compileValue(argumentAt(call, 0));
            if (
                params.kind !== "data" ||
                params.dataType?.kind !== "f32array"
            ) {
                context.fail(
                    argumentAt(call, 0),
                    "VatHandle.setInstances takes the per-instance Float32Array the pin uploads to the params texture.",
                );
            }
            context.reachFeature("mesh:vat-instances", call);
            context.emit({
                kind: "expression",
                code:
                    `bbl::vat_set_instances(${engine}, ${receiver.cpp}, ` +
                    `${params.cpp});`,
            });
        }
    } finally {
        if (guarded) {
            context.decreaseIndent();
            context.emit({ kind: "close", code: "}" });
        }
    }
    return { kind: "void", cpp: "" };
}

function optionalDouble(value: string | undefined): string {
    return value === undefined
        ? "std::optional<double>{}"
        : `std::optional<double>{${value}}`;
}

/**
 * `play`'s `{ offset?, fps? }` bag, read from the literal the call site
 * writes. Upstream defaults `offset` to 0 and `fps` to the clip's own rate,
 * and both defaults live natively where the clip row does -- so an omitted
 * field travels as an empty optional rather than as a number this side
 * would have to invent.
 */
function vatPlayOptions(
    context: VatMethodContext,
    expression: ts.Expression,
): { offset: string | undefined; fps: string | undefined } {
    const literal = context.unwrap(expression);
    if (!ts.isObjectLiteralExpression(literal)) {
        context.fail(
            expression,
            "VatHandle.play takes its playback options as an object literal.",
        );
    }
    let offset: string | undefined;
    let fps: string | undefined;
    for (const property of literal.properties) {
        if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name)
        ) {
            context.fail(
                property,
                "VatHandle.play options take named offset and fps assignments.",
            );
        }
        const value = context.compileNumber(property.initializer, "double");
        if (property.name.text === "offset") {
            offset = value;
        } else if (property.name.text === "fps") {
            fps = value;
        } else {
            context.fail(
                property.name,
                `VatHandle.play carries offset and fps; '${property.name.text}' is not lowered.`,
            );
        }
    }
    return { offset, fps };
}
