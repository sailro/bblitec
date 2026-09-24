/**
 * The clustered light field as one generated translation unit.
 *
 * The container and its lights are `runtime.hpp` records the emitted scene
 * fills, because both reached scenes build a thousand lights inside a loop.
 * `buildClusteredLightGpuState` is lowered from its own body: the build,
 * which sizes the three data textures, seeds the params block and runs the
 * first refresh when the container is added, and the `refresh` closure
 * whole -- its dirty key (camera identity, `_cameraChangeKey`, the target
 * extent, the effective aspect and the light-edit scan), the re-bin and the
 * payload rewrite. The locals the closure captures live on the generated
 * `ClusteredRefreshState` the container holds.
 *
 * What is not translated is the platform around that arithmetic, each piece
 * identified by the declaration it resolves to (`pinned-callee.ts`) rather
 * than by how it is spelled:
 *
 *  - GPU objects. `createUniformBuffer`'s buffer and `createDataTexture`'s
 *    textures are the backend's, created from the extents the build stores
 *    on the record; the buffer's creation is the params block's first write.
 *  - GPU writes. A params `queue.writeBuffer` counts a params write, and each
 *    `writeDataTexture` records the region and row layout its own
 *    `queue.writeTexture` states, which the backend uploads.
 *  - The GPU state object. Its views are the backend's textures, its
 *    `refresh` is `refresh_clustered_lights`, its `dispose` the backend's
 *    release, and the spot support's `_markState` flag is the composition
 *    input generation already read.
 */
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import {
    clusteredAddLightToClusters,
    clusteredCalls,
    clusteredConeWriter,
    clusteredLightMembers,
    clusteredLightShape,
    clusteredModule,
    clusteredParameterNames,
    clusteredProjectedBounds,
    clusteredScalarHelpers,
    clusteredSpotMethod,
    clusteredSpotModule,
    clusteredSpotStride,
} from "./clustered-light-lowerer.js";
import { cameraChangeKeyHeader } from "./camera-change-key-lowerer.js";
import { lowerPinnedBody } from "./pinned-body-lowerer.js";
import { lowerPinnedFunction } from "./pinned-function-lowerer.js";
import {
    callsPinned,
    pinnedCallee,
    pinnedDeclaration,
    webGpuQueueMethod,
} from "./pinned-callee.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
    type PinnedNumericScope,
    type PinnedRecordShape,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { recordAt } from "../compiler/record-access.js";

const buildSymbol = "buildClusteredLightGpuState";
const cameraModule = "src/camera/camera.ts";

/**
 * The WebGPU default for `maxTextureDimension2D`. The pin's `createEngine`
 * requests no limits unless its options name some, so this is the value
 * `engine._device.limits.maxTextureDimension2D` reads in the browser the
 * reference captures come from -- which the pin then clamps to its own
 * `MAX_DATA_TEXTURE_WIDTH`.
 */
const WEBGPU_DEFAULT_MAX_TEXTURE_DIMENSION_2D = 8192;

/**
 * The build's locals the record keeps, by the native field that holds each.
 *
 * `count` is a whole number both halves read; `f32`/`u32` is one of the
 * three payloads, allocated by the pin's own `new F32(...)`/`new U32(...)`;
 * `rows` is a data texture, whose only native trace is the row count the
 * pin's `createDataTexture` sizes it with -- the backend creates the
 * texture itself from that count -- and the write record its
 * `writeDataTexture` calls fill for the payload it uploads.
 */
type RecordStorage =
    | { field: string; kind: "count" | "f32" | "u32" }
    | { field: string; kind: "rows"; write: string; payload: string };

const RECORD_STORAGE: ReadonlyMap<string, RecordStorage> = new Map<
    string,
    RecordStorage
>([
    ["tileCountX", { field: "tile_count_x", kind: "count" }],
    ["tileCountY", { field: "tile_count_y", kind: "count" }],
    ["zSlices", { field: "slice_count", kind: "count" }],
    ["lightTexels", { field: "light_texels", kind: "count" }],
    ["maskTexels", { field: "mask_texels", kind: "count" }],
    ["dataTextureWidth", { field: "data_texture_width", kind: "count" }],
    ["lightData", { field: "light_data", kind: "f32" }],
    ["sliceData", { field: "slice_data", kind: "u32" }],
    ["maskData", { field: "mask_data", kind: "u32" }],
    [
        "lightsTexture",
        {
            field: "light_rows",
            kind: "rows",
            write: "light_write",
            payload: "lightData",
        },
    ],
    [
        "cellsTexture",
        {
            field: "slice_rows",
            kind: "rows",
            write: "slice_write",
            payload: "sliceData",
        },
    ],
    [
        "indicesTexture",
        {
            field: "mask_rows",
            kind: "rows",
            write: "mask_write",
            payload: "maskData",
        },
    ],
]);

/** The pin's typed-array constructors for each payload width. */
const PAYLOAD_CONSTRUCTORS = {
    f32: ["F32", "Float32Array"],
    u32: ["U32", "Uint32Array"],
} as const;

/**
 * The GPU state object's members, each the backend's: the params buffer
 * and the three texture views bind, `refresh` is the lowered refresh, and
 * `dispose` the backend's release. A member the pin adds refuses here
 * rather than being dropped with the object.
 */
const GPU_STATE_MEMBERS: ReadonlySet<string> = new Set([
    "paramsBuffer",
    "lightsView",
    "cellsView",
    "indicesView",
    "refresh",
    "dispose",
]);

/** The native C++ for each camera function the refresh imports. */
const CAMERA_SPELLINGS: ReadonlyMap<
    string,
    { arity: number; spell: (args: readonly string[]) => string }
> = new Map([
    [
        "getEffectiveAspectRatio",
        {
            arity: 3,
            spell: (args: readonly string[]) =>
                `effective_aspect_ratio(*${args[0]}, ${args[1]}, ${args[2]})`,
        },
    ],
    [
        "_cameraChangeKey",
        {
            arity: 1,
            spell: (args: readonly string[]) =>
                `scene_camera_change_key(*${args[0]})`,
        },
    ],
    [
        "getViewMatrix",
        {
            arity: 1,
            spell: (args: readonly string[]) =>
                `build_view_matrix(camera_world_matrix(*${args[0]}))`,
        },
    ],
    [
        "getProjectionMatrix",
        {
            arity: 2,
            spell: (args: readonly string[]) =>
                `build_scene_projection(*${args[0]}, ${args[1]})`,
        },
    ],
]);

/**
 * The state field `_create`'s own `snapshot` lands in: the spot support's
 * cone snapshot, which its `_coneChanged` closes over.
 */
const SPOT_SNAPSHOT = "spotSnapshot";

/**
 * Whether the build's `spotSupport` exists: `_create` ran, because the
 * container's support was installed when the state was built. The refresh
 * tests it against the container's live support, so it is its own field.
 */
const SPOT_SUPPORT_PRESENT = "captured.spotSupport";

/** The name a variable statement declares, when it declares exactly one. */
function declaredName(statement: ts.Statement): string | undefined {
    if (!ts.isVariableStatement(statement)) return undefined;
    const [declaration, ...rest] = statement.declarationList.declarations;
    return declaration && rest.length === 0 && ts.isIdentifier(declaration.name)
        ? declaration.name.text
        : undefined;
}

