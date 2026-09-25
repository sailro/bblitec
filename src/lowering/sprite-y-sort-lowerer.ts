import type { PinnedCallSpelling } from "./pinned-numeric-lowerer.js";
/**
 * `sprite-2d-y-sort.ts`, translated from its own bodies.
 *
 * The optional stable GPU-order permutation for a pure-2D layer: the draw
 * key, the persistent insertion serials, the storage that follows the
 * layer's capacity, the bottom-up stable merge with its ping-pong buffers,
 * the dirty-range bookkeeping and the packed staging copy. Every one of
 * those is the pinned function lowered through the numeric translator.
 *
 * What this module supplies is the platform around them, each boundary
 * named by the statement it replaces:
 *
 *  - The state record. `Sprite2DYSortState` becomes a generated struct with
 *    one member per pinned member, held by the layer as an opaque pointer
 *    (`layer.y_sort`), because the pin keeps the layout private to this
 *    optional module. `layer` and `enabled` are not members: the layer owns
 *    the state, and `enabled` is the layer holding it.
 *  - The hook. Upstream's module registers one hook object; natively the
 *    mutation paths call the four observers directly (they compile only
 *    where the enabler is reached), and the engine's hook carries the two
 *    entries the always-loaded upload and pick paths reach.
 *  - The upload. `device.queue.writeBuffer` becomes the staged transfer the
 *    backend performs, the layer's shared dirty range is consumed through
 *    the native helper both backends use, and `uploadedVersion` is the
 *    backend buffer's own stamp, `-1` for a buffer holding none of the
 *    current rows.
 */
