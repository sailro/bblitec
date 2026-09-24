/**
 * `havok-floating-origin.ts`, translated from its own bodies.
 *
 * A floating-origin world simulates far-apart bodies in separate regions,
 * each a solver world with a fixed origin; a body is stored at
 * `worldPosition - origin` and its node keeps true world coordinates. The
 * region lookup and creation, placement, the per-frame re-regioning with its
 * hysteresis and look-ahead, the region step and both sync directions, the
 * reclaim walk and the gravity dispatch are the pinned functions lowered
 * through the numeric translator.
 *
 * What this module supplies is the platform around them, each boundary
 * named by the statement it replaces:
 *
 *  - The solver. Every `hknp.HP_*` call is the PAL call of the same name;
 *    the tuple results the pin indexes (`HP_World_Create()[1]`,
 *    `HP_Body_GetQTransform(...)[1]`) are the PAL's typed results.
 *  - Identity. A region is a heap record held through `std::shared_ptr`, so
 *    the pin's object identity (`next === current`, `Set<WorldRegion>`)
 *    survives the region list growing and `_gcRegions` splicing it.
 *  - The node. A body's node lives in one of two arenas; its pose is read
 *    through `physics_node_pose` and written through the two setters below.
 *  - The module's shape. `createHavokFloatingOriginContext` returns six hook
 *    functions beside the region state because `havok.ts` reaches the module
 *    through a dynamic import; one translation unit links them, so the
 *    record carries the state and the hooks are these functions.
 */