/** The single declaration a variable statement makes. */
function onlyDeclaration(
    statement: ts.Statement,
): ts.VariableDeclaration | undefined {
    if (!ts.isVariableStatement(statement)) return undefined;
    const [declaration, ...rest] = statement.declarationList.declarations;
    return rest.length === 0 ? declaration : undefined;
}

function scalar(cpp: string): PinnedBinding {
    return { cpp, type: "scalar" };
}

/** The call an expression statement makes, when it makes one. */
function statementCall(
    context: LoweringContext,
    statement: ts.Statement,
): ts.CallExpression | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined;
    const call = context.unwrapExpression(statement.expression);
    return ts.isCallExpression(call) ? call : undefined;
}

/** `spotSupport._create`, the spot support's per-state factory. */
function spotCreate(context: LoweringContext): {
    file: ts.SourceFile;
    create: ts.FunctionLikeDeclarationBase;
    statements: readonly ts.Statement[];
} {
    const { file, declaration } = context.methodDeclaration(
        clusteredSpotModule,
        "spotSupport._create",
    );
    const body = declaration.body;
    if (!body || !ts.isBlock(body)) {
        return context.contractError(
            declaration,
            "Expected spotSupport._create to have a block body.",
        );
    }
    return { file, create: declaration, statements: body.statements };
}

/**
 * The pin's `_ClusteredActiveLight`, as the native struct the refresh
 * collects into: each light record member a pointer into the container
 * (the pin holds the object), each number a double, an optional member
 * null when absent. Read off the interface so a member the pin adds or
 * renames moves the struct, and every literal and destructuring below is
 * checked against it.
 */
function activeLightMembers(
    context: LoweringContext,
): readonly { name: string; record: boolean; optional: boolean }[] {
    const file = context.sourceFile(clusteredModule);
    const declared = file.statements.find(
        (statement): statement is ts.InterfaceDeclaration =>
            ts.isInterfaceDeclaration(statement) &&
            statement.name.text === "_ClusteredActiveLight",
    );
    if (!declared) {
        return context.contractError(
            file,
            "Expected the pinned _ClusteredActiveLight record.",
        );
    }
    return declared.members.map((member) => {
        const type = ts.isPropertySignature(member) ? member.type : undefined;
        if (!ts.isPropertySignature(member) || !type) {
            return context.contractError(
                member,
                "Expected a typed _ClusteredActiveLight member.",
            );
        }
        const record =
            ts.isTypeReferenceNode(type) &&
            ts.isIdentifier(type.typeName) &&
            ["ClusteredPointLight", "ClusteredSpotLight"].includes(
                type.typeName.text,
            );
        if (!record && type.kind !== ts.SyntaxKind.NumberKeyword) {
            context.contractError(
                member,
                "Expected each _ClusteredActiveLight member to be a light " +
                    "record or a number.",
            );
        }
        const name = context.propertyName(member.name);
        if (name === undefined) {
            return context.contractError(
                member,
                "Expected a named _ClusteredActiveLight member.",
            );
        }
        return { name, record, optional: member.questionToken !== undefined };
    });
}

function activeLightStruct(context: LoweringContext): string {
    const fields = activeLightMembers(context).map(({ name, record }) =>
        record
            ? `    const ClusteredLight* ${name} = nullptr;`
            : `    double ${name} = 0.0;`,
    );
    return `// ${context.provenance(clusteredModule, "_ClusteredActiveLight")}
struct ClusteredActiveLight {
${fields.join("\n")}
};`;
}

/**
 * `_ClusteredActiveLight` as a record shape: a light member reads through
 * the pointer the struct holds (null for an absent optional one) and is
 * stored as the address of the light the literal names, which is an
 * element of the container's own list.
 */
function activeLightShape(context: LoweringContext): PinnedRecordShape {
    const light = clusteredLightShape();
    return {
        cpp: "ClusteredActiveLight",
        members: activeLightMembers(context).map(
            ({ name, record, optional }) => {
                if (!record) {
                    return {
                        name,
                        read: (owner: string) =>
                            new Map([["", scalar(`${owner}.${name}`)]]),
                        store: (value: string) => value,
                    };
                }
                return {
                    name,
                    read: (owner: string) => {
                        const field = `${owner}.${name}`;
                        const target = `(*${field})`;
                        const bindings = new Map<string, PinnedBinding>([
                            [
                                "",
                                optional
                                    ? {
                                          cpp: field,
                                          type: "opaque",
                                          record: light,
                                          absentCpp: `${field} == nullptr`,
                                      }
                                    : {
                                          cpp: target,
                                          type: "opaque",
                                          record: light,
                                      },
                            ],
                        ]);
                        for (const member of light.members) {
                            for (const [path, binding] of member.read(target)) {
                                bindings.set(`.${member.name}${path}`, binding);
                            }
                        }
                        return bindings;
                    },
                    store: (value: string) => `&${value}`,
                    ...(optional ? { absent: "nullptr" } : {}),
                };
            },
        ),
    };
}

/**
 * The spellings both halves share: the pin's two light lists and version
 * on the record, the payloads and params block on the record, and the
 * installed spot support and the pinned helpers it and the refresh call.
 */
function sharedScope(context: LoweringContext): {
    bindings: Map<string, PinnedBinding>;
    calls: Map<string, (args: readonly string[]) => string>;
    methods: NonNullable<PinnedNumericScope["methods"]>;
} {
    const stride = clusteredSpotStride(context);
    const light = clusteredLightShape();
    const bindings = new Map<string, PinnedBinding>([
        // `container._spotSupport` is installed by the first spot light and
        // is what `has_spots` records; its `_stride` is the pin's own.
        [
            "spotSupport",
            {
                cpp: "container",
                type: "opaque",
                absentCpp: "!container.has_spots",
                optional: {
                    present: "container.has_spots",
                    members: new Map([["_stride", { cpp: `${stride}.0` }]]),
                },
            },
        ],
        [
            "container._spotSupport",
            {
                cpp: "container",
                type: "opaque",
                absentCpp: "!container.has_spots",
            },
        ],
        // One `ArrayBuffer(32)`, viewed both ways: the record keeps the
        // eight lanes as words, and a store through the float view writes a
        // float's bytes into its lane.
        ["params", { cpp: "container.params", type: "opaque" }],
        ["paramsU", { cpp: "container.params", type: "u32", mutable: true }],
        [
            "paramsF",
            {
                cpp: "container.params",
                type: "f32",
                indexedStore: (owner, index, value) =>
                    `store_clustered_f32_lane(${owner}, ${index}, ${value})`,
            },
        ],
        [
            "engine._device.limits.maxTextureDimension2D",
            {
                cpp: `${WEBGPU_DEFAULT_MAX_TEXTURE_DIMENSION_2D}.0`,
                type: "scalar",
            },
        ],
        ["container.horizontalTiles", scalar("container.horizontal_tiles")],
        ["container.verticalTiles", scalar("container.vertical_tiles")],
        ["container.zSlices", scalar("container.z_slices")],
        ["container._version", scalar("container.version")],
        [
            "container.pointLights",
            {
                cpp: "container.point_lights",
                type: "record-list",
                record: light,
            },
        ],
        [
            "container.spotLights",
            {
                cpp: "container.spot_lights",
                type: "record-list",
                record: light,
            },
        ],
    ]);
    const calls = clusteredCalls();
    calls.set(
        "addLightToClusters",
        (args) => `add_light_to_clusters(${args.join(", ")})`,
    );
    calls.set("snapshotLight", (args) => `snapshot_light(${args.join(", ")})`);
    // The spot support's methods, each lowered from its own body below and
    // run only where the pin's `?.` finds the support installed.
    calls.set(
        "spotSupport._write",
        (args) =>
            `(${SPOT_SUPPORT_PRESENT} ? write_clustered_cone(${args.join(", ")}) : void())`,
    );
    calls.set(
        "spotSupport._collect",
        (args) =>
            `(${SPOT_SUPPORT_PRESENT} ? collect_clustered_spots(${args.join(", ")}) : void())`,
    );
    calls.set(
        "spotSupport._coneChanged",
        (args) =>
            `clustered_cone_changed(captured.${SPOT_SNAPSHOT}, ${args.join(", ")})`,
    );
    const methods: NonNullable<PinnedNumericScope["methods"]> = new Map([
        [
            "fill",
            (receiver, args, binding) => {
                const value =
                    binding.type === "u32"
                        ? `static_cast<std::uint32_t>(${args[0]})`
                        : `static_cast<float>(${args[0]})`;
                if (args.length === 1)
                    return `bbl::js::array_fill(${receiver}, ${value})`;
                if (args.length === 3)
                    return `bbl::js::array_fill_range(${receiver}, ${value}, ${args[1]}, ${args[2]})`;
                throw new Error(
                    `Unsupported pinned fill arity ${args.length} on ${receiver}.`,
                );
            },
        ],
    ]);
    return { bindings, calls, methods };
}