import ts from "typescript";
import { PinnedRecordModel, type MemberSpec } from "./pinned-record-lowerer.js";
import type { LoweringContext } from "./context.js";
import {
    lowerPinnedFunction,
    lowerPinnedFunctionParts,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import type {
    PinnedBinding,
    PinnedNumericLowerer,
    PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";

import { recordAt } from "../compiler/record-access.js";

export const ySortModule = "src/sprite/sprite-2d-y-sort.ts";
export const ySortHandleModule = "src/sprite/sprite-2d-handle-y-sort.ts";

/** The state's own members this port keeps elsewhere; see the module doc. */
const STATE_MEMBERS_KEPT_ELSEWHERE = new Set(["layer", "enabled"]);

/** A pinned state member by its storage. */
interface StateMember {
    name: string;
    storage: "u32" | "f64-buffer" | "f32" | "scalar" | "bool";
}

const TYPED_ARRAY_STORAGE: ReadonlyMap<
    string,
    { storage: StateMember["storage"]; cpp: string }
> = new Map([
    ["Uint32Array", { storage: "u32", cpp: "std::vector<std::uint32_t>" }],
    ["Float64Array", { storage: "f64-buffer", cpp: "std::vector<double>" }],
    ["Float32Array", { storage: "f32", cpp: "std::vector<float>" }],
]);

/** Each pinned function this module lowers, by its native name. */
const Y_SORT_FUNCTIONS: ReadonlyMap<string, string> = new Map([
    ["allocateSerial", "y_sort_allocate_serial"],
    ["keyAt", "y_sort_key_at"],
    ["ensureStorage", "y_sort_ensure_storage"],
    ["syncCount", "y_sort_sync_count"],
    ["comesBefore", "y_sort_comes_before"],
    ["ensureSorted", "y_sort_ensure_sorted"],
    ["markPackedDirty", "y_sort_mark_packed_dirty"],
    ["observeDirty", "observe_y_sort_dirty"],
    ["observeAdd", "observe_y_sort_add"],
    ["observeRemove", "observe_y_sort_remove"],
    ["observeClear", "observe_y_sort_clear"],
    ["packRange", "y_sort_pack_range"],
    ["uploadSorted", "y_sort_upload"],
    ["getDrawOrder", "y_sort_draw_order"],
    ["setSprite2DYSortBias", "y_sort_set_bias"],
]);

function nativeName(pinned: string): string {
    const name = Y_SORT_FUNCTIONS.get(pinned);
    if (!name) throw new Error(`No native Y-sort function for '${pinned}'.`);
    return name;
}

/** `Sprite2DYSortState`'s members, by the storage each one's type names. */
function stateMembers(context: LoweringContext): readonly StateMember[] {
    const { declaration: declared } = context.interfaceDeclaration(
        ySortModule,
        "Sprite2DYSortState",
    );
    return declared.members.flatMap((member): StateMember[] => {
        const name =
            ts.isPropertySignature(member) && context.propertyName(member.name);
        if (!ts.isPropertySignature(member) || !member.type || !name) {
            return context.contractError(
                member,
                "Expected a typed, named Sprite2DYSortState member.",
            );
        }
        if (STATE_MEMBERS_KEPT_ELSEWHERE.has(name)) return [];
        const type = member.type;
        const typed =
            ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)
                ? TYPED_ARRAY_STORAGE.get(type.typeName.text)
                : undefined;
        if (typed) return [{ name, storage: typed.storage }];
        if (type.kind === ts.SyntaxKind.NumberKeyword) {
            return [{ name, storage: "scalar" }];
        }
        if (type.kind === ts.SyntaxKind.BooleanKeyword) {
            return [{ name, storage: "bool" }];
        }
        return context.contractError(
            member,
            `Expected Sprite2DYSortState.${name} to be a typed array, a ` +
                "number or a boolean.",
        );
    });
}

/** The generated state struct: one member per pinned member. */
function stateStruct(
    context: LoweringContext,
    members: readonly StateMember[],
): string {
    const fields = new Map<string, MemberSpec>(
        members.map(({ name, storage }) => {
            const typed = [...TYPED_ARRAY_STORAGE.values()].find(
                (entry) => entry.storage === storage,
            );
            return [
                name,
                {
                    field: name,
                    shape: typed
                        ? { kind: "native", cpp: typed.cpp }
                        : { kind: storage === "bool" ? "boolean" : "number" },
                },
            ];
        }),
    );
    const model = new PinnedRecordModel(
        context,
        context.program.modules([ySortModule]),
        {
            records: [
                {
                    pinned: ["Sprite2DYSortState"],
                    cpp: "YSortState",
                    reference: false,
                    members: fields,
                    omit: new Map(
                        [...STATE_MEMBERS_KEPT_ELSEWHERE].map((name) => [
                            name,
                            "The owning layer carries this state.",
                        ]),
                    ),
                },
            ],
            values: new Map(),
            adapters: new Map(),
        },
    );
    return `${model.structs(["Sprite2DYSortState"])}

YSortState* y_sort_state(const Sprite2DLayerRecord& layer) {
    return static_cast<YSortState*>(layer.y_sort.get());
}`;
}

/** Each state member's binding, through `receiver` (`state.` or `state->`). */
function stateBindings(
    members: readonly StateMember[],
    pinned: string,
    receiver: string,
): [string, PinnedBinding][] {
    return members.map(({ name, storage }): [string, PinnedBinding] => [
        `${pinned}.${name}`,
        { cpp: `${receiver}${name}`, type: storage },
    ]);
}

/** The layer members the bodies read, over `Sprite2DLayerRecord`. */
function layerBindings(layer: string): [string, PinnedBinding][] {
    const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });
    return [
        ["layer.count", scalar(`static_cast<double>(${layer}.count)`)],
        ["layer._capacity", scalar(`static_cast<double>(${layer}.capacity)`)],
        [
            "layer._instanceFloatsPerSprite",
            scalar(`static_cast<double>(${layer}.instance_floats_per_sprite)`),
        ],
        // The pin keeps both strides in lockstep (`newStride * 4`); the
        // native record keeps the float count and the bytes follow.
        [
            "layer._instanceStrideBytes",
            scalar(
                `static_cast<double>(${layer}.instance_floats_per_sprite * sizeof(float))`,
            ),
        ],
        ["layer._instanceData", { cpp: `${layer}.instance_data`, type: "f32" }],
        ["layer._version", scalar(`static_cast<double>(${layer}.version)`)],
        [
            'layer.depth !== "none"',
            {
                cpp: `${layer}.depth_mode != Sprite2DDepthMode::none`,
                type: "bool",
            },
        ],
    ];
}