import { posix } from "node:path";
import ts from "typescript";
import type { LoweringContext } from "./context.js";
import {
    lowerPinnedFunctionParts,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import {
    recordLiteralCpp,
    type PinnedBinding,
    type PinnedNumericLowerer,
    type PinnedNumericScope,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

export const havokFloatingOriginModule = "src/physics/havok-floating-origin.ts";
const havokModule = "src/physics/havok.ts";

const scalar = (cpp: string): PinnedBinding => ({ cpp, type: "scalar" });

/** The pinned functions this module lowers, by their native names. */
const FLOATING_ORIGIN_FUNCTIONS: ReadonlyMap<string, string> = new Map([
    ["_findRegion", "find_region"],
    ["_getOrCreateRegion", "get_or_create_region"],
    ["_syncBodyToNode", "fo_sync_body_to_node"],
    ["_syncNodeToBody", "fo_sync_node_to_body"],
    ["_placeBody", "place_body"],
    ["_reRegionBody", "re_region_body"],
    ["_gcRegions", "gc_regions"],
    ["_step", "fo_step_world"],
    ["_setGravity", "fo_set_gravity"],
    [
        "createHavokFloatingOriginContext",
        "create_havok_floating_origin_context",
    ],
]);

function nativeName(pinned: string): string {
    const name = FLOATING_ORIGIN_FUNCTIONS.get(pinned);
    if (!name)
        throw new Error(`No native floating-origin function '${pinned}'.`);
    return name;
}

/**
 * The hooks the context record names, by the pinned function each one is.
 * The first three are reached (`placeBody` from body creation, `step` from
 * the world step, `setGravity` from the public setter); the rest have no
 * admitted caller, so they are named here and lowered nowhere.
 */
const CONTEXT_HOOKS: ReadonlyMap<string, string> = new Map([
    ["placeBody", "_placeBody"],
    ["step", "_step"],
    ["setGravity", "_setGravity"],
    ["getRegionGravity", "_getRegionGravity"],
    ["setVelocityLimits", "_setVelocityLimits"],
    ["dispose", "_dispose"],
]);

/** A pinned record's data members, in declaration order, by their C++ type. */
function recordFields(
    context: LoweringContext,
    interfaceName: string,
    types: ReadonlyMap<string, { annotation: string; cpp: string }>,
): readonly { name: string; cpp: string }[] {
    const file = context.sourceFile(havokFloatingOriginModule);
    const declared = file.statements.find(
        (statement): statement is ts.InterfaceDeclaration =>
            ts.isInterfaceDeclaration(statement) &&
            statement.name.text === interfaceName,
    );
    if (!declared) {
        return context.contractError(
            file,
            `Expected the pinned ${interfaceName} record.`,
        );
    }
    const fields: { name: string; cpp: string }[] = [];
    for (const member of declared.members) {
        const name = member.name
            ? context.propertyName(member.name)
            : undefined;
        if (!name) {
            return context.contractError(
                member,
                `Expected a named ${interfaceName} member.`,
            );
        }
        if (ts.isMethodSignature(member) && CONTEXT_HOOKS.has(name)) continue;
        const type = types.get(name);
        if (
            !ts.isPropertySignature(member) ||
            !type ||
            member.type?.getText(file) !== type.annotation
        ) {
            return context.contractError(
                member,
                `Expected ${interfaceName}.${name} to be one of the members ` +
                    "this port stores.",
            );
        }
        fields.push({ name, cpp: type.cpp });
    }
    return fields;
}

/** `WorldRegion` and `HavokFloatingOriginContext`, as native records. */
export function floatingOriginStructs(context: LoweringContext): string {
    const region = recordFields(
        context,
        "WorldRegion",
        new Map([
            ["_world", { annotation: "any", cpp: "pal::PhysicsWorldHandle" }],
            ["origin", { annotation: "Vec3", cpp: "Vec3d" }],
            // A gravity vector is the PAL's three-lane array.
            [
                "gravity",
                { annotation: "number[]", cpp: "std::array<double, 3>" },
            ],
        ]),
    );
    const floatingOrigin = recordFields(
        context,
        "HavokFloatingOriginContext",
        new Map([
            [
                "regions",
                {
                    annotation: "WorldRegion[]",
                    cpp: "std::vector<std::shared_ptr<PhysicsRegion>>",
                },
            ],
            ["radius", { annotation: "number", cpp: "double" }],
            [
                "gravity",
                { annotation: "number[]", cpp: "std::array<double, 3>" },
            ],
        ]),
    );
    const fields = (list: readonly { name: string; cpp: string }[]): string =>
        list.map(({ name, cpp }) => `    ${cpp} ${name}{};`).join("\n");
    return `// ${context.provenance(havokFloatingOriginModule, "WorldRegion")}
struct PhysicsRegion {
${fields(region)}
};

// ${context.provenance(havokFloatingOriginModule, "HavokFloatingOriginContext", "its state; the hooks are the lowered functions")}
struct PhysicsFloatingOrigin {
${fields(floatingOrigin)}
};
`;
}

/**
 * A region value's binding and its members, through a `shared_ptr`. A
 * member read goes through `physics_region`, which refuses a missing region
 * the way the pin's own read of `undefined.origin` throws.
 */
function regionMembers(pinned: string, cpp: string): [string, PinnedBinding][] {
    const record = `physics_region(${cpp})`;
    return [
        [pinned, { cpp, type: "opaque", absentCpp: `${cpp} == nullptr` }],
        [`${pinned}.origin`, { cpp: `${record}.origin`, type: "vec3" }],
        [`${pinned}._world`, { cpp: `${record}._world`, type: "opaque" }],
        [`${pinned}.gravity`, { cpp: `${record}.gravity`, type: "f64-buffer" }],
    ];
}

/** A body record's members, on the lvalue `cpp`. */
function bodyMembers(pinned: string, cpp: string): [string, PinnedBinding][] {
    return [
        [pinned, { cpp, type: "opaque" }],
        [`${pinned}._hkBody`, { cpp: `${cpp}.handle`, type: "opaque" }],
        [`${pinned}.node`, { cpp: `${cpp}.node`, type: "opaque" }],
        [
            `${pinned}.motionType`,
            scalar(`static_cast<double>(${cpp}.motion_type)`),
        ],
        ...regionMembers(`${pinned}._region`, `${cpp}.region`),
        // `body._region!.origin`: the same member under the pin's assertion.
        ...regionMembers(`${pinned}._region!`, `${cpp}.region`),
    ];
}

/** The world record's members the module reads. */
function worldMembers(): [string, PinnedBinding][] {
    const fo = (pinned: string): [string, PinnedBinding][] => [
        [
            pinned,
            { cpp: "(*world.fo)", type: "opaque", absentCpp: "!world.fo" },
        ],
        [`${pinned}.radius`, scalar("world.fo->radius")],
        [`${pinned}.gravity`, { cpp: "world.fo->gravity", type: "f64-buffer" }],
        [`${pinned}.regions`, { cpp: "world.fo->regions", type: "opaque" }],
        [
            `${pinned}.regions.length`,
            scalar("static_cast<double>(world.fo->regions.size())"),
        ],
    ];
    return [
        ...fo("world._fo"),
        ...fo("world._fo!"),
        // The solver module is the PAL, reached by name.
        ["world._hknp", { cpp: "pal", type: "opaque" }],
        ["world._hkWorld", { cpp: "world.handle", type: "opaque" }],
        ["world._gravity", { cpp: "world.gravity", type: "f64-buffer" }],
        ["world._bodies", { cpp: "world.bodies", type: "opaque" }],
        [
            "world._bodies.length",
            scalar("static_cast<double>(world.bodies.size())"),
        ],
    ];
}

/** `fo` as a parameter (`_findRegion`). */
function contextMembers(): [string, PinnedBinding][] {
    return [
        ["fo.radius", scalar("fo.radius")],
        ["fo.gravity", { cpp: "fo.gravity", type: "f64-buffer" }],
        ["fo.regions", { cpp: "fo.regions", type: "opaque" }],
    ];
}

/** The record lists the bodies index, by their native spelling. */
const RECORD_LISTS: ReadonlyMap<string, "body" | "region"> = new Map([
    ["world.bodies", "body" as const],
    ["world.fo->regions", "region" as const],
    ["fo.regions", "region" as const],
]);

/** The pinned spellings of those lists the bodies index. */
const RECORD_LIST_NAMES: ReadonlySet<string> = new Set([
    "bodies",
    "regions",
    "world._bodies",
]);

/** The PAL call each `hknp.HP_*` the module makes stands for. */
const PAL_CALLS: ReadonlyMap<string, string> = new Map([
    ["HP_World_AddBody", "pal::physics_world_add_body"],
    ["HP_World_RemoveBody", "pal::physics_world_remove_body"],
    ["HP_World_Step", "pal::physics_world_step"],
    ["HP_World_SetGravity", "pal::physics_world_set_gravity"],
    ["HP_World_SetSpeedLimit", "pal::physics_world_set_speed_limit"],
    ["HP_World_Release", "pal::physics_world_release"],
    ["HP_Body_SetLinearVelocity", "pal::physics_body_set_linear_velocity"],
    ["HP_Body_SetAngularVelocity", "pal::physics_body_set_angular_velocity"],
]);

/** The PAL result a tuple-returning `hknp.HP_*` call's declaration binds. */
const PAL_RESULTS: ReadonlyMap<
    string,
    {
        /** How the pin reads the result: whole, or its `[1]` payload. */
        indexed: boolean;
        cpp: (args: readonly string[]) => string;
        type: string;
        members: (name: string) => [string, PinnedBinding][];
    }
> = new Map([
    [
        "HP_World_Create",
        {
            indexed: true,
            cpp: () => "pal::physics_world_create()",
            type: "pal::PhysicsWorldHandle",
            members: (name) => [[name, { cpp: name, type: "opaque" }]],
        },
    ],
    [
        "HP_World_GetSpeedLimit",
        {
            indexed: false,
            cpp: (args) => `pal::physics_world_get_speed_limit(${args[0]})`,
            type: "pal::PhysicsSpeedLimit",
            members: (name) => [
                [`${name}[1]`, scalar(`${name}.max_linear`)],
                [`${name}[2]`, scalar(`${name}.max_angular`)],
            ],
        },
    ],
    [
        "HP_Body_GetQTransform",
        {
            indexed: true,
            cpp: (args) => `pal::physics_body_get_transform(${args[0]})`,
            type: "pal::PhysicsTransform",
            members: (name) => [
                [`${name}[0]`, { cpp: `${name}.position`, type: "f64-buffer" }],
                [`${name}[1]`, { cpp: `${name}.rotation`, type: "f64-buffer" }],
            ],
        },
    ],
    [
        "HP_Body_GetLinearVelocity",
        {
            indexed: true,
            cpp: (args) => `pal::physics_body_get_linear_velocity(${args[0]})`,
            type: "std::array<double, 3>",
            members: (name) => [[name, { cpp: name, type: "f64-buffer" }]],
        },
    ],
    [
        "HP_Body_GetAngularVelocity",
        {
            indexed: true,
            cpp: (args) => `pal::physics_body_get_angular_velocity(${args[0]})`,
            type: "std::array<double, 3>",
            members: (name) => [[name, { cpp: name, type: "f64-buffer" }]],
        },
    ],
]);

/** `hknp.HP_Name(...)`, whatever local holds the solver module. */
function solverCall(
    node: ts.Expression,
    file: ts.SourceFile,
): { name: string; call: ts.CallExpression } | undefined {
    const call = ts.isElementAccessExpression(node) ? node.expression : node;
    if (
        !ts.isCallExpression(call) ||
        !ts.isPropertyAccessExpression(call.expression) ||
        !call.expression.name.text.startsWith("HP_") ||
        !["hknp", "world._hknp"].includes(
            call.expression.expression.getText(file),
        )
    ) {
        return undefined;
    }
    return { name: call.expression.name.text, call };
}

/**
 * The scope every body shares: the record bindings, the solver and the
 * module's own functions as calls, and the statements and expressions the
 * platform answers. `engine` is how the body reaches the engine its nodes
 * live in.
 */
function floatingOriginScope(
    context: LoweringContext,
    engine: string,
    motionTypes: ReadonlyMap<string, number>,
    extra: readonly [string, PinnedBinding][] = [],
): {
    memberBindings: Map<string, PinnedBinding>;
    calls: Map<string, (args: readonly string[]) => string>;
    methods: NonNullable<PinnedNumericScope["methods"]>;
    statement: NonNullable<PinnedNumericScope["statement"]>;
    expression: NonNullable<PinnedNumericScope["expression"]>;
    forOf: NonNullable<PinnedNumericScope["forOf"]>;
    vec3Literal: NonNullable<PinnedNumericScope["vec3Literal"]>;
    recordLiteral: NonNullable<PinnedNumericScope["recordLiteral"]>;
    booleanAnd: true;
    booleanOr: true;
} {
    const file = context.sourceFile(havokFloatingOriginModule);
    const memberBindings = new Map<string, PinnedBinding>([
        ...worldMembers(),
        ...contextMembers(),
        ...bodyMembers("body", "body"),
        // The pin's `as const` motion types, compared as the numbers they
        // are; the native enumerators carry the same values.
        ...[...motionTypes].map(([member, value]): [string, PinnedBinding] => [
            `PhysicsMotionType.${member}`,
            { ...scalar(`${value}.0`), staticNumber: value },
        ]),
        ...extra,
    ]);
    const calls = pinnedNumericMathCalls();
    for (const [pinned, native] of FLOATING_ORIGIN_FUNCTIONS) {
        calls.set(pinned, (args) => `${native}(${args.join(", ")})`);
    }
    // The two syncs take the solver module first; natively they take the
    // engine their node lives in instead.
    for (const pinned of ["_syncBodyToNode", "_syncNodeToBody"]) {
        calls.set(
            pinned,
            (args) => `${nativeName(pinned)}(${engine}, ${args[1]})`,
        );
    }
    for (const [name, pal] of PAL_CALLS) {
        for (const owner of ["hknp", "world._hknp"]) {
            calls.set(
                `${owner}.${name}`,
                (args) => `${pal}(${args.join(", ")})`,
            );
        }
    }
    const listElement = (
        node: ts.Expression,
        lowerer: PinnedNumericLowerer,
    ): { cpp: string; kind: "body" | "region" } | undefined => {
        const access = context.unwrapExpression(node);
        if (
            !ts.isElementAccessExpression(access) ||
            !RECORD_LIST_NAMES.has(access.expression.getText(file))
        ) {
            return undefined;
        }
        const owner = lowerer.expression(access.expression);
        const kind = RECORD_LISTS.get(owner);
        return kind
            ? {
                  cpp: `${owner}[static_cast<std::size_t>(${lowerer.expression(access.argumentExpression)})]`,
                  kind,
              }
            : undefined;
    };
    const expression: NonNullable<PinnedNumericScope["expression"]> = (
        node,
        lowerer,
    ) => {
        if (
            ts.isElementAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            ["bodies", "regions"].includes(node.expression.text)
        ) {
            return listElement(node, lowerer)?.cpp;
        }
        // `regions[i]!._world` and `world._bodies[i]!._region!`: a member
        // of a record read in place.
        if (ts.isPropertyAccessExpression(node)) {
            const element = listElement(node.expression, lowerer);
            if (!element) return undefined;
            const member = node.name.text;
            if (element.kind === "region" && member === "_world") {
                return `${element.cpp}->_world`;
            }
            if (element.kind === "body" && member === "_region") {
                return `${element.cpp}.region`;
            }
            return context.contractError(
                node,
                `Expected a floating-origin body to read '${member}' off ` +
                    "a record it binds.",
            );
        }
        // `used.has(region)`: set membership by identity.
        if (
            ts.isCallExpression(node) &&
            node.expression.getText(file) === "used.has" &&
            node.arguments.length === 1
        ) {
            return `used.contains(${lowerer.expression(node.arguments[0]!)}.get())`;
        }
        return undefined;
    };
    const statement: NonNullable<PinnedNumericScope["statement"]> = (
        node,
        lowerer,
        indent,
    ) =>
        ts.isVariableStatement(node)
            ? declaration(context, file, node, lowerer, indent, engine)
            : ts.isExpressionStatement(node)
              ? expressionStatement(
                    context,
                    file,
                    node,
                    lowerer,
                    indent,
                    engine,
                )
              : undefined;
    return {
        memberBindings,
        calls,
        methods: new Map([
            [
                "push",
                (receiver: string, args: readonly string[]) =>
                    `${receiver}.push_back(${args.join(", ")})`,
            ],
        ]),
        statement,
        expression,
        forOf: (_iterated, element, owner) => {
            return owner && RECORD_LISTS.get(owner.cpp) === "region"
                ? {
                      range: owner.cpp,
                      bindings: new Map(regionMembers(element, element)),
                  }
                : undefined;
        },
        vec3Literal: (x, y, z) => `Vec3d{${x}, ${y}, ${z}}`,
        recordLiteral: recordLiteralCpp,
        booleanAnd: true,
        booleanOr: true,
    };
}

/** A declaration the platform answers, or undefined for an ordinary one. */
function declaration(
    context: LoweringContext,
    file: ts.SourceFile,
    node: ts.VariableStatement,
    lowerer: PinnedNumericLowerer,
    indent: string,
    engine: string,
): readonly string[] | undefined {
    const [entry, ...rest] = node.declarationList.declarations;
    if (!entry || rest.length > 0 || !ts.isIdentifier(entry.name)) {
        return undefined;
    }
    const name = entry.name.text;
    const constant = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
    const qualifier = constant ? "const " : "";
    const initializer = entry.initializer
        ? context.unwrapExpression(entry.initializer)
        : undefined;
    if (!initializer) return undefined;
    const bind = (bindings: readonly [string, PinnedBinding][]): void => {
        for (const [key, binding] of bindings) lowerer.bindLocal(key, binding);
    };
    // A region the module looks up or creates.
    if (
        ts.isCallExpression(initializer) &&
        ["_findRegion", "_getOrCreateRegion"].includes(
            initializer.expression.getText(file),
        )
    ) {
        const value = lowerer.expression(initializer);
        bind(regionMembers(name, name));
        return [
            `${indent}${qualifier}std::shared_ptr<PhysicsRegion> ${name} = ${value};`,
        ];
    }
    // A region the module creates: `{ _world, origin, gravity }`.
    if (ts.isObjectLiteralExpression(initializer)) {
        if (entry.type?.getText(file) !== "WorldRegion") return undefined;
        const value = regionLiteral(context, initializer, lowerer);
        bind(regionMembers(name, name));
        return [`${indent}const auto ${name} = ${value};`];
    }
    // A solver call whose tuple result the pin reads.
    const solver = solverCall(initializer, file);
    const result = solver ? PAL_RESULTS.get(solver.name) : undefined;
    if (solver && result) {
        if (result.indexed !== ts.isElementAccessExpression(initializer)) {
            return context.contractError(
                initializer,
                `Expected ${solver.name}'s result to be read as the PAL returns it.`,
            );
        }
        const args = solver.call.arguments.map((argument) =>
            lowerer.expression(argument),
        );
        bind(result.members(name));
        return [
            `${indent}${qualifier}${result.type} ${name} = ${result.cpp(args)};`,
        ];
    }
    const text = initializer.getText(file);
    // `const node = body.node`: the node's arena reference; its pose is
    // read where the pin reads a member off it.
    if (text.endsWith(".node")) {
        const owner = lowerer.expression(initializer);
        const pose = `physics_node_pose(${engine}, ${owner})`;
        bind([
            [name, { cpp: owner, type: "opaque" }],
            [`${name}.position`, { cpp: `${pose}.position`, type: "vec3" }],
        ]);
        return [];
    }
    // `const p = node.position` / `const q = node.rotationQuaternion`: one
    // pose read, kept for the members the pin reads off it.
    if (ts.isPropertyAccessExpression(initializer)) {
        const owner = context.unwrapExpression(initializer.expression);
        const member = initializer.name.text;
        if (
            ts.isIdentifier(owner) &&
            (member === "position" || member === "rotationQuaternion")
        ) {
            const node = lowerer.expression(owner);
            const pose = `physics_node_pose(${engine}, ${node})`;
            if (member === "position") {
                bind([[name, { cpp: name, type: "vec3" }]]);
                return [`${indent}const Vec3d ${name} = ${pose}.position;`];
            }
            bind(
                ["x", "y", "z", "w"].map((axis): [string, PinnedBinding] => [
                    `${name}.${axis}`,
                    scalar(`static_cast<double>(${name}.${axis})`),
                ]),
            );
            return [`${indent}const Vec4 ${name} = ${pose}.rotation;`];
        }
    }
    // `const b = bodies[i]!` / `const region = regions[i]!`: a record read
    // in place.
    if (
        ts.isElementAccessExpression(initializer) &&
        RECORD_LIST_NAMES.has(initializer.expression.getText(file))
    ) {
        const owner = lowerer.expression(initializer.expression);
        const kind = RECORD_LISTS.get(owner);
        if (!kind) return undefined;
        const element = `${owner}[static_cast<std::size_t>(${lowerer.expression(initializer.argumentExpression)})]`;
        if (kind === "body") {
            bind(bodyMembers(name, name));
            return [`${indent}PhysicsBody& ${name} = ${element};`];
        }
        // Copied, because the reclaim walk erases it from the list.
        bind(regionMembers(name, name));
        return [
            `${indent}const std::shared_ptr<PhysicsRegion> ${name} = ${element};`,
        ];
    }
    // `new Set<WorldRegion>()`: membership by identity.
    if (
        ts.isNewExpression(initializer) &&
        initializer.expression.getText(file) === "Set" &&
        initializer.typeArguments?.[0]?.getText(file) === "WorldRegion" &&
        !initializer.arguments?.length
    ) {
        bind([[name, { cpp: name, type: "opaque" }]]);
        return [`${indent}std::unordered_set<const PhysicsRegion*> ${name};`];
    }
    return undefined;
}

/** An expression statement the platform answers, or undefined. */
function expressionStatement(
    context: LoweringContext,
    file: ts.SourceFile,
    node: ts.ExpressionStatement,
    lowerer: PinnedNumericLowerer,
    indent: string,
    engine: string,
): readonly string[] | undefined {
    const call = context.unwrapExpression(node.expression);
    if (
        !ts.isCallExpression(call) ||
        !ts.isPropertyAccessExpression(call.expression)
    ) {
        return undefined;
    }
    const callee = call.expression;
    const solver = solverCall(call, file);
    // `hknp.HP_Body_SetQTransform(body, [position, rotation])`.
    if (solver?.name === "HP_Body_SetQTransform") {
        const [body, transform] = call.arguments;
        const pair = transform
            ? context.unwrapExpression(transform)
            : undefined;
        if (
            !body ||
            !pair ||
            !ts.isArrayLiteralExpression(pair) ||
            pair.elements.length !== 2
        ) {
            return context.contractError(
                call,
                "Expected HP_Body_SetQTransform to take a [position, rotation] pair.",
            );
        }
        const lanes = (part: ts.Expression, count: number): string => {
            const unwrapped = context.unwrapExpression(part);
            if (!ts.isArrayLiteralExpression(unwrapped)) {
                return lowerer.expression(unwrapped);
            }
            if (unwrapped.elements.length !== count) {
                return context.contractError(
                    unwrapped,
                    `Expected a ${count}-lane transform part.`,
                );
            }
            return `{${unwrapped.elements.map((lane) => lowerer.expression(lane)).join(", ")}}`;
        };
        return [
            `${indent}pal::physics_body_set_transform(${lowerer.expression(body)}, ` +
                `pal::PhysicsTransform{${lanes(pair.elements[0]!, 3)}, ` +
                `${lanes(pair.elements[1]!, 4)}});`,
        ];
    }
    // `node.position.set(...)` / `node.rotationQuaternion.set(...)`: the
    // node's own setters, on whichever arena holds it.
    if (
        callee.name.text === "set" &&
        ts.isPropertyAccessExpression(callee.expression) &&
        ts.isIdentifier(callee.expression.expression)
    ) {
        const member = callee.expression.name.text;
        const node = lowerer.expression(callee.expression.expression);
        const args = call.arguments.map((argument) =>
            lowerer.expression(argument),
        );
        if (member === "position" && args.length === 3) {
            return [
                `${indent}set_physics_node_position(${engine}, ${node}, Vec3d{${args.join(", ")}});`,
            ];
        }
        if (member === "rotationQuaternion" && args.length === 4) {
            return [
                `${indent}set_physics_node_rotation(${engine}, ${node}, ${args.join(", ")});`,
            ];
        }
        return undefined;
    }
    // `used.add(region)`.
    if (callee.getText(file) === "used.add" && call.arguments.length === 1) {
        return [
            `${indent}used.insert(${lowerer.expression(call.arguments[0]!)}.get());`,
        ];
    }
    // `regions.splice(i, 1)`: one region leaves the list.
    if (callee.name.text === "splice") {
        const [start, count] = call.arguments;
        const list = lowerer.expression(callee.expression);
        if (
            !start ||
            !count ||
            call.arguments.length !== 2 ||
            count.getText(file) !== "1" ||
            RECORD_LISTS.get(list) !== "region"
        ) {
            return context.contractError(
                call,
                "Expected the reclaim walk to splice one region out.",
            );
        }
        return [
            `${indent}${list}.erase(${list}.begin() + static_cast<std::ptrdiff_t>(${lowerer.expression(start)}));`,
        ];
    }
    return undefined;
}

/** `{ _world, origin, gravity: [...source] }`, as a new region record. */
function regionLiteral(
    context: LoweringContext,
    literal: ts.ObjectLiteralExpression,
    lowerer: PinnedNumericLowerer,
): string {
    const values = literal.properties.map((property) => {
        const name = property.name
            ? context.propertyName(property.name)
            : undefined;
        if (!name || !ts.isPropertyAssignment(property)) {
            return context.contractError(
                property,
                "Expected a plain WorldRegion initializer.",
            );
        }
        const value = context.unwrapExpression(property.initializer);
        // `[...gravity]`: a copy of the vector, which the record's own
        // array already is.
        if (
            ts.isArrayLiteralExpression(value) &&
            value.elements.length === 1 &&
            ts.isSpreadElement(value.elements[0]!)
        ) {
            return `.${name} = ${lowerer.expression(value.elements[0].expression)}`;
        }
        return `.${name} = ${lowerer.expression(value)}`;
    });
    if (values.length !== 3) {
        context.contractError(literal, "Expected WorldRegion's three members.");
    }
    return `std::make_shared<PhysicsRegion>(PhysicsRegion{${values.join(", ")}})`;
}

const WORLD: PinnedFunctionParameter = {
    pinned: "world",
    kind: "record",
    cpp: "world",
    cppType: "PhysicsWorld",
    annotation: "PhysicsWorld",
    mutableRecord: true,
};
const BODY: PinnedFunctionParameter = {
    pinned: "body",
    kind: "record",
    cpp: "body",
    cppType: "PhysicsBody",
    annotation: "PhysicsBody",
    mutableRecord: true,
};
const SOLVER: PinnedFunctionParameter = {
    pinned: "hknp",
    kind: "record",
    cpp: "hknp",
    annotation: "any",
    specialized: true,
    binding: { cpp: "pal", type: "opaque" },
};
const REGION_RESULT = "std::shared_ptr<PhysicsRegion>";

/** Every lowered function, file-local to the physics translation unit. */
export function floatingOriginFunctionsCpp(
    context: LoweringContext,
    motionTypes: ReadonlyMap<string, number>,
): string {
    const lower = (
        pinned: string,
        parameters: readonly PinnedFunctionParameter[],
        returns: Parameters<typeof lowerPinnedFunctionParts>[4]["returns"],
        engine: string,
        leadingParameters?: readonly string[],
    ): string => {
        const parts = lowerPinnedFunctionParts(
            context,
            havokFloatingOriginModule,
            pinned,
            parameters,
            {
                cppName: nativeName(pinned),
                returns,
                ...(leadingParameters ? { leadingParameters } : {}),
                ...floatingOriginScope(context, engine, motionTypes),
            },
        );
        return `// ${parts.provenance}\n${parts.declaration} {\n${parts.body}\n}`;
    };
    const region = (pinned: string) => ({
        type: REGION_RESULT,
        value: (
            lowerer: PinnedNumericLowerer,
            expression: ts.Expression | undefined,
        ) => {
            const returned = expression
                ? context.unwrapExpression(expression)
                : undefined;
            if (!returned) {
                return context.contractError(
                    context.functionDeclaration(
                        havokFloatingOriginModule,
                        pinned,
                    ).declaration,
                    `Expected ${pinned} to return a region.`,
                );
            }
            return returned.kind === ts.SyntaxKind.NullKeyword
                ? "nullptr"
                : lowerer.expression(returned);
        },
    });
    const vec3 = (pinned: string): PinnedFunctionParameter => ({
        pinned,
        kind: "vec3",
        cpp: pinned,
    });
    return [
        lower(
            "_findRegion",
            [
                {
                    pinned: "fo",
                    kind: "record",
                    cpp: "fo",
                    cppType: "PhysicsFloatingOrigin",
                    annotation: "HavokFloatingOriginContext",
                },
                vec3("pos"),
            ],
            region("_findRegion"),
            "*world.engine",
        ),
        lower(
            "_getOrCreateRegion",
            [WORLD, vec3("pos")],
            region("_getOrCreateRegion"),
            "*world.engine",
        ),
        lower("_syncBodyToNode", [SOLVER, BODY], "void", "engine", [
            "Engine& engine",
        ]),
        lower("_syncNodeToBody", [SOLVER, BODY], "void", "engine", [
            "const Engine& engine",
        ]),
        lower(
            "_placeBody",
            [
                WORLD,
                BODY,
                {
                    pinned: "startsAsleep",
                    kind: "boolean",
                    cpp: "startsAsleep",
                },
            ],
            "void",
            "*world.engine",
        ),
        lower("_reRegionBody", [WORLD, BODY], "void", "*world.engine"),
        lower("_gcRegions", [WORLD], "void", "*world.engine"),
        lower(
            "_step",
            [WORLD, { pinned: "dt", kind: "number", cpp: "dt" }],
            "void",
            "*world.engine",
        ),
        lower(
            "_setGravity",
            [
                WORLD,
                {
                    pinned: "gravity",
                    kind: "record",
                    cpp: "gravity",
                    cppType: "std::array<double, 3>",
                    annotation: "number[]",
                    binding: { cpp: "gravity", type: "f64-buffer" },
                },
                {
                    pinned: "worldPosition",
                    kind: "record",
                    cpp: "worldPosition",
                    cppType: "js::Nullable<Vec3d>",
                    annotation: "Vec3",
                    optional: true,
                    binding: {
                        cpp: "(*worldPosition)",
                        type: "vec3",
                        absentCpp: "!worldPosition.has_value()",
                    },
                },
            ],
            "void",
            "*world.engine",
        ),
        contextFactoryCpp(context, motionTypes),
    ].join("\n\n");
}

/**
 * `createHavokFloatingOriginContext`: region 0 is the world's own solver
 * world centred at the origin, and the context's gravity seeds new regions.
 * The six hooks it names are checked against the functions this module
 * lowers or deliberately leaves unreached.
 */
function contextFactoryCpp(
    context: LoweringContext,
    motionTypes: ReadonlyMap<string, number>,
): string {
    const pinned = "createHavokFloatingOriginContext";
    const { file, declaration } = context.functionDeclaration(
        havokFloatingOriginModule,
        pinned,
    );
    const parts = lowerPinnedFunctionParts(
        context,
        havokFloatingOriginModule,
        pinned,
        [
            {
                pinned: "hkWorld",
                kind: "record",
                cpp: "hkWorld",
                cppType: "pal::PhysicsWorldHandle",
                annotation: "any",
                binding: { cpp: "hkWorld", type: "opaque" },
            },
            {
                pinned: "gravity",
                kind: "record",
                cpp: "gravity",
                cppType: "std::array<double, 3>",
                annotation: "number[]",
                binding: { cpp: "gravity", type: "f64-buffer" },
            },
            { pinned: "radius", kind: "number", cpp: "radius" },
        ],
        {
            cppName: nativeName(pinned),
            returns: {
                type: "PhysicsFloatingOrigin",
                value: (lowerer, expression) => {
                    const literal = expression
                        ? context.unwrapExpression(expression)
                        : undefined;
                    if (!literal || !ts.isObjectLiteralExpression(literal)) {
                        return context.contractError(
                            declaration,
                            `Expected ${pinned} to return the context record.`,
                        );
                    }
                    const fields: string[] = [];
                    for (const property of literal.properties) {
                        const name = property.name
                            ? context.propertyName(property.name)
                            : undefined;
                        const hook = name ? CONTEXT_HOOKS.get(name) : undefined;
                        if (hook) {
                            if (
                                !ts.isPropertyAssignment(property) ||
                                property.initializer.getText(file) !== hook
                            ) {
                                context.contractError(
                                    property,
                                    `Expected the context's ${name} hook to be ${hook}.`,
                                );
                            }
                            continue;
                        }
                        const value =
                            name && ts.isPropertyAssignment(property)
                                ? context.unwrapExpression(property.initializer)
                                : name &&
                                    ts.isShorthandPropertyAssignment(property)
                                  ? property.name
                                  : undefined;
                        if (!name || !value) {
                            return context.contractError(
                                property,
                                "Expected a plain context initializer.",
                            );
                        }
                        if (ts.isArrayLiteralExpression(value)) {
                            const [first] = value.elements;
                            if (
                                first &&
                                value.elements.length === 1 &&
                                ts.isSpreadElement(first)
                            ) {
                                fields.push(
                                    `.${name} = ${lowerer.expression(first.expression)}`,
                                );
                                continue;
                            }
                            const regions = value.elements.map((element) => {
                                const region =
                                    context.unwrapExpression(element);
                                return ts.isObjectLiteralExpression(region)
                                    ? regionLiteral(context, region, lowerer)
                                    : context.contractError(
                                          element,
                                          "Expected the seeded region literal.",
                                      );
                            });
                            fields.push(`.${name} = {${regions.join(", ")}}`);
                            continue;
                        }
                        fields.push(`.${name} = ${lowerer.expression(value)}`);
                    }
                    return `PhysicsFloatingOrigin{${fields.join(", ")}}`;
                },
            },
            ...floatingOriginScope(context, "*world.engine", motionTypes),
        },
    );
    return `// ${parts.provenance}\n${parts.declaration} {\n${parts.body}\n}`;
}

/**
 * `enableHavokFloatingOrigin`, from `havok.ts`: the module import is the
 * one translation unit this port links, and the context is assigned where
 * the pin assigns it.
 */
export function enableFloatingOriginCpp(
    context: LoweringContext,
    motionTypes: ReadonlyMap<string, number>,
): string {
    const pinned = "enableHavokFloatingOrigin";
    const { file } = context.functionDeclaration(havokModule, pinned);
    const scope = floatingOriginScope(context, "*world.engine", motionTypes);
    const parts = lowerPinnedFunctionParts(
        context,
        havokModule,
        pinned,
        [
            {
                pinned: "world",
                kind: "record",
                cpp: "world",
                annotation: "PhysicsWorld",
                specialized: true,
                binding: { cpp: "world", type: "opaque" },
            },
            {
                pinned: "floatingOriginWorldRadius",
                kind: "number",
                cpp: "floating_origin_world_radius",
            },
        ],
        {
            ...scope,
            cppName: "enable_havok_floating_origin",
            returns: "void",
            leadingParameters: ["PhysicsWorldHandle handle"],
            statement: (node, lowerer, indent) => {
                if (ts.isVariableStatement(node)) {
                    const [entry] = node.declarationList.declarations;
                    const initializer = entry?.initializer
                        ? context.unwrapExpression(entry.initializer)
                        : undefined;
                    const imported =
                        initializer &&
                        ts.isAwaitExpression(initializer) &&
                        ts.isCallExpression(initializer.expression) &&
                        initializer.expression.expression.kind ===
                            ts.SyntaxKind.ImportKeyword
                            ? initializer.expression.arguments[0]
                            : undefined;
                    if (
                        entry &&
                        ts.isIdentifier(entry.name) &&
                        imported &&
                        ts.isStringLiteral(imported) &&
                        imported.text.endsWith(".js") &&
                        posix.join(
                            posix.dirname(havokModule),
                            `${imported.text.slice(0, -".js".length)}.ts`,
                        ) === havokFloatingOriginModule
                    ) {
                        return [];
                    }
                    return undefined;
                }
                if (!ts.isExpressionStatement(node)) return undefined;
                const assignment = context.unwrapExpression(node.expression);
                if (
                    ts.isBinaryExpression(assignment) &&
                    assignment.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    assignment.left.getText(file) === "world._fo"
                ) {
                    const call = context.unwrapExpression(assignment.right);
                    if (
                        !ts.isCallExpression(call) ||
                        !ts.isPropertyAccessExpression(call.expression) ||
                        call.expression.name.text !==
                            "createHavokFloatingOriginContext"
                    ) {
                        return context.contractError(
                            assignment,
                            "Expected the context to be the module's factory result.",
                        );
                    }
                    const args = call.arguments.map((argument) =>
                        lowerer.expression(argument),
                    );
                    return [
                        `${indent}world.fo = ${nativeName("createHavokFloatingOriginContext")}(${args.join(", ")});`,
                    ];
                }
                return undefined;
            },
        },
    );
    return `// ${parts.provenance}
${parts.declaration} {
    PhysicsWorld& world = physics_world_record(handle);
${parts.body}
}`;
}

/** The node setters the two sync directions write through. */
export const floatingOriginNodeSettersCpp = `/**
 * A region the pin reads a member off. A body created before the world
 * enabled floating origin names none, and the pin's read of \`undefined\`
 * throws there.
 */
PhysicsRegion& physics_region(const std::shared_ptr<PhysicsRegion>& region) {
    if (!region) {
        throw std::runtime_error(
            "A floating-origin body names no region: it was created before "
            "enableHavokFloatingOrigin.");
    }
    return *region;
}

/**
 * The pin's \`node.position.set(...)\` and \`node.rotationQuaternion.set(...)\`,
 * on whichever arena the body's node lives in. A native record stores its
 * quaternion at float width.
 */
void set_physics_node_position(Engine& engine, PhysicsNodeRef node, Vec3d position) {
    PhysicsNodePose pose = physics_node_pose(engine, node);
    write_node_pose(engine, node, position, pose.rotation);
}

void set_physics_node_rotation(Engine& engine, PhysicsNodeRef node, double x, double y, double z, double w) {
    PhysicsNodePose pose = physics_node_pose(engine, node);
    write_node_pose(engine, node, pose.position,
                    Vec4{static_cast<float>(x), static_cast<float>(y), static_cast<float>(z), static_cast<float>(w)});
}`;

/** Where the header's `PhysicsBody` needs the region record declared. */
export const floatingOriginForwardDeclaration = "struct PhysicsRegion;\n";