/** Each record-held local's spelling, once the build has stored it. */
function recordBindings(): [string, PinnedBinding][] {
    return [...RECORD_STORAGE].flatMap(
        ([pinned, storage]): [string, PinnedBinding][] =>
            storage.kind === "count"
                ? [
                      [
                          pinned,
                          scalar(
                              `static_cast<double>(container.${storage.field})`,
                          ),
                      ],
                  ]
                : storage.kind === "rows"
                  ? []
                  : [
                        [
                            pinned,
                            {
                                cpp: `container.${storage.field}`,
                                type: storage.kind,
                                mutable: true,
                            },
                        ],
                    ],
    );
}

/** `typed.set(source, offset)` into a float payload: each lane rounds. */
function copyToFloats(
    receiver: string,
    source: string,
    offset: string,
): string {
    return (
        `std::transform(${source}.begin(), ${source}.end(), ` +
        `${receiver}.begin() + static_cast<std::ptrdiff_t>(${offset}), ` +
        "[](double value) { return static_cast<float>(value); })"
    );
}

/** One captured local the closure keeps, and how the build seeds it. */
interface StateField {
    name: string;
    kind: "number" | "f32" | "active-lights" | "camera" | "support";
    cpp: string;
    binding: PinnedBinding;
}

/** `container._spotSupport?._create(count)`: the spot support's creation. */
function spotSupportCall(
    context: LoweringContext,
    declaration: ts.VariableDeclaration,
): ts.CallExpression | undefined {
    const call = declaration.initializer
        ? context.unwrapExpression(declaration.initializer)
        : undefined;
    return call &&
        ts.isCallExpression(call) &&
        ts.isPropertyAccessExpression(call.expression) &&
        call.expression.name.text === "_create" &&
        context.propertyPath(call.expression.expression)?.join(".") ===
            "container._spotSupport" &&
        call.arguments.length === 1
        ? call
        : undefined;
}

/**
 * The GPU state object: the build's local whose literal declares the
 * `refresh` method the per-frame half lowers.
 */
function gpuState(
    context: LoweringContext,
    build: ts.FunctionDeclaration,
): {
    declaration: ts.VariableDeclaration;
    refresh: ts.MethodDeclaration & { body: ts.Block };
} {
    const methods = context.findNodes(
        build,
        (node): node is ts.MethodDeclaration & { body: ts.Block } =>
            ts.isMethodDeclaration(node) &&
            ts.isIdentifier(node.name) &&
            node.name.text === "refresh" &&
            node.body !== undefined,
    );
    const refresh = methods[0];
    const declaration = refresh?.parent.parent;
    if (
        methods.length !== 1 ||
        !refresh ||
        !ts.isObjectLiteralExpression(refresh.parent) ||
        !declaration ||
        !ts.isVariableDeclaration(declaration)
    ) {
        return context.contractError(
            build,
            `Expected ${buildSymbol}'s state to declare one refresh.`,
        );
    }
    for (const property of refresh.parent.properties) {
        const name = property.name
            ? context.propertyName(property.name)
            : undefined;
        if (!name || !GPU_STATE_MEMBERS.has(name)) {
            context.contractError(
                property,
                `${buildSymbol}'s GPU state carries a member this port does not bind.`,
            );
        }
    }
    return { declaration, refresh };
}

/** Whether an expression names `declaration`, by its symbol. */
function names(
    file: ts.SourceFile,
    expression: ts.Expression | undefined,
    declaration: ts.Declaration,
    context: LoweringContext,
): boolean {
    const node = expression ? context.unwrapExpression(expression) : undefined;
    return (
        node !== undefined &&
        ts.isIdentifier(node) &&
        pinnedDeclaration(file, node) === declaration
    );
}

/**
 * The build's own declaration a name in its body resolves to, when it is
 * one of the build's top-level locals.
 */
function buildLocal(
    file: ts.SourceFile,
    build: ts.FunctionDeclaration,
    identifier: ts.Identifier,
): ts.VariableDeclaration | undefined {
    const declaration = pinnedDeclaration(file, identifier);
    return declaration &&
        ts.isVariableDeclaration(declaration) &&
        ts.isVariableDeclarationList(declaration.parent) &&
        ts.isVariableStatement(declaration.parent.parent) &&
        declaration.parent.parent.parent === build.body
        ? declaration
        : undefined;
}

/** Whether a build local is a GPU object: one a GPU factory created. */
function isGpuObject(
    context: LoweringContext,
    file: ts.SourceFile,
    declaration: ts.VariableDeclaration,
): boolean {
    const initializer = declaration.initializer
        ? context.unwrapExpression(declaration.initializer)
        : undefined;
    return (
        initializer !== undefined &&
        ts.isCallExpression(initializer) &&
        (callsPinned(context, file, initializer, {
            module: "src/resource/uniform-buffer.ts",
            name: "createUniformBuffer",
        }) ||
            callsPinned(context, file, initializer, {
                module: clusteredModule,
                name: "createDataTexture",
            }))
    );
}

/**
 * The locals the refresh closes over that neither the record nor the GPU
 * holds: each becomes a `ClusteredRefreshState` field, typed from its own
 * declaration -- a number, a `new F32(...)` snapshot, the active list, or
 * the last camera.
 */