/** The calls every body may make: the module's own functions and Math. */
function ySortCalls(): Map<string, (args: readonly string[]) => string> {
    const calls = new Map<string, PinnedCallSpelling>();
    for (const [pinned, native] of Y_SORT_FUNCTIONS) {
        calls.set(pinned, (args) => `${native}(${args.join(", ")})`);
    }
    // sprite-2d.ts markDirty: the canonical range and version bump, whose
    // own last act is `observe_y_sort_dirty` where this module compiles.
    calls.set(
        "_markSprite2DDirty",
        (args) =>
            `touch_sprite_instances(${args[0]}, ` +
            `bbl::js::to_uint32(${args[1]}), bbl::js::to_uint32(${args[2]}))`,
    );
    return calls;
}

/** `fill(value, start, end)` over one of the state's arrays. */
const ySortMethods: NonNullable<PinnedNumericScope["methods"]> = new Map([
    [
        "fill",
        (receiver, args, binding) => {
            const element =
                binding.type === "u32"
                    ? "std::uint32_t"
                    : binding.type === "f32"
                      ? "float"
                      : "double";
            if (args.length !== 3) {
                throw new Error(
                    `Pinned Y-sort fill takes (value, start, end); found ${args.length}.`,
                );
            }
            return `bbl::js::array_fill_range(${receiver}, static_cast<${element}>(${args[0]}), ${args[1]}, ${args[2]})`;
        },
    ],
]);

/** The shape of a call whose result is not a number. */
const Y_SORT_CALL_SHAPES: ReadonlyMap<string, PinnedBinding["type"]> = new Map([
    ["comesBefore", "bool" as const],
]);

/**
 * `const state = getState(layer)` (or `existing`): the layer's state pointer,
 * null when the layer never enabled the extension.
 */
function stateLocal(
    members: readonly StateMember[],
    lowerer: PinnedNumericLowerer,
    statement: ts.Statement,
    file: ts.SourceFile,
    indent: string,
): string[] | undefined {
    if (!ts.isVariableStatement(statement)) return undefined;
    const [entry, ...rest] = statement.declarationList.declarations;
    if (
        !entry ||
        rest.length > 0 ||
        !ts.isIdentifier(entry.name) ||
        !entry.initializer ||
        entry.initializer.getText(file) !== "getState(layer)"
    ) {
        return undefined;
    }
    const name = entry.name.text;
    lowerer.bindLocal(entry.name, {
        cpp: `(*${name})`,
        type: "opaque",
        absentCpp: `${name} == nullptr`,
    });
    lowerer.bindPorts(stateBindings(members, name, `${name}->`), entry);
    return [`${indent}YSortState* const ${name} = y_sort_state(layer);`];
}

/** Parameters shared by several bodies. */
const LAYER: PinnedFunctionParameter = {
    pinned: "layer",
    kind: "record",
    cpp: "layer",
    cppType: "Sprite2DLayerRecord",
    annotation: "Sprite2DLayer",
};
const STATE: PinnedFunctionParameter = {
    pinned: "state",
    kind: "record",
    cpp: "state",
    cppType: "YSortState",
    annotation: "Sprite2DYSortState",
    mutableRecord: true,
};
const number = (pinned: string): PinnedFunctionParameter => ({
    pinned,
    kind: "number",
    cpp: pinned,
});

/** The options each body shares: its bindings, calls and hooks. */
function bodyOptions(
    context: LoweringContext,
    members: readonly StateMember[],
    extra: {
        bindings?: readonly [string, PinnedBinding][];
        statement?: (
            statement: ts.Statement,
            lowerer: PinnedNumericLowerer,
            indent: string,
        ) => readonly string[] | undefined;
    } = {},
) {
    const file = context.sourceFile(ySortModule);
    const memberBindings = new Map<string, PinnedBinding>([
        ...layerBindings("layer"),
        ...stateBindings(members, "state", "state."),
        ...(extra.bindings ?? []),
    ]);
    return {
        memberBindings,
        calls: ySortCalls(),
        methods: ySortMethods,
        callShapes: Y_SORT_CALL_SHAPES,

        statement: (
            statement: ts.Statement,
            lowerer: PinnedNumericLowerer,
            indent: string,
        ): readonly string[] | undefined =>
            stateLocal(members, lowerer, statement, file, indent) ??
            extra.statement?.(statement, lowerer, indent),
    };
}