function refreshState(
    context: LoweringContext,
    file: ts.SourceFile,
    build: ts.FunctionDeclaration,
    refresh: ts.MethodDeclaration,
    shared: ReadonlyMap<string, PinnedBinding>,
): Map<string, StateField> {
    const active = activeLightShape(context);
    const captured = new Map<string, ts.VariableDeclaration>();
    const visit = (node: ts.Node): void => {
        if (ts.isIdentifier(node)) {
            const declaration = buildLocal(file, build, node);
            if (declaration) captured.set(node.text, declaration);
        }
        ts.forEachChild(node, visit);
    };
    visit(refresh);
    const fields = new Map<string, StateField>();
    for (const statement of build.body!.statements) {
        const declaration = onlyDeclaration(statement);
        const name =
            declaration && ts.isIdentifier(declaration.name)
                ? declaration.name.text
                : undefined;
        if (
            declaration &&
            name &&
            captured.get(name) === declaration &&
            spotSupportCall(context, declaration)
        ) {
            fields.set(name, {
                name,
                kind: "support",
                cpp: "bool",
                binding: {
                    cpp: SPOT_SUPPORT_PRESENT,
                    type: "opaque",
                    absentCpp: `!${SPOT_SUPPORT_PRESENT}`,
                    optional: {
                        present: SPOT_SUPPORT_PRESENT,
                        members: new Map([
                            [
                                "_stride",
                                {
                                    cpp: context.doubleLiteral(
                                        clusteredSpotStride(context),
                                    ),
                                },
                            ],
                        ]),
                    },
                },
            });
            continue;
        }
        if (
            !declaration ||
            !name ||
            captured.get(name) !== declaration ||
            RECORD_STORAGE.has(name) ||
            shared.has(name) ||
            isGpuObject(context, file, declaration)
        ) {
            continue;
        }
        const cpp = `captured.${name}`;
        const initializer = declaration.initializer
            ? context.unwrapExpression(declaration.initializer)
            : undefined;
        const annotation = declaration.type;
        if (!initializer) {
            const camera =
                annotation &&
                ts.isUnionTypeNode(annotation) &&
                annotation.types.some(
                    (type) =>
                        ts.isTypeReferenceNode(type) &&
                        ts.isIdentifier(type.typeName) &&
                        type.typeName.text === "Camera",
                );
            if (!camera) {
                context.contractError(
                    declaration,
                    `Expected the refresh's uninitialized capture '${name}' to be the last camera.`,
                );
            }
            fields.set(name, {
                name,
                kind: "camera",
                cpp: "CameraRecord*",
                binding: {
                    cpp,
                    type: "opaque",
                    absentCpp: `${cpp} == nullptr`,
                },
            });
        } else if (
            ts.isNewExpression(initializer) &&
            ts.isIdentifier(initializer.expression) &&
            (PAYLOAD_CONSTRUCTORS.f32 as readonly string[]).includes(
                initializer.expression.text,
            )
        ) {
            fields.set(name, {
                name,
                kind: "f32",
                cpp: "std::vector<float>",
                binding: { cpp, type: "f32", mutable: true },
            });
        } else if (ts.isArrayLiteralExpression(initializer)) {
            const element =
                annotation && ts.isArrayTypeNode(annotation)
                    ? annotation.elementType
                    : undefined;
            if (
                initializer.elements.length !== 0 ||
                !element ||
                !ts.isTypeReferenceNode(element) ||
                !ts.isIdentifier(element.typeName) ||
                element.typeName.text !== "_ClusteredActiveLight"
            ) {
                context.contractError(
                    declaration,
                    `Expected the refresh's list capture '${name}' to be the active lights.`,
                );
            }
            fields.set(name, {
                name,
                kind: "active-lights",
                cpp: `std::vector<upstream::${active.cpp}>`,
                binding: { cpp, type: "record-list", record: active },
            });
        } else {
            fields.set(name, {
                name,
                kind: "number",
                cpp: "double",
                binding: scalar(cpp),
            });
        }
    }
    for (const [name] of captured) {
        if (
            !fields.has(name) &&
            !RECORD_STORAGE.has(name) &&
            !shared.has(name) &&
            !isGpuObject(context, file, captured.get(name)!)
        ) {
            context.contractError(
                captured.get(name)!,
                `Expected the refresh's capture '${name}' to be a top-level local of ${buildSymbol}.`,
            );
        }
    }
    return fields;
}

/** `ClusteredRefreshState`: the captured locals, and the spot snapshot. */
function refreshStateStruct(
    context: LoweringContext,
    fields: ReadonlyMap<string, StateField>,
): string {
    return `// ${context.provenance(clusteredModule, `${buildSymbol}.refresh`, "captured locals")}
/** The locals \`buildClusteredLightGpuState\`'s refresh closes over, one
 *  per container, and the spot support's cone snapshot its
 *  \`_coneChanged\` closes over. */
struct ClusteredRefreshState {
${[...fields.values()]
    .map((field) => `    ${field.cpp} ${field.name}{};`)
    .join("\n")}
    std::vector<float> ${SPOT_SNAPSHOT}{};
};`;
}

/**
 * `createDataTexture`'s own row count for one texture: the `height` it
 * computes before handing the descriptor to the device, lowered over the
 * call's texel count and width.
 */
function dataTextureRows(
    context: LoweringContext,
    call: ts.CallExpression,
    lowerer: PinnedNumericLowerer,
): string {
    const { file, declaration } = context.functionDeclaration(
        clusteredModule,
        "createDataTexture",
    );
    const parameters = clusteredParameterNames(context, declaration);
    if (parameters.length !== call.arguments.length) {
        return context.contractError(
            call,
            "Expected createDataTexture's own arity at its call.",
        );
    }
    const height = context.variableInitializer(declaration, "height");
    const rows = new PinnedNumericLowerer(file, {
        bindings: new Map(
            ["texels", "dataTextureWidth"].map(
                (name): [string, PinnedBinding] => {
                    const index = parameters.indexOf(name);
                    const argument = call.arguments[index];
                    if (index < 0 || !argument) {
                        return context.contractError(
                            declaration,
                            `Expected createDataTexture to take '${name}'.`,
                        );
                    }
                    return [name, scalar(lowerer.expression(argument))];
                },
            ),
        ),
        calls: pinnedNumericMathCalls(),
    });
    return rows.expression(height);
}

/** `writeDataTexture`'s parameters the backend's upload owns. */
const WRITE_PLATFORM_PARAMETERS = ["engine", "texture", "data"] as const;

/** The object literal of one `queue.writeTexture` argument. */
function literalArgument(
    context: LoweringContext,
    call: ts.CallExpression,
    index: number,
): ts.ObjectLiteralExpression {
    const argument = call.arguments[index]
        ? context.unwrapExpression(call.arguments[index])
        : undefined;
    return argument && ts.isObjectLiteralExpression(argument)
        ? argument
        : context.contractError(
              call,
              `Expected writeTexture argument ${index} to be an object literal.`,
          );
}

/**
 * `writeDataTexture`, lowered from its own body into the write record the
 * backend uploads: the `height` and `width` it computes, and the region and
 * row layout its `queue.writeTexture` states, stored where the texture's
 * record is. The engine and the payload are the backend's, which pairs the
 * record with the payload it belongs to.
 */
function dataTextureWriter(context: LoweringContext): string {
    const { file, declaration } = context.functionDeclaration(
        clusteredModule,
        "writeDataTexture",
    );
    const parameters = clusteredParameterNames(context, declaration);
    for (const name of WRITE_PLATFORM_PARAMETERS) {
        if (!parameters.includes(name)) {
            context.contractError(
                declaration,
                `Expected writeDataTexture to take '${name}'.`,
            );
        }
    }
    const numbers = parameters.filter(
        (name) =>
            !(WRITE_PLATFORM_PARAMETERS as readonly string[]).includes(name),
    );
    const body = lowerPinnedBody(file, declaration.body!.statements, {
        bindings: new Map(numbers.map((name) => [name, scalar(name)])),
        calls: pinnedNumericMathCalls(),
        statement: (node, lowerer, indent) => {
            const call = statementCall(context, node);
            if (
                !call ||
                webGpuQueueMethod(context, file, call) !== "writeTexture"
            ) {
                return undefined;
            }
            const destination = literalArgument(context, call, 0);
            const source = call.arguments[1]
                ? context.propertyPath(call.arguments[1])
                : undefined;
            if (
                call.arguments.length !== 4 ||
                destination.properties.length !== 1 ||
                !names(
                    file,
                    context.propertyInitializer(destination, "texture"),
                    declaration.parameters[parameters.indexOf("texture")]!,
                    context,
                ) ||
                source?.join(".") !== "data.buffer"
            ) {
                return context.contractError(
                    call,
                    "Expected writeDataTexture to write its own payload into its own texture.",
                );
            }
            const layout = literalArgument(context, call, 2);
            const size = literalArgument(context, call, 3);
            const store = (
                field: string,
                literal: ts.ObjectLiteralExpression,
                member: string,
            ): string =>
                `${indent}texture.${field} = static_cast<std::uint32_t>(` +
                `${lowerer.expression(context.propertyInitializer(literal, member))});`;
            return [
                `${indent}// queue.writeTexture: the backend uploads this region of the payload.`,
                store("width", size, "width"),
                store("height", size, "height"),
                store("bytes_per_row", layout, "bytesPerRow"),
                store("rows_per_image", layout, "rowsPerImage"),
                `${indent}++texture.version;`,
            ];
        },
    });
    return `// ${context.provenance(clusteredModule, "writeDataTexture")}
inline void write_data_texture(
    ClusteredTextureWrite& texture,
    ${numbers.map((name) => `double ${name}`).join(",\n    ")}) {
${body}
}`;
}

/** `snapshotLight`: one light's culling and shading inputs, recorded. */
function snapshotWriter(context: LoweringContext): string {
    return lowerPinnedFunction(
        context,
        clusteredModule,
        "snapshotLight",
        [
            { pinned: "snapshot", kind: "f32Buffer", cpp: "snapshot" },
            { pinned: "index", kind: "number", cpp: "index" },
            {
                pinned: "light",
                kind: "record",
                cpp: "light",
                annotation: "ClusteredPointLight",
                cppType: "ClusteredLight",
                binding: { cpp: "light", type: "opaque" },
            },
        ],
        {
            cppName: "snapshot_light",
            returns: "double",
            inline: true,
            calls: pinnedNumericMathCalls(),
            arrayCopy: copyToFloats,
            memberBindings: new Map(clusteredLightMembers("light", "light.")),
        },
    );
}

/**
 * `_coneChanged`, lowered from the method `spotSupport._create` builds: the
 * cone test against the support's own snapshot, which it closes over and
 * the build allocates into `ClusteredRefreshState`.
 */
function coneChangedWriter(context: LoweringContext): string {
    const { file, method } = clusteredSpotMethod(context, "_coneChanged");
    const [index, light] = clusteredParameterNames(context, method);
    if (!index || !light || method.parameters.length !== 2) {
        return context.contractError(
            method,
            "Expected _coneChanged to take the light's index and the light.",
        );
    }
    const snapshot = snapshotDeclaration(context);
    const body = lowerPinnedBody(file, method.body.statements, {
        bindings: new Map<string, PinnedBinding>([
            [index, scalar(index)],
            [light, { cpp: light, type: "opaque" }],
            ...clusteredLightMembers(light, `${light}.`),
            [
                snapshot.name.getText(file),
                { cpp: "snapshot", type: "f32", mutable: true },
            ],
        ]),
        calls: pinnedNumericMathCalls(),
        expression: (node) =>
            ts.isIdentifier(node) &&
            node.text === snapshot.name.getText(file) &&
            pinnedDeclaration(file, node) !== snapshot
                ? context.contractError(
                      node,
                      "Expected _coneChanged's snapshot to be _create's own.",
                  )
                : undefined,
        returnValue: (expression, lowerer) =>
            expression
                ? lowerer.expression(expression)
                : context.contractError(
                      method,
                      "Expected _coneChanged to return whether the cone moved.",
                  ),
    });
    return `// ${context.provenance(clusteredSpotModule, "spotSupport._create._coneChanged")}
inline bool clustered_cone_changed(
    std::vector<float>& snapshot,
    double ${index},
    const ClusteredLight& ${light}) {
${body}
}`;
}

/** `_create`'s own `const snapshot = new F32(...)`. */
function snapshotDeclaration(context: LoweringContext): ts.VariableDeclaration {
    const { create, statements } = spotCreate(context);
    const found = statements
        .map(onlyDeclaration)
        .find(
            (declaration) =>
                declaration !== undefined &&
                ts.isIdentifier(declaration.name) &&
                declaration.name.text === "snapshot",
        );
    return (
        found ??
        context.contractError(
            create,
            "Expected spotSupport._create to allocate its cone snapshot.",
        )
    );
}

/**
 * `_collect`, lowered from the method `spotSupport._create` builds: every
 * active spot pushed onto the active list, over the lists the refresh hands
 * it.
 */
function collectWriter(context: LoweringContext): string {
    const { file, method } = clusteredSpotMethod(context, "_collect");
    const [active, lights, view] = clusteredParameterNames(context, method);
    if (!active || !lights || !view || method.parameters.length !== 3) {
        return context.contractError(
            method,
            "Expected _collect to take the active list, the spots and the view.",
        );
    }
    const body = lowerPinnedBody(file, method.body.statements, {
        bindings: new Map<string, PinnedBinding>([
            [
                active,
                {
                    cpp: active,
                    type: "record-list",
                    record: activeLightShape(context),
                },
            ],
            [
                lights,
                {
                    cpp: lights,
                    type: "record-list",
                    record: clusteredLightShape(),
                },
            ],
            [view, { cpp: view, type: "f32" }],
        ]),
        calls: pinnedNumericMathCalls(),
    });
    return `// ${context.provenance(clusteredSpotModule, "spotSupport._create._collect")}
inline void collect_clustered_spots(
    std::vector<ClusteredActiveLight>& ${active},
    const std::vector<ClusteredLight>& ${lights},
    const std::array<float, 16>& ${view}) {
${body}
}`;
}

/**
 * The platform calls both halves make, by what they resolve to: the camera
 * functions the refresh imports, each `writeDataTexture` and the params
 * `queue.writeBuffer`.
 */