/** The file-local half: every body the four observers and the hook reach. */
export function ySortCoreCpp(context: LoweringContext): string {
    const members = stateMembers(context);
    const plain = (
        pinned: string,
        parameters: readonly PinnedFunctionParameter[],
        returns: Parameters<typeof lowerPinnedFunction>[4]["returns"],
    ): string =>
        lowerPinnedFunction(context, ySortModule, pinned, parameters, {
            cppName: nativeName(pinned),
            returns,
            ...bodyOptions(context, members),
        });
    const constState = { ...STATE, mutableRecord: false };
    const drawOrder = context.functionDeclaration(ySortModule, "getDrawOrder");
    return [
        stateStruct(context, members),
        plain("allocateSerial", [STATE], "double"),
        plain("keyAt", [LAYER, constState, number("index")], "double"),
        plain("ensureStorage", [LAYER, STATE], "void"),
        plain("syncCount", [LAYER, STATE], "void"),
        plain("comesBefore", [constState, number("left"), number("right")], {
            type: "bool",
            value: (lowerer, expression) =>
                expression
                    ? lowerer.expression(expression)
                    : context.contractError(
                          context.functionDeclaration(
                              ySortModule,
                              "comesBefore",
                          ).declaration,
                          "Expected pinned comesBefore to return an order.",
                      ),
        }),
        plain("ensureSorted", [LAYER, STATE], "void"),
        plain("markPackedDirty", [STATE, number("drawIndex")], "void"),
        plain("observeDirty", [LAYER, number("lo"), number("hi")], "void"),
        plain("observeAdd", [LAYER, number("index")], "void"),
        plain(
            "observeRemove",
            [LAYER, number("index"), number("last")],
            "void",
        ),
        plain("observeClear", [LAYER, number("previousCount")], "void"),
        plain("packRange", [LAYER, STATE, number("lo"), number("hi")], "void"),
        uploadSortedCpp(context, members),
        plain("getDrawOrder", [LAYER], {
            type: "const std::uint32_t*",
            value: (lowerer, expression) => {
                const returned = expression
                    ? context.unwrapExpression(expression)
                    : undefined;
                if (returned?.kind === ts.SyntaxKind.NullKeyword) {
                    return "nullptr";
                }
                if (
                    returned?.getText(drawOrder.file) === "state._permutation"
                ) {
                    return `${lowerer.expression(returned)}.data()`;
                }
                return context.contractError(
                    returned ?? drawOrder.declaration,
                    "Expected getDrawOrder to return the permutation or null.",
                );
            },
        }),
    ].join("\n\n");
}

/**
 * `uploadSorted`, over the backend's staged transfer.
 *
 * The pin writes the packed rows with `device.queue.writeBuffer`; here the
 * same call's own arguments become the transfer the backend performs, so the
 * offsets and byte count are the pin's. The layer's shared dirty range is
 * consumed through the helper both backends use for it.
 */