function platformCalls(
    context: LoweringContext,
    file: ts.SourceFile,
    bindings: ReadonlyMap<string, PinnedBinding>,
    paramsBuffer: () => ts.VariableDeclaration,
): NonNullable<PinnedNumericScope["expression"]> {
    const writer = context.functionDeclaration(
        clusteredModule,
        "writeDataTexture",
    ).declaration;
    const writerParameters = clusteredParameterNames(context, writer);
    return (node, lowerer) => {
        if (!ts.isCallExpression(node)) return undefined;
        const callee = pinnedCallee(context, file, node);
        const camera =
            callee?.module === cameraModule
                ? CAMERA_SPELLINGS.get(callee.name)
                : undefined;
        if (camera) {
            if (node.arguments.length !== camera.arity) {
                return context.contractError(
                    node,
                    `Expected ${callee!.name}'s own arity at its call.`,
                );
            }
            return camera.spell(
                node.arguments.map((argument) => lowerer.expression(argument)),
            );
        }
        if (
            callee?.module === clusteredModule &&
            callee.name === "writeDataTexture"
        ) {
            if (node.arguments.length !== writerParameters.length) {
                return context.contractError(
                    node,
                    "Expected writeDataTexture's own arity at its call.",
                );
            }
            const argument = (name: string): ts.Expression =>
                node.arguments[writerParameters.indexOf(name)]!;
            const texture = context.unwrapExpression(argument("texture"));
            const storage = ts.isIdentifier(texture)
                ? RECORD_STORAGE.get(texture.text)
                : undefined;
            const data = context.unwrapExpression(argument("data"));
            if (
                storage?.kind !== "rows" ||
                !ts.isIdentifier(texture) ||
                !ts.isIdentifier(data) ||
                data.text !== storage.payload ||
                bindings.get(data.text)?.cpp !==
                    `container.${RECORD_STORAGE.get(storage.payload)!.field}`
            ) {
                return context.contractError(
                    node,
                    "Expected writeDataTexture to write a data texture's own payload.",
                );
            }
            const numbers = writerParameters
                .filter(
                    (name) =>
                        !(
                            WRITE_PLATFORM_PARAMETERS as readonly string[]
                        ).includes(name),
                )
                .map((name) => lowerer.expression(argument(name)));
            return `write_data_texture(container.${storage.write}, ${numbers.join(", ")})`;
        }
        if (webGpuQueueMethod(context, file, node) === "writeBuffer") {
            const [buffer, offset, data] = node.arguments;
            const payload = data ? context.unwrapExpression(data) : undefined;
            if (
                node.arguments.length !== 3 ||
                !names(file, buffer, paramsBuffer(), context) ||
                !offset ||
                context.numericValue(offset, file) !== 0 ||
                !payload ||
                !ts.isIdentifier(payload) ||
                bindings.get(payload.text)?.cpp !== "container.params"
            ) {
                return context.contractError(
                    node,
                    "Expected the params buffer to be written whole from the params block.",
                );
            }
            return "++container.params_write";
        }
        return undefined;
    };
}

/**
 * The build: `buildClusteredLightGpuState` from its first statement to its
 * last, over the record the container is and the refresh state it holds.
 */
function lowerBuild(
    context: LoweringContext,
    fields: ReadonlyMap<string, StateField>,
): string {
    const { file, declaration } = context.functionDeclaration(
        clusteredModule,
        buildSymbol,
    );
    const statements = declaration.body!.statements;
    const shared = sharedScope(context);
    const state = gpuState(context, declaration);
    const bindings = new Map<string, PinnedBinding>([
        ...shared.bindings,
        ...[...fields.values()].map((field): [string, PinnedBinding] => [
            field.name,
            field.binding,
        ]),
        [
            "camera",
            {
                cpp: "sceneCamera",
                type: "opaque",
                absentCpp: "sceneCamera == nullptr",
            },
        ],
        ["camera.nearPlane", scalar("sceneCamera->near_plane")],
        ["camera.farPlane", scalar("sceneCamera->far_plane")],
        [
            "engine.canvas.width",
            scalar("static_cast<double>(engine.options.width)"),
        ],
        [
            "engine.canvas.height",
            scalar("static_cast<double>(engine.options.height)"),
        ],
    ]);
    let paramsBuffer: ts.VariableDeclaration | undefined;
    const stored = new Set<string>();
    const statement: NonNullable<PinnedNumericScope["statement"]> = (
        node,
        lowerer,
        indent,
    ) => {
        const local = onlyDeclaration(node);
        const name = declaredName(node);
        const initializer = local?.initializer
            ? context.unwrapExpression(local.initializer)
            : undefined;
        const storage = name ? RECORD_STORAGE.get(name) : undefined;
        if (name && storage) {
            stored.add(name);
            if (!initializer) {
                return context.contractError(
                    node,
                    `Expected '${name}' to be initialized.`,
                );
            }
            const target = `container.${storage.field}`;
            if (storage.kind === "count") {
                const value = lowerer.expression(initializer);
                bindings.set(name, scalar(`static_cast<double>(${target})`));
                return [
                    `${indent}${target} = static_cast<std::uint32_t>(${value});`,
                ];
            }
            if (storage.kind === "rows") {
                if (
                    !ts.isCallExpression(initializer) ||
                    !callsPinned(context, file, initializer, {
                        module: clusteredModule,
                        name: "createDataTexture",
                    })
                ) {
                    return context.contractError(
                        initializer,
                        `Expected '${name}' to be a createDataTexture texture.`,
                    );
                }
                return [
                    `${indent}${target} = static_cast<std::uint32_t>(` +
                        `${dataTextureRows(context, initializer, lowerer)});`,
                ];
            }
            const constructors: readonly string[] =
                PAYLOAD_CONSTRUCTORS[storage.kind];
            const count = ts.isNewExpression(initializer)
                ? initializer.arguments?.[0]
                : undefined;
            if (
                !ts.isNewExpression(initializer) ||
                !ts.isIdentifier(initializer.expression) ||
                !constructors.includes(initializer.expression.text) ||
                initializer.arguments?.length !== 1 ||
                !count
            ) {
                return context.contractError(
                    initializer,
                    `Expected '${name}' to allocate a ${storage.kind} payload.`,
                );
            }
            const size = lowerer.expression(count);
            bindings.set(name, {
                cpp: target,
                type: storage.kind,
                mutable: true,
            });
            return [
                `${indent}${target}.assign(static_cast<std::size_t>(${size}), ` +
                    `${storage.kind === "f32" ? "0.0f" : "0u"});`,
            ];
        }
        const field = name ? fields.get(name) : undefined;
        if (field?.kind === "support") {
            return spotSupportCreation(context, node, lowerer, indent);
        }
        if (field) {
            const target = field.binding.cpp;
            if (field.kind === "number") {
                return [
                    `${indent}${target} = ${lowerer.expression(initializer!)};`,
                ];
            }
            if (field.kind === "f32") {
                const count =
                    initializer && ts.isNewExpression(initializer)
                        ? initializer.arguments?.[0]
                        : undefined;
                if (!count) {
                    return context.contractError(
                        node,
                        `Expected '${field.name}' to allocate by count.`,
                    );
                }
                return [
                    `${indent}${target}.assign(static_cast<std::size_t>(${lowerer.expression(count)}), 0.0f);`,
                ];
            }
            return [
                `${indent}${field.kind === "camera" ? `${target} = nullptr` : `${target}.clear()`};`,
            ];
        }
        if (local && initializer && isGpuObject(context, file, local)) {
            // `createUniformBuffer` writes the block it is handed: the
            // params block's first write.
            const data = ts.isCallExpression(initializer)
                ? initializer.arguments[1]
                : undefined;
            const payload = data ? context.unwrapExpression(data) : undefined;
            if (
                !payload ||
                !ts.isIdentifier(payload) ||
                bindings.get(payload.text)?.cpp !== "container.params"
            ) {
                return context.contractError(
                    initializer,
                    "Expected the only other GPU object to be the params buffer over the params block.",
                );
            }
            paramsBuffer = local;
            return [`${indent}++container.params_write;`];
        }
        if (local === state.declaration) return [];
        if (
            ts.isReturnStatement(node) &&
            names(file, node.expression, state.declaration, context)
        ) {
            return [];
        }
        const call = statementCall(context, node);
        const callee =
            call && ts.isPropertyAccessExpression(call.expression)
                ? call.expression
                : undefined;
        if (
            call &&
            callee &&
            callee.name.text === "refresh" &&
            names(file, callee.expression, state.declaration, context)
        ) {
            // The pin's first refresh, over the build's own camera and
            // canvas extent.
            return [
                `${indent}refresh_clustered_lights(container, ${call.arguments
                    .map((argument) => lowerer.expression(argument))
                    .join(", ")});`,
            ];
        }
        if (
            call &&
            callee &&
            callee.name.text === "_markState" &&
            names(file, call.arguments[0], state.declaration, context)
        ) {
            markStateIsTheSpotFlag(context);
            return [];
        }
        return undefined;
    };
    const body = lowerPinnedBody(file, statements, {
        bindings,
        calls: shared.calls,
        methods: shared.methods,
        expression: platformCalls(
            context,
            file,
            bindings,
            () =>
                paramsBuffer ??
                context.contractError(
                    declaration,
                    "Expected the params buffer before its first write.",
                ),
        ),
        statement,
    });
    for (const name of RECORD_STORAGE.keys()) {
        if (!stored.has(name)) {
            context.contractError(
                declaration,
                `Expected ${buildSymbol} to declare '${name}'.`,
            );
        }
    }
    return body;
}

/**
 * `_markState(state)` sets the GPU state's `_hasSpots`, which only the spot
 * extension's `detect` reads -- a composition input generation decided from
 * the same spot factory. Checked rather than assumed, since a mark that did
 * more would be dropped with it.
 */
function markStateIsTheSpotFlag(context: LoweringContext): void {
    const { method } = clusteredSpotMethod(context, "_markState");
    const [statement, ...rest] = method.body.statements;
    const [parameter] = clusteredParameterNames(context, method);
    const assignment =
        statement && ts.isExpressionStatement(statement)
            ? context.unwrapExpression(statement.expression)
            : undefined;
    if (
        rest.length !== 0 ||
        !assignment ||
        !ts.isBinaryExpression(assignment) ||
        assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
        context.propertyPath(assignment.left)?.join(".") !==
            `${parameter}._hasSpots`
    ) {
        context.contractError(
            method,
            "Expected _markState to set only the GPU state's spot flag.",
        );
    }
}

/**
 * `const spotSupport = container._spotSupport?._create(count)`: the spot
 * support's own allocation, lowered from `_create` up to the object it
 * returns and run where the pin's `?.` finds the support installed. Its
 * snapshot lands in the refresh state its `_coneChanged` reads; the
 * returned object's methods are lowered as functions of their own.
 */
function spotSupportCreation(
    context: LoweringContext,
    node: ts.Statement,
    lowerer: PinnedNumericLowerer,
    indent: string,
): string[] {
    const local = onlyDeclaration(node);
    const call = local ? spotSupportCall(context, local) : undefined;
    if (!call) {
        return context.contractError(
            node,
            "Expected spotSupport to be container._spotSupport?._create(count).",
        );
    }
    const { file, create, statements } = spotCreate(context);
    const [count] = clusteredParameterNames(context, create);
    const support = statements.findIndex(
        (statement) => declaredName(statement) === "support",
    );
    const supportDeclaration = statements[support]
        ? onlyDeclaration(statements[support])
        : undefined;
    const object = supportDeclaration?.initializer
        ? context.unwrapExpression(supportDeclaration.initializer)
        : undefined;
    const returned = statements[support + 1];
    if (
        !count ||
        create.parameters.length !== 1 ||
        !supportDeclaration ||
        !object ||
        !ts.isObjectLiteralExpression(object) ||
        statements.length !== support + 2 ||
        !returned ||
        !ts.isReturnStatement(returned) ||
        !names(file, returned.expression, supportDeclaration, context)
    ) {
        return context.contractError(
            create,
            "Expected spotSupport._create to allocate, then return its support object.",
        );
    }
    const lowered: readonly string[] = [
        "_stride",
        "_coneChanged",
        "_collect",
        "_write",
        "_markState",
    ];
    for (const property of object.properties) {
        const name = property.name
            ? context.propertyName(property.name)
            : undefined;
        if (!name || !lowered.includes(name)) {
            context.contractError(
                property,
                "The spot support carries a member this port does not lower.",
            );
        }
    }
    const snapshot = snapshotDeclaration(context);
    const bindings = new Map<string, PinnedBinding>([
        [count, scalar(lowerer.expression(call.arguments[0]!))],
    ]);
    const body = lowerPinnedBody(
        file,
        statements.slice(0, support),
        {
            bindings,
            calls: pinnedNumericMathCalls(),
            methods: sharedScope(context).methods,
            statement: (inner, nested, innerIndent) => {
                if (onlyDeclaration(inner) !== snapshot) return undefined;
                const allocation = snapshot.initializer
                    ? context.unwrapExpression(snapshot.initializer)
                    : undefined;
                const size =
                    allocation &&
                    ts.isNewExpression(allocation) &&
                    ts.isIdentifier(allocation.expression) &&
                    (PAYLOAD_CONSTRUCTORS.f32 as readonly string[]).includes(
                        allocation.expression.text,
                    )
                        ? allocation.arguments?.[0]
                        : undefined;
                if (!size) {
                    return context.contractError(
                        inner,
                        "Expected the spot snapshot to be a float allocation.",
                    );
                }
                const target = `captured.${SPOT_SNAPSHOT}`;
                bindings.set("snapshot", {
                    cpp: target,
                    type: "f32",
                    mutable: true,
                });
                return [
                    `${innerIndent}${target}.assign(static_cast<std::size_t>(${nested.expression(size)}), 0.0f);`,
                ];
            },
        },
        `${indent}    `,
    );
    return [
        `${indent}// container._spotSupport?._create(${call.arguments[0]!.getText()})`,
        `${indent}if (container.has_spots) {`,
        body,
        `${indent}    ${SPOT_SUPPORT_PRESENT} = true;`,
        `${indent}}`,
    ];
}

/**
 * The per-frame half: the `refresh` closure from its first statement to its
 * last, over the record, the refresh state and the frame's own camera and
 * target.
 */
function lowerRefresh(
    context: LoweringContext,
    fields: ReadonlyMap<string, StateField>,
): { parameters: readonly string[]; body: string } {
    const { file, declaration } = context.functionDeclaration(
        clusteredModule,
        buildSymbol,
    );
    const { refresh } = gpuState(context, declaration);
    const parameters = clusteredParameterNames(context, refresh);
    const [camera, width, height] = parameters;
    if (!camera || !width || !height || parameters.length !== 3) {
        return context.contractError(
            refresh,
            "Expected refresh to take the camera and the target extent.",
        );
    }
    const shared = sharedScope(context);
    const paramsBuffer = declaration
        .body!.statements.map(onlyDeclaration)
        .find(
            (local): local is ts.VariableDeclaration =>
                local !== undefined &&
                isGpuObject(context, file, local) &&
                !RECORD_STORAGE.has(local.name.getText(file)),
        );
    const bindings = new Map<string, PinnedBinding>([
        ...shared.bindings,
        ...recordBindings(),
        ...[...fields.values()].map((field): [string, PinnedBinding] => [
            field.name,
            field.binding,
        ]),
        [
            camera,
            { cpp: camera, type: "opaque", absentCpp: `${camera} == nullptr` },
        ],
        [`${camera}.nearPlane`, scalar(`${camera}->near_plane`)],
        [`${camera}.farPlane`, scalar(`${camera}->far_plane`)],
        [width, scalar(width)],
        [height, scalar(height)],
    ]);
    const body = lowerPinnedBody(file, refresh.body.statements, {
        bindings,
        calls: shared.calls,
        methods: shared.methods,
        callShapes: new Map([["spotSupport._coneChanged", "bool" as const]]),
        matrixCalls: new Set(["getViewMatrix", "getProjectionMatrix"]),
        arrayCopy: copyToFloats,
        booleanAnd: true,
        booleanOr: true,
        expression: platformCalls(
            context,
            file,
            bindings,
            () =>
                paramsBuffer ??
                context.contractError(
                    declaration,
                    `Expected ${buildSymbol} to create the params buffer.`,
                ),
        ),
    });
    return { parameters, body };
}