function uploadSortedCpp(
    context: LoweringContext,
    members: readonly StateMember[],
): string {
    const { file, declaration } = context.functionDeclaration(
        ySortModule,
        "uploadSorted",
    );
    const packed = "state._packedInstances";
    const statement = (
        node: ts.Statement,
        lowerer: PinnedNumericLowerer,
        indent: string,
    ): readonly string[] | undefined => {
        if (!ts.isExpressionStatement(node)) return undefined;
        const expression = context.unwrapExpression(node.expression);
        if (
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ["layer._dirtyMin", "layer._dirtyMax"].includes(
                expression.left.getText(file),
            )
        ) {
            if (expression.right.getText(file) !== "0") {
                return context.contractError(
                    expression,
                    "Expected uploadSorted to reset the layer's dirty range to zero.",
                );
            }
            // The pair resets the canonical range once; the minimum is
            // where the native reset is issued.
            return expression.left.getText(file) === "layer._dirtyMin"
                ? [`${indent}mark_sprite_dirty_range_consumed(layer);`]
                : [];
        }
        if (
            ts.isCallExpression(expression) &&
            expression.expression.getText(file) === "device.queue.writeBuffer"
        ) {
            const [buffer, offset, source, sourceOffset, size] =
                expression.arguments;
            if (
                expression.arguments.length !== 5 ||
                buffer?.getText(file) !== "instanceBuffer" ||
                !source ||
                !ts.isPropertyAccessExpression(source) ||
                source.getText(file) !== `${packed}.buffer` ||
                !offset ||
                !sourceOffset ||
                !size
            ) {
                return context.contractError(
                    expression,
                    "Expected uploadSorted to write the packed rows into " +
                        "instanceBuffer.",
                );
            }
            const bytes = (value: ts.Expression): string =>
                `static_cast<std::size_t>(${lowerer.expression(value)})`;
            return [
                `${indent}staged = SpriteInstanceUpload{`,
                `${indent}    reinterpret_cast<const std::uint8_t*>(${lowerer.expression(source.expression)}.data()),`,
                `${indent}    ${bytes(sourceOffset)},`,
                `${indent}    ${bytes(offset)},`,
                `${indent}    ${bytes(size)}};`,
            ];
        }
        return undefined;
    };
    const options = bodyOptions(context, members, {
        // The packed array is a vector, whose storage starts at its own
        // first element.
        bindings: [[`${packed}.byteOffset`, { cpp: "0.0", type: "scalar" }]],
        statement,
    });
    const parts = lowerPinnedFunctionParts(
        context,
        ySortModule,
        "uploadSorted",
        [
            {
                pinned: "device",
                kind: "record",
                cpp: "device",
                annotation: "GPUDevice",
                specialized: true,
                binding: { cpp: "device", type: "opaque" },
            },
            { ...LAYER, mutableRecord: true },
            {
                pinned: "instanceBuffer",
                kind: "record",
                cpp: "instanceBuffer",
                annotation: "GPUBuffer",
                specialized: true,
                binding: { cpp: "instanceBuffer", type: "opaque" },
            },
            number("uploadedVersion"),
        ],
        {
            cppName: nativeName("uploadSorted"),
            returns: {
                type: "std::optional<SpriteInstanceUpload>",
                value: (_lowerer, expression) => {
                    const returned = expression
                        ? context.unwrapExpression(expression)
                        : undefined;
                    if (
                        returned &&
                        ts.isIdentifier(returned) &&
                        returned.text === "undefined"
                    ) {
                        return "std::nullopt";
                    }
                    if (
                        returned &&
                        ["uploadedVersion", "layer._version"].includes(
                            returned.getText(file),
                        )
                    ) {
                        return "staged";
                    }
                    return context.contractError(
                        returned ?? declaration,
                        "Expected uploadSorted to return undefined or a version.",
                    );
                },
            },
            ...options,
        },
    );
    return `// ${parts.provenance}
${parts.declaration} {
    SpriteInstanceUpload staged{};
${parts.body}
}`;
}

/**
 * The entry points scene code names: the enabler, and the bias setter with
 * its stable-handle companion. They follow the canonical mutation paths
 * because they call them.
 */