/** The clustered light field's generated header and translation unit. */
export function lowerClusteredLights(context: LoweringContext): LoweredSource {
    const { file, declaration } = context.functionDeclaration(
        clusteredModule,
        buildSymbol,
    );
    const fields = refreshState(
        context,
        file,
        declaration,
        gpuState(context, declaration).refresh,
        sharedScope(context).bindings,
    );
    const refresh = lowerRefresh(context, fields);
    const [camera, width, height] = refresh.parameters;
    const refreshSignature = `void refresh_clustered_lights(
    ClusteredLightContainer& container,
    CameraRecord* ${camera},
    double ${width},
    double ${height})`;
    const header = `#pragma once

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <memory>
#include <numbers>
#include <vector>

#include "bblite/js_data.hpp"
#include "bblite/runtime.hpp"

namespace bbl::upstream {

${clusteredScalarHelpers(context)}

${clusteredConeWriter(context)}

${clusteredProjectedBounds(context)}

${clusteredAddLightToClusters(context)}

${activeLightStruct(context)}

/** A store through the pin's \`F32\` view of the params \`ArrayBuffer\`: the
 *  lane holds that float's bytes. */
inline void store_clustered_f32_lane(
    std::array<std::uint32_t, 8>& params,
    double index,
    double value) {
    const float lane = static_cast<float>(value);
    std::memcpy(&params[static_cast<std::size_t>(index)], &lane, sizeof lane);
}

}  // namespace bbl::upstream

namespace bbl {

${refreshStateStruct(context, fields)}

}  // namespace bbl

namespace bbl::upstream {

/** \`buildClusteredLightGpuState\`, once when the container is added: the
 *  record takes the extents, the zeroed payloads and the seeded params the
 *  backend creates its GPU objects from, and the first refresh runs. */
void size_clustered_light_state(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainer& container);

/** The pin's \`refresh\`: its dirty key over the camera, the target and the
 *  lights, then the re-bin and payload writes the key found due. */
${refreshSignature};

/** The container a handle names, for the backend that binds it. Const
 *  because a backend resolving a uniform block holds the engine that way,
 *  and mutable because the frame's re-bin writes through it. */
const ClusteredLightContainer* clustered_container(
    const Engine& engine,
    ClusteredLightContainerHandle handle);
ClusteredLightContainer* clustered_container(
    Engine& engine,
    ClusteredLightContainerHandle handle);

}  // namespace bbl::upstream

namespace bbl {

// The scene surface, at the pin's own four entry points.
ClusteredLightContainerHandle create_clustered_light_container(
    Engine& engine,
    double horizontal_tiles,
    double vertical_tiles,
    double z_slices);

void create_clustered_point_light(
    Engine& engine,
    ClusteredLightContainerHandle container,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity);

void create_clustered_spot_light(
    Engine& engine,
    ClusteredLightContainerHandle container,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity,
    const Vec3d& direction,
    double angle);

void add_clustered_light_container(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainerHandle container);

}  // namespace bbl
`;
    const source = `// ${context.provenance(clusteredModule, buildSymbol)}
#include "bblite/upstream/clustered_light.hpp"

#include <limits>
#include <memory>
#include <stdexcept>

#include "bblite/upstream/renderer_plan.hpp"

${cameraChangeKeyHeader(context)}
namespace bbl::upstream {

${snapshotWriter(context)}

${coneChangedWriter(context)}

${collectWriter(context)}

${dataTextureWriter(context)}

void size_clustered_light_state(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainer& container) {
    CameraRecord* const sceneCamera =
        scene.camera.value < engine.cameras.size()
            ? &${recordAt("engine.cameras", "scene.camera")}
            : nullptr;
    container.refresh = std::make_shared<ClusteredRefreshState>();
    ClusteredRefreshState& captured = *container.refresh;
${lowerBuild(context, fields)}
}

${refreshSignature} {
    ClusteredRefreshState& captured = *container.refresh;
${refresh.body}
}

const ClusteredLightContainer* clustered_container(
    const Engine& engine,
    ClusteredLightContainerHandle handle) {
    return handle.value < engine.clustered_light_containers.size()
        ? &${recordAt("engine.clustered_light_containers", "handle")}
        : nullptr;
}

ClusteredLightContainer* clustered_container(
    Engine& engine,
    ClusteredLightContainerHandle handle) {
    return const_cast<ClusteredLightContainer*>(clustered_container(
        static_cast<const Engine&>(engine), handle));
}

}  // namespace bbl::upstream

namespace bbl {

ClusteredLightContainerHandle create_clustered_light_container(
    Engine& engine,
    double horizontal_tiles,
    double vertical_tiles,
    double z_slices) {
    auto& containers = engine.clustered_light_containers;
    containers.push_back(ClusteredLightContainer{});
    auto& container = containers.back();
    container.horizontal_tiles = horizontal_tiles;
    container.vertical_tiles = vertical_tiles;
    container.z_slices = z_slices;
    return ClusteredLightContainerHandle{
        static_cast<std::uint32_t>(containers.size() - 1)};
}

void create_clustered_point_light(
    Engine& engine,
    ClusteredLightContainerHandle handle,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity) {
    auto* container = upstream::clustered_container(engine, handle);
    if (!container) return;
    container->point_lights.push_back(ClusteredLight{
        {position.x, position.y, position.z},
        {diffuse.x, diffuse.y, diffuse.z},
        range,
        intensity,
        {},
        0.0});
    container->version++;
}

void create_clustered_spot_light(
    Engine& engine,
    ClusteredLightContainerHandle handle,
    const Vec3d& position,
    const Vec3d& diffuse,
    double range,
    double intensity,
    const Vec3d& direction,
    double angle) {
    auto* container = upstream::clustered_container(engine, handle);
    if (!container) return;
    // _enableClusteredSpotSupport installs the support first.
    container->has_spots = true;
    container->spot_lights.push_back(ClusteredLight{
        {position.x, position.y, position.z},
        {diffuse.x, diffuse.y, diffuse.z},
        range,
        intensity,
        {direction.x, direction.y, direction.z},
        angle});
    container->version++;
}

void add_clustered_light_container(
    Engine& engine,
    Scene& scene,
    ClusteredLightContainerHandle handle) {
    auto* container = upstream::clustered_container(engine, handle);
    if (!container) {
        throw std::runtime_error(
            "addClusteredLightContainer: unknown container.");
    }
    // The pin installs the scene's updater only once the build returned,
    // so a build that throws leaves the scene without one.
    upstream::size_clustered_light_state(engine, scene, *container);
    scene.clustered_lights = handle;
}

}  // namespace bbl
`;
    return {
        header,
        source,
        modulePath: clusteredModule,
        symbolName: buildSymbol,
    };
}