export function ySortEntryPointsCpp(context: LoweringContext): string {
    const members = stateMembers(context);
    const file = context.sourceFile(ySortModule);
    const setBias = lowerPinnedFunction(
        context,
        ySortModule,
        "setSprite2DYSortBias",
        [{ ...LAYER, mutableRecord: true }, number("index"), number("bias")],
        {
            cppName: nativeName("setSprite2DYSortBias"),
            returns: "void",
            ...bodyOptions(context, members),
        },
    );
    const handle = lowerPinnedFunctionParts(
        context,
        ySortHandleModule,
        "setSprite2DYSortHandleBias",
        [
            {
                pinned: "handle",
                kind: "record",
                cpp: "handle",
                annotation: "Sprite2DHandle",
                specialized: true,
                binding: { cpp: "handle", type: "opaque" },
            },
            number("bias"),
        ],
        {
            cppName: "set_sprite_2d_y_sort_bias_id",
            returns: "void",
            leadingParameters: [
                "Engine& engine",
                "Sprite2DLayerHandle layer_handle",
                "std::uint32_t sprite_id",
            ],
            memberBindings: new Map<string, PinnedBinding>([
                [
                    "handle.layer",
                    {
                        cpp: recordAt("engine.sprite_layers", "layer_handle"),
                        type: "opaque",
                    },
                ],
            ]),
            calls: new Map([
                [
                    "setSprite2DYSortBias",
                    (args: readonly string[]) =>
                        `${nativeName("setSprite2DYSortBias")}(${args.join(", ")})`,
                ],
                [
                    "getSprite2DHandleIndex",
                    () =>
                        "sprite_2d_handle_index(engine, layer_handle, sprite_id)",
                ],
            ]),
        },
    );
    return [
        setBias,
        `// ${handle.provenance}\n${handle.declaration} {\n${handle.body}\n}`,
        enableCpp(context, members, file),
    ].join("\n\n");
}

/**
 * `enableSprite2DYSort`. Upstream hands back the state object; what a scene
 * reads off it is a live question about the layer it is attached to, so the
 * layer's handle is what travels, and every read is keyed by it.
 */
function enableCpp(
    context: LoweringContext,
    members: readonly StateMember[],
    file: ts.SourceFile,
): string {
    const hook = context.functionDeclaration(ySortModule, "getHook");
    const entries = hookEntries(context, hook.declaration);
    const created = "state";
    const statement = (
        node: ts.Statement,
        lowerer: PinnedNumericLowerer,
        indent: string,
    ): readonly string[] | undefined => {
        // `const state: Sprite2DYSortState = { ... }`: the record, created
        // where the pin creates it and filled member by member from the
        // pin's own initializers.
        if (ts.isVariableStatement(node)) {
            const [entry] = node.declarationList.declarations;
            const literal = entry?.initializer
                ? context.unwrapExpression(entry.initializer)
                : undefined;
            if (
                !entry ||
                !ts.isIdentifier(entry.name) ||
                entry.name.text !== created ||
                !literal ||
                !ts.isObjectLiteralExpression(literal)
            ) {
                return undefined;
            }
            const stores: string[] = [];
            const named = new Set(members.map((member) => member.name));
            for (const property of literal.properties) {
                const name = property.name
                    ? context.propertyName(property.name)
                    : undefined;
                if (!name) {
                    return context.contractError(
                        property,
                        "Expected a named Sprite2DYSortState initializer.",
                    );
                }
                if (STATE_MEMBERS_KEPT_ELSEWHERE.has(name)) continue;
                if (!named.has(name)) {
                    return context.contractError(
                        property,
                        `Expected '${name}' to be a Sprite2DYSortState member.`,
                    );
                }
                const value = ts.isShorthandPropertyAssignment(property)
                    ? property.name
                    : ts.isPropertyAssignment(property)
                      ? property.initializer
                      : undefined;
                if (!value) {
                    return context.contractError(
                        property,
                        "Expected a plain Sprite2DYSortState initializer.",
                    );
                }
                stores.push(
                    `${indent}${created}->${name} = ${lowerer.expression(value)};`,
                );
            }
            lowerer.bindPorts(
                [
                    [
                        created,
                        {
                            cpp: `(*${created})`,
                            type: "opaque",
                        },
                    ],
                ],
                node,
            );
            lowerer.bindPorts(
                stateBindings(members, created, `${created}->`),
                node,
            );
            return [
                `${indent}const auto ${created}_owner = std::make_shared<YSortState>();`,
                `${indent}YSortState* const ${created} = ${created}_owner.get();`,
                ...stores,
            ];
        }
        if (!ts.isExpressionStatement(node)) return undefined;
        const expression = context.unwrapExpression(node.expression);
        // `layer._ySortState = state`: the layer takes ownership.
        if (
            ts.isBinaryExpression(expression) &&
            expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            expression.left.getText(file) === "layer._ySortState"
        ) {
            if (expression.right.getText(file) !== created) {
                return context.contractError(
                    expression,
                    "Expected enableSprite2DYSort to install the state it created.",
                );
            }
            return [`${indent}layer.y_sort = ${created}_owner;`];
        }
        // `_registerSprite2DYSortHook(getHook())`: the engine's hook takes
        // the two entries the always-loaded paths reach.
        if (
            ts.isCallExpression(expression) &&
            expression.getText(file) === "_registerSprite2DYSortHook(getHook())"
        ) {
            return [
                `${indent}engine.sprite_y_sort_hook.upload = ${nativeName(entries.upload)};`,
                `${indent}engine.sprite_y_sort_hook.draw_order = ${nativeName(entries.drawOrder)};`,
            ];
        }
        return undefined;
    };
    const parts = lowerPinnedFunctionParts(
        context,
        ySortModule,
        "enableSprite2DYSort",
        [
            {
                ...LAYER,
                specialized: true,
                binding: { cpp: "layer", type: "opaque" },
            },
            {
                pinned: "options",
                kind: "record",
                cpp: "options",
                annotation: "Sprite2DYSortOptions",
                specialized: true,
                binding: {
                    cpp: "options",
                    type: "opaque",
                    optional: {
                        present: "default_bias.has_value()",
                        members: new Map([
                            ["defaultBias", { cpp: "*default_bias" }],
                        ]),
                    },
                },
            },
        ],
        {
            cppName: "enable_sprite_2d_y_sort",
            leadingParameters: [
                "Engine& engine",
                "Sprite2DLayerHandle layer_handle",
                "std::optional<double> default_bias",
            ],
            returns: {
                type: "Sprite2DLayerHandle",
                value: (_lowerer, expression) => {
                    const returned = expression?.getText(file);
                    if (returned === created || returned === "existing") {
                        return "layer_handle";
                    }
                    return context.contractError(
                        expression ?? file,
                        "Expected enableSprite2DYSort to return its state.",
                    );
                },
            },
            ...bodyOptions(context, members, { statement }),
        },
    );
    return `// ${parts.provenance}
${parts.declaration} {
    Sprite2DLayerRecord& layer =
        ${recordAt("engine.sprite_layers", "layer_handle")};
${parts.body}
}`;
}

/**
 * `getHook()`'s record, read: which pinned function answers the upload and
 * the draw order, and that the four observers are the ones the canonical
 * mutation paths call.
 */
function hookEntries(
    context: LoweringContext,
    declaration: ts.FunctionDeclaration,
): { upload: string; drawOrder: string } {
    const literal = context.findNodes(
        declaration,
        (node): node is ts.ObjectLiteralExpression =>
            ts.isObjectLiteralExpression(node),
    )[0];
    const entries = new Map<string, string>();
    for (const property of literal?.properties ?? []) {
        const name = property.name
            ? context.propertyName(property.name)
            : undefined;
        if (
            !name ||
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.initializer)
        ) {
            return context.contractError(
                property,
                "Expected the Y-sort hook to name its functions.",
            );
        }
        entries.set(name, property.initializer.text);
    }
    const expected = new Map([
        ["add", "observeAdd"],
        ["remove", "observeRemove"],
        ["clear", "observeClear"],
        ["dirty", "observeDirty"],
    ]);
    const upload = entries.get("upload");
    const drawOrder = entries.get("drawOrder");
    if (
        entries.size !== expected.size + 2 ||
        [...expected].some(([key, value]) => entries.get(key) !== value) ||
        !upload ||
        !drawOrder
    ) {
        return context.contractError(
            declaration,
            "Expected the Y-sort hook's six entries: the four observers the " +
                "mutation paths call, upload and drawOrder.",
        );
    }
    return { upload, drawOrder };
}
