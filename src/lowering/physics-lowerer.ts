/**
 * The physics family, lowered from `src/physics/havok.ts`.
 *
 * The pin already draws the line this port needs. `createHavokWorld(scene,
 * hknp)` takes the solver as a *parameter* and every call it makes on it is
 * an `HP_*` entry point, so `havok.ts` is not "the Havok integration" -- it
 * is Babylon's rigid-body semantics written against a fixed back-end
 * surface. That split is the ownership rule this repository already states:
 * everything above the line describes Babylon behaviour and is generated,
 * and the surface below it is a third-party library reached through the
 * PAL, which is the same role SDL plays.
 *
 * So what this lowerer emits is the pinned module's own logic:
 *
 * - the step gate `_fixedDeltaMs > 0 ? _fixedDeltaMs : deltaMs`, the
 *   non-finite/non-positive rejection, and the `Math.min(stepMs,
 *   MAX_STEP_MS) / 1000` clamp -- each read out of `_stepWorld` rather than
 *   restated, so a bump that moves the ceiling moves what is emitted;
 * - the pre-step / step / post-step / after-step ORDER, which is the whole
 *   observable contract of a frame;
 * - `createPhysicsAggregate`'s own ordering (shape, body, shape assignment,
 *   material, then mass) and its `?? 0.2` friction/restitution defaults;
 * - the shape sizing `_buildShapeParams` derives from the mesh's own bound
 *   pair and the node's scaling, term for term.
 *
 * What it deliberately does NOT emit is any solver arithmetic. There is
 * none in the pinned module to emit.
 *
 * **The one semantic divergence this repository has ever carried.** Every
 * other adaptation here is bit-faithful by construction or executed in the
 * engine the golden runs in. A different solver is neither: Bullet and
 * Havok integrate different contact models, so a body's pose after N steps
 * is a different number, not a rounding of the same one. It is recorded as
 * `substituted-physics-solver` in the scene's `fidelity.json`, and it is
 * why a physics scene's threshold cannot be driven toward zero: scene 40
 * carries one, but it gates this port's own solver against a measured
 * distance rather than asserting agreement with the pinned one. See
 * `docs/fidelity.md#physics-contract`.
 */
import ts from "typescript";
import {
    statementKind,
    type LoweredSource,
    type LoweringContext,
} from "./context.js";
import { lowerObjectComponents } from "./pinned-function-lowerer.js";
import {
    PinnedNumericLowerer,
    type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import {
    pinnedOptionDefaults,
    pinnedOptionFallback,
} from "./pinned-option-defaults.js";
import { lowerPhysicsQueries } from "./physics-query-lowerer.js";
import { lowerPhysicsContainer } from "./physics-container-lowerer.js";
import { lowerPhysicsMesh } from "./physics-mesh-lowerer.js";
import { lowerPhysicsViewer } from "./physics-viewer-lowerer.js";
import { lowerPhysicsConstraints } from "./physics-constraint-lowerer.js";
import { lowerPhysicsGravity } from "./physics-gravity-lowerer.js";
import { lowerPhysicsHeightfield } from "./physics-heightfield-lowerer.js";
import { lowerPhysicsThinInstances } from "./physics-thin-instance-lowerer.js";
import {
    lowerPhysicsAfterStep,
    lowerPhysicsCollisionInfo,
    lowerPhysicsEvents,
} from "./physics-event-lowerer.js";
import {
    SHAPE_PARAMETERS,
    shapeParameterStorage,
} from "../compiler/intrinsics/physics.js";
import { recordAt } from "../compiler/record-access.js";
import {
    enableFloatingOriginCpp,
    floatingOriginForwardDeclaration,
    floatingOriginFunctionsCpp,
    floatingOriginNodeSettersCpp,
    floatingOriginStructs,
    havokFloatingOriginModule,
} from "./physics-floating-origin-lowerer.js";

/**
 * The five geometry lanes both pinned bags declare, as a struct body.
 *
 * `PhysicsAggregateOptions` and `PhysicsShapeParameters` carry the same
 * members under different owners, so the table is read once and rendered
 * once: a change to the lane shape lands in both structs or in neither.
 */
const shapeParameterLanes = (owner: string): string =>
    SHAPE_PARAMETERS.map(
        ([pinned, field, shape]) =>
            `    /** \`${owner}.${pinned}\`. */\n` +
            `    js::Nullable<${shapeParameterStorage(shape)}> ${field}{};`,
    ).join("\n");

export const havokModule = "src/physics/havok.ts";

/**
 * The trigger-volume module. Upstream keeps it standalone "so the trigger
 * path adds bytes only to scenes that actually import
 * setPhysicsShapeIsTrigger or onPhysicsTrigger", and its two reached
 * exports are what this port mirrors: the shape flag, and the post-step
 * drain that turns the back end's event stream into `{ type }`.
 */
export const havokTriggerModule = "src/physics/havok-trigger.ts";

/**
 * The physics sub-features a tree reached, each named after the runtime
 * feature it mirrors. An arm is emitted only when its feature is present,
 * so a tree that never reaches a family neither declares nor calls it --
 * the same rule the PAL applies through its `BBLITE_HAS_PHYSICS_*` gates,
 * which the build writes from the same feature list.
 */
export interface PhysicsLoweringOptions {
    /** `physics:queries`: the single-hit shape proximity and cast queries. */
    readonly queries?: boolean;
    /** `physics:container`: compound shapes. */
    readonly container?: boolean;
    /** `physics:viewer`: the debug geometry catalogue. */
    readonly viewer?: boolean;
    /** `physics:constraints`: hinges and six-degree constraints. */
    readonly constraints?: boolean;
    /** `physics:heightfield`: the ground heightfield shape. */
    readonly heightfield?: boolean;
    /** `physics:trigger`: `havok-trigger.ts`, the shape flag and the drain. */
    readonly trigger?: boolean;
    /** `physics:floating-origin`: `havok-floating-origin.ts`, the regions. */
    readonly floatingOrigin?: boolean;
    readonly thinInstances?: boolean;
}

/** The pinned builder every aggregate's shape parameters come from. */
const buildShapeParams = "_buildShapeParams";

/** The pinned factory both shape paths fork on. */
const primitiveShapeHandle = "createPrimitivePhysicsShapeHandle";

/**
 * Each primitive arm's back-end entry point and the PAL function that
 * stands in for it.
 *
 * The pin's own call name is checked against the arm rather than assumed,
 * because the PAL's surface is named after it: a renamed `HP_Shape_Create*`
 * is a changed back-end contract, and it must fail here rather than keep
 * routing a box to the sphere entry point.
 */
const PRIMITIVE_SHAPE_ARMS: ReadonlyArray<readonly [string, string, string]> = [
    ["SPHERE", "HP_Shape_CreateSphere", "physics_shape_create_sphere"],
    ["BOX", "HP_Shape_CreateBox", "physics_shape_create_box"],
    ["CAPSULE", "HP_Shape_CreateCapsule", "physics_shape_create_capsule"],
    ["CYLINDER", "HP_Shape_CreateCylinder", "physics_shape_create_cylinder"],
];

/**
 * `_buildShapeParams`'s prelude scalars, as (the pin's name, the emitted
 * field).
 *
 * One table because four things have to agree about each pair: the binding
 * every case reads it through, the emitted struct's field, the assignment
 * that fills it, and the declaration inventory below. Stated four times, a
 * mismatched pairing -- binding `scaleY` while assigning from
 * `scaleYMagnitude` -- would pass every check and ship the wrong scale.
 */
const PRELUDE_SCALARS = [
    ["scaleX", "scale_x"],
    ["scaleYMagnitude", "scale_y_magnitude"],
    ["scaleZ", "scale_z"],
    ["scaleY", "scale_y"],
] as const;

export class PhysicsLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * `MAX_STEP_MS`, the pin's own tunnelling ceiling. Read rather than
     * restated: the value is a solver-stability contract, and a bump that
     * changes it changes what a native step does.
     */
    private maxStepMs(): number {
        const file = this.context.sourceFile(havokModule);
        const declared = this.context.moduleScopeConstant(file, "MAX_STEP_MS");
        if (!declared) {
            this.context.contractError(
                file,
                `Expected ${havokModule} to declare MAX_STEP_MS.`,
            );
        }
        return this.context.numericValue(declared, file);
    }

    /**
     * The `gravity ?? { x, y, z }` default `createHavokWorld` resolves.
     */
    private defaultGravity(): [number, number, number] {
        const { declaration } = this.context.functionDeclaration(
            havokModule,
            "createHavokWorld",
        );
        const fallback = pinnedOptionFallback(this.context, declaration, {
            local: "g",
        });
        if (!ts.isObjectLiteralExpression(fallback)) {
            this.context.contractError(
                fallback,
                "Expected createHavokWorld to default its gravity " +
                    "through `gravity ?? { x, y, z }`.",
            );
        }
        const file = this.context.sourceFile(havokModule);
        return ["x", "y", "z"].map((axis) =>
            this.context.numericValue(
                this.context.propertyInitializer(fallback, axis),
                file,
            ),
        ) as [number, number, number];
    }

    /**
     * `createPhysicsAggregate`'s `options.friction ?? 0.2` and
     * `options.restitution ?? 0.2`. Two separate reads, because the pin
     * writes two separate defaults and a bump may move only one.
     */
    private aggregateMaterialDefaults(): {
        friction: number;
        restitution: number;
    } {
        return pinnedOptionDefaults(
            this.context,
            havokModule,
            "createPhysicsAggregate",
            ["friction", "restitution"],
        );
    }

    /**
     * The numeric value of each `PhysicsShapeType` / `PhysicsMotionType`
     * member. The pin declares them as `as const` value objects (1.27.0
     * replaced its `const enum`s so consumers under `verbatimModuleSyntax`
     * can import them), so the object literal is the only place the number
     * exists -- and both PALs translate the emitted enumerator, so a member
     * the pin renumbers has to renumber here too.
     */
    private enumMembers(name: string): Map<string, number> {
        const file = this.context.sourceFile(havokModule);
        const literal = this.context.objectInitializer(file, name);
        const members = new Map<string, number>();
        for (const member of literal.properties) {
            if (
                !ts.isPropertyAssignment(member) ||
                !ts.isIdentifier(member.name)
            ) {
                this.context.contractError(
                    member,
                    `Expected ${name} members to be named numeric properties.`,
                );
            }
            members.set(
                member.name.text,
                this.context.numericValue(member.initializer, file),
            );
        }
        return members;
    }

    /**
     * `_buildShapeParams`, translated from its own AST.
     *
     * 1.25.0 deleted `_boundingCenter`, `_boundingExtents` and
     * `_boundingRadius` and states the whole derivation inline instead --
     * scaled by the node's own scaling, with a capsule and a cylinder
     * spanning the mesh's Y range where the old defaults gave both the unit
     * segment. So the port follows the derivation to where it now lives:
     * every number below is one of the pin's own expressions.
     *
     * Two specializations, and they are the ones the deleted helpers
     * already made: the optional bound arrays become `MeshBounds::present`
     * with each `??` taking the pin's own literal, and every component
     * widens to the JavaScript-number double the pin computes in.
     *
     * Every per-case `??` is emitted as its RIGHT arm alone -- the derived
     * value, read from the pin rather than restated. The left arm is the
     * aggregate's own explicit override, and it lives at the one call site
     * that has an options bag to read it from (`create_physics_aggregate`),
     * because the other caller of these helpers -- a standalone
     * `createPhysicsShape` -- has none.
     */
    private lowerShapeParams(): string {
        const { file, declaration } = this.context.functionDeclaration(
            havokModule,
            buildShapeParams,
        );
        if (!declaration.body) {
            this.context.contractError(
                declaration,
                `Expected ${buildShapeParams} to have a body.`,
            );
        }
        this.assertShapeParamsPrelude(declaration);
        this.assertShapeParamsCases(declaration);
        const axes = ["x", "y", "z"] as const;
        const scalar = (cpp: string): PinnedBinding => ({
            cpp,
            type: "scalar",
        });
        const bindings = new Map<string, PinnedBinding>([
            // The prelude reads the mesh; every case reads the prelude.
            ...axes.map((axis): [string, PinnedBinding] => [
                `node.scaling.${axis}`,
                scalar(`static_cast<double>(scaling.${axis})`),
            ]),
            ["node.boundMin", { cpp: "box.present", type: "bool" }],
            ["node.boundMax", { cpp: "box.present", type: "bool" }],
            ...PRELUDE_SCALARS.map(
                ([pinned, field]): [string, PinnedBinding] => [
                    pinned,
                    scalar(`shape.${field}`),
                ],
            ),
            ...axes.flatMap((axis, index): Array<[string, PinnedBinding]> => [
                [`min[${index}]`, scalar(`shape.minimum.${axis}`)],
                [`max[${index}]`, scalar(`shape.maximum.${axis}`)],
            ]),
            // `extents.x` resolves through this one: the translator appends
            // the member to a `vec3` binding, so the three component
            // spellings would be the same text stated twice.
            ["extents", { cpp: "shape.extents", type: "vec3" }],
            // The CAPSULE case's own local, which its two points read back.
            // The emitted `capsule_shape` declares it where the pin does,
            // and no other case names one.
            ["radius", scalar("radius")],
        ]);
        const lowerer = new PinnedNumericLowerer(file, {
            bindings,
            calls: pinnedNumericMathCalls(),
        });
        const vector = (expression: ts.Expression): string => {
            const unwrapped = this.context.unwrapExpression(expression);
            if (!ts.isObjectLiteralExpression(unwrapped)) {
                return lowerer.expression(unwrapped);
            }
            return `Vec3d{${lowerObjectComponents(
                this.context,
                lowerer,
                unwrapped,
                [...axes],
            ).join(", ")}}`;
        };
        const preludeTerm = (name: string): string =>
            lowerer.expression(
                this.context.variableInitializer(declaration, name),
            );
        const boundVector = (name: "min" | "max"): string => {
            const member = name === "min" ? "minimum" : "maximum";
            const initializer = this.context.variableInitializer(
                declaration,
                name,
            );
            const split = this.context.nullishDefault(initializer);
            const fallback = split
                ? this.context.unwrapExpression(split.right)
                : undefined;
            if (
                !split ||
                !fallback ||
                !ts.isArrayLiteralExpression(fallback) ||
                fallback.elements.length !== axes.length
            ) {
                this.context.contractError(
                    initializer,
                    `Expected ${buildShapeParams}'s '${name}' to be the ` +
                        "optional bound array over a three-component " +
                        "literal fallback.",
                );
            }
            const present = lowerer.expression(split.left);
            return `Vec3d{${axes
                .map(
                    (axis, index) =>
                        `${present} ? static_cast<double>(` +
                        `box.${member}.${axis}) : ` +
                        this.context.doubleLiteral(
                            this.context.numericValue(
                                fallback.elements[index]!,
                                file,
                            ),
                        ),
                )
                .join(", ")}}`;
        };
        const sphereCenter = vector(
            this.shapeCaseValue(declaration, "SPHERE", "center"),
        );
        const boxCenter = vector(
            this.shapeCaseValue(declaration, "BOX", "center"),
        );
        if (sphereCenter !== boxCenter) {
            this.context.contractError(
                declaration,
                "Expected the SPHERE and BOX cases to state the same " +
                    "centre. They share one emitted helper, so a pin that " +
                    "gives them different centres has to split it.",
            );
        }
        // A capsule declares a local its two points read back and a
        // cylinder declares none, so the locals come from the clause rather
        // than from a hoist that would have to move if the pin added one.
        const segment = (caseName: "CAPSULE" | "CYLINDER"): string => {
            const clause = this.shapeCaseClause(declaration, caseName);
            const locals = this.context
                .findNodes(clause, ts.isVariableDeclaration)
                .map((local) => {
                    if (!ts.isIdentifier(local.name) || !local.initializer) {
                        return this.context.contractError(
                            local,
                            `Expected the ${caseName} case's local to be a ` +
                                "named initialized binding.",
                        );
                    }
                    return (
                        `    const double ${local.name.text} = ` +
                        `${lowerer.expression(local.initializer)};
`
                    );
                })
                .join("");
            const value = (property: string): ts.Expression =>
                this.shapeCaseValue(declaration, caseName, property);
            return `PinnedSegmentShape ${caseName.toLowerCase()}_shape(
    const PinnedShapeBounds& shape) {
${locals}    return PinnedSegmentShape{
        ${lowerer.expression(value("radius"))},
        ${vector(value("pointA"))},
        ${vector(value("pointB"))}};
}`;
        };
        return `struct PinnedShapeBounds {
${PRELUDE_SCALARS.map(([, field]) => `    double ${field} = 0.0;`).join("\n")}
    Vec3d minimum{};
    Vec3d maximum{};
    Vec3d extents{};
};

/** A capsule's and a cylinder's own three parameters. */
struct PinnedSegmentShape {
    double radius = 0.0;
    Vec3d point_a{};
    Vec3d point_b{};
};

PinnedShapeBounds pinned_shape_bounds(
    const MeshBounds& box,
    const Vec3& scaling) {
    PinnedShapeBounds shape{};
${PRELUDE_SCALARS.map(
    ([pinned, field]) => `    shape.${field} = ${preludeTerm(pinned)};`,
).join("\n")}
    shape.minimum = ${boundVector("min")};
    shape.maximum = ${boundVector("max")};
    shape.extents = ${vector(
        this.context.variableInitializer(declaration, "extents"),
    )};
    return shape;
}

/** The centre the SPHERE and BOX cases both state. */
Vec3d bounding_center(const PinnedShapeBounds& shape) {
    return ${sphereCenter};
}

double sphere_radius(const PinnedShapeBounds& shape) {
    return ${lowerer.expression(
        this.shapeCaseValue(declaration, "SPHERE", "radius"),
    )};
}

Vec3d box_extents(const PinnedShapeBounds& shape) {
    return ${vector(this.shapeCaseValue(declaration, "BOX", "extents"))};
}

${segment("CAPSULE")}

${segment("CYLINDER")}`;
    }

    /**
     * `createPrimitivePhysicsShapeHandle`, translated from its own AST.
     *
     * This is the one place a shape parameter becomes a back-end call, and
     * the pin has exactly one of them: `createPhysicsShape` and
     * `createPhysicsAggregate` both route through it and both fork on its
     * `null`. So the emitted port has one too -- the aggregate hands it what
     * `_buildShapeParams` derived, a standalone `createPhysicsShape` hands it
     * the scene's own `parameters` bag, and each arm's `??` default is read
     * from the pin rather than restated at either call site.
     */
    private lowerPrimitiveShapeHandle(): string {
        const { file, declaration } = this.context.functionDeclaration(
            havokModule,
            primitiveShapeHandle,
        );
        if (!declaration.body) {
            this.context.contractError(
                declaration,
                `Expected ${primitiveShapeHandle} to have a body.`,
            );
        }
        this.assertShapeParameterMembers();
        const cases = this.context
            .findNodes(declaration, ts.isCaseClause)
            .map((clause) =>
                clause.expression
                    .getText(file)
                    .replace("PhysicsShapeType.", ""),
            );
        const expected = PRIMITIVE_SHAPE_ARMS.map(([name]) => name);
        if (
            cases.length !== expected.length ||
            cases.some((name, index) => name !== expected[index])
        ) {
            this.context.contractError(
                declaration,
                `${primitiveShapeHandle} switches on [${cases.join(", ")}]; ` +
                    `the PAL names one entry point per [${expected.join(", ")}], ` +
                    "so a primitive the pin adds must reach a surface of its own " +
                    "rather than falling through to the mesh-shape arms.",
            );
        }
        const otherwise = this.context.findNodes(
            declaration,
            ts.isDefaultClause,
        );
        const returnsNull =
            otherwise.length === 1 &&
            otherwise[0]!.statements.length === 1 &&
            ts.isReturnStatement(otherwise[0]!.statements[0]!) &&
            otherwise[0]!.statements[0].expression?.kind ===
                ts.SyntaxKind.NullKeyword;
        if (!returnsNull) {
            this.context.contractError(
                declaration,
                `Expected ${primitiveShapeHandle} to answer null for a ` +
                    "non-primitive type. Both callers fork on that null, so an " +
                    "arm that started building one would be built twice.",
            );
        }
        return `/**
 * \`${primitiveShapeHandle}\`. Answers nothing for a type the pin answers
 * \`null\` for, which is the branch both shape paths fork on.
 */
std::optional<pal::PhysicsShapeHandle> primitive_physics_shape_handle(
    PhysicsShapeType type,
    const PhysicsShapeParameters& params) {
    switch (type) {
${PRIMITIVE_SHAPE_ARMS.map((arm) =>
    this.lowerPrimitiveShapeArm(file, declaration, arm),
).join("\n")}
        default:
            return std::nullopt;
    }
}`;
    }

    /** One `case PhysicsShapeType.<name>:` of the primitive factory. */
    private lowerPrimitiveShapeArm(
        file: ts.SourceFile,
        declaration: ts.FunctionDeclaration,
        [caseName, entryPoint, palFunction]: readonly [string, string, string],
    ): string {
        const clause = this.context
            .findNodes(declaration, ts.isCaseClause)
            .find(
                (candidate) =>
                    candidate.expression.getText(file) ===
                    `PhysicsShapeType.${caseName}`,
            )!;
        const bindings = new Map<string, PinnedBinding>();
        const lowerer = new PinnedNumericLowerer(file, {
            bindings,
            calls: pinnedNumericMathCalls(),
        });
        const supplied = new Map<string, string>(
            SHAPE_PARAMETERS.map(([pinned, field]) => [pinned, field]),
        );
        const locals = this.context
            .findNodes(clause, ts.isVariableDeclaration)
            .map((local) => {
                if (!ts.isIdentifier(local.name) || !local.initializer) {
                    this.context.contractError(
                        local,
                        `Expected the ${caseName} arm's local to be a named ` +
                            "initialized binding.",
                    );
                }
                const name = local.name.text;
                const split = this.context.nullishDefault(local.initializer);
                const member =
                    split && ts.isPropertyAccessExpression(split.left)
                        ? split.left.name.text
                        : undefined;
                if (
                    !split ||
                    !member ||
                    split.left.getText(file) !== `params.${member}`
                ) {
                    this.context.contractError(
                        local.initializer,
                        `Expected the ${caseName} arm to read '${name}' as ` +
                            "`params.<member> ?? <default>`; the default is what a " +
                            "caller omitting the parameter gets, and it must come " +
                            "from the pin.",
                    );
                }
                const fallback = this.context.unwrapExpression(split.right);
                const field = supplied.get(member);
                const components = ts.isObjectLiteralExpression(fallback)
                    ? fallback.properties.map((property) =>
                          property.name && ts.isIdentifier(property.name)
                              ? property.name.text
                              : "",
                      )
                    : undefined;
                // `??` on the pin's side, `has_value()` on this one -- and for a
                // member outside the reached slice the left arm cannot be
                // supplied at all, so the default IS the value.
                const defaulted = (value: string): string =>
                    field
                        ? `params.${field} ? *params.${field} : ${value}`
                        : value;
                if (components === undefined) {
                    bindings.set(name, { cpp: name, type: "scalar" });
                    return (
                        `            const double ${name} = ` +
                        `${defaulted(lowerer.expression(fallback))};\n`
                    );
                }
                if (components.join(",") === "x,y,z") {
                    bindings.set(name, { cpp: name, type: "vec3" });
                    const literal = `Vec3d{${lowerObjectComponents(
                        this.context,
                        lowerer,
                        fallback,
                        ["x", "y", "z"],
                    ).join(", ")}}`;
                    return `            const Vec3d ${name} = ${defaulted(literal)};\n`;
                }
                if (components.join(",") !== "x,y,z,w") {
                    this.context.contractError(
                        fallback,
                        `The ${caseName} arm defaults '${name}' to ` +
                            `[${components.join(", ")}]; the emitted arm knows a ` +
                            "scalar, a three-component vector and a quaternion.",
                    );
                }
                // A quaternion has no reached lane in `PhysicsShapeParameters`
                // (see SHAPE_PARAMETERS), so this is the pin's own default and
                // nothing can override it. It stays the pin's expression rather
                // than a typed identity.
                for (const [index, axis] of ["x", "y", "z", "w"].entries()) {
                    bindings.set(`${name}.${axis}`, {
                        cpp: `${name}[${index}]`,
                        type: "scalar",
                    });
                }
                const literal = `{${lowerObjectComponents(
                    this.context,
                    lowerer,
                    fallback,
                    ["x", "y", "z", "w"],
                ).join(", ")}}`;
                return (
                    `            const std::array<double, 4> ${name} = ` +
                    `${defaulted(literal)};\n`
                );
            })
            .join("");
        const returned = clause.statements
            .flatMap((statement) =>
                ts.isBlock(statement) ? [...statement.statements] : [statement],
            )
            .find(ts.isReturnStatement);
        const call =
            returned?.expression &&
            ts.isElementAccessExpression(returned.expression) &&
            ts.isCallExpression(returned.expression.expression)
                ? returned.expression.expression
                : undefined;
        if (!call || call.expression.getText(file) !== `hknp.${entryPoint}`) {
            this.context.contractError(
                returned ?? clause,
                `Expected the ${caseName} arm to return ` +
                    `hknp.${entryPoint}(...)[1]; the PAL entry point ` +
                    `${palFunction} is named after it, so a renamed back-end call ` +
                    "must be re-read rather than left routing to the old one.",
            );
        }
        const args = call.arguments.map((argument) => {
            const unwrapped = this.context.unwrapExpression(argument);
            return ts.isArrayLiteralExpression(unwrapped)
                ? `{${unwrapped.elements
                      .map((element) => lowerer.expression(element))
                      .join(", ")}}`
                : lowerer.expression(unwrapped);
        });
        return `        case PhysicsShapeType::${caseName}: {
${locals}            return pal::${palFunction}(${args.join(", ")});
        }`;
    }

    /**
     * `PhysicsShapeParameters`' own member list.
     *
     * The emitted struct carries the reached subset, and the primitive arms
     * read the rest as the pin's own defaults. Either way a member the pin
     * ADDS is one an arm may start reading, so the interface is checked
     * whole rather than only where a lane exists for it.
     */
    private assertShapeParameterMembers(): void {
        const { declaration } = this.context.interfaceDeclaration(
            havokModule,
            "PhysicsShapeParameters",
        );
        const declared = declaration.members.map((member) =>
            member.name && ts.isIdentifier(member.name) ? member.name.text : "",
        );
        // Derived from the one table, plus the member it deliberately omits:
        // `rotation` reaches no corpus scene, so the emitted BOX arm reads the
        // pin's own `?? { x: 0, y: 0, z: 0, w: 1 }` fallback and a scene that
        // names one refuses at the intrinsic.
        const known = [
            ...SHAPE_PARAMETERS.map(([pinned]) => pinned),
            "rotation",
        ];
        if (
            declared.length !== known.length ||
            declared.some((member) => !known.includes(member))
        ) {
            this.context.contractError(
                declaration,
                `PhysicsShapeParameters declares [${declared.join(", ")}]; the ` +
                    `emitted parameter bag knows [${known.join(", ")}] and serves ` +
                    `[${SHAPE_PARAMETERS.map(([pinned]) => pinned).join(", ")}]. A ` +
                    "member the pin adds has to be read and carried rather than " +
                    "silently taking a primitive arm's default.",
            );
        }
    }

    /**
     * The switch's own case set, and each case's own assignments.
     *
     * `shapeCaseValue` asks for the properties this port already names, so
     * on its own it is blind in the direction a bump actually moves: a case
     * the pin ADDS, or a `params.<property>` it starts assigning inside an
     * existing one, is silently dropped. That is precisely the class of
     * change 1.25.0 made, and it surfaced only because the three helpers it
     * replaced were deleted. Here it fails by name instead.
     *
     * `rotation` is listed for BOX and SPHERE because the emitted box passes
     * the pin's own identity quaternion: it is an aggregate option this port
     * refuses, so what has to hold is that the pin still derives nothing for
     * it -- a case that started computing a rotation would need the emitted
     * shape to carry one.
     */
    private assertShapeParamsCases(declaration: ts.FunctionDeclaration): void {
        const file = declaration.getSourceFile();
        const expected = new Map<string, readonly string[]>([
            ["SPHERE", ["radius", "center"]],
            ["BOX", ["extents", "center"]],
            ["CAPSULE", ["radius", "pointA", "pointB"]],
            ["CYLINDER", ["radius", "pointA", "pointB"]],
        ]);
        const clauses = this.context.findNodes(declaration, ts.isCaseClause);
        const cases = clauses.map((clause) =>
            clause.expression.getText(file).replace("PhysicsShapeType.", ""),
        );
        if (
            cases.length !== expected.size ||
            cases.some((name) => !expected.has(name))
        ) {
            this.context.contractError(
                declaration,
                `${buildShapeParams} switches on [${cases.join(", ")}]; ` +
                    "the emitted aggregate serves exactly " +
                    `[${[...expected.keys()].join(", ")}], so a case the ` +
                    "pin adds must be read and re-emitted rather than " +
                    "falling through to the primitive-shape refusal.",
            );
        }
        for (const clause of clauses) {
            const name = clause.expression
                .getText(file)
                .replace("PhysicsShapeType.", "");
            const assigned = this.context
                .findNodes(clause, ts.isBinaryExpression)
                .filter(
                    (candidate) =>
                        candidate.operatorToken.kind ===
                            ts.SyntaxKind.EqualsToken &&
                        candidate.left.getText(file).startsWith("params."),
                )
                .map((candidate) =>
                    candidate.left.getText(file).slice("params.".length),
                );
            const wanted = expected.get(name)!;
            const extra = assigned.filter((key) => !wanted.includes(key));
            const missing = wanted.filter((key) => !assigned.includes(key));
            if (extra.length === 0 && missing.length === 0) continue;
            this.context.contractError(
                clause,
                `The ${name} case assigns [${assigned.join(", ")}]; the ` +
                    `emitted shape reads [${wanted.join(", ")}]. ` +
                    (missing.length > 0
                        ? `Unassigned: ${missing.join(", ")}. `
                        : "") +
                    (extra.length > 0 ? `Unread: ${extra.join(", ")}. ` : "") +
                    "A parameter the pin derives and this port does not read " +
                    "ships whatever the emitted shape hardcodes instead.",
            );
        }
    }

    /** One `case PhysicsShapeType.<name>:` of `_buildShapeParams`. */
    private shapeCaseClause(
        declaration: ts.FunctionDeclaration,
        caseName: string,
    ): ts.CaseClause {
        const file = declaration.getSourceFile();
        const clause = this.context
            .findNodes(declaration, ts.isCaseClause)
            .find(
                (candidate) =>
                    candidate.expression.getText(file) ===
                    `PhysicsShapeType.${caseName}`,
            );
        if (!clause) {
            this.context.contractError(
                declaration,
                `Expected ${buildShapeParams} to carry a ` +
                    `PhysicsShapeType.${caseName} case.`,
            );
        }
        return clause;
    }

    /**
     * The DERIVED side of `params.<property> = <override> ?? <derived>`.
     *
     * The override is an aggregate option this port refuses at generation,
     * so what an emitted shape uses is always the right arm -- and reading
     * it through the `??` is what makes a pin that stopped deriving the
     * value fail here instead of quietly keeping the old default.
     */
    private shapeCaseValue(
        declaration: ts.FunctionDeclaration,
        caseName: string,
        property: string,
    ): ts.Expression {
        const clause = this.shapeCaseClause(declaration, caseName);
        const file = declaration.getSourceFile();
        const assignment = this.context
            .findNodes(clause, ts.isBinaryExpression)
            .find(
                (candidate) =>
                    candidate.operatorToken.kind ===
                        ts.SyntaxKind.EqualsToken &&
                    candidate.left.getText(file) === `params.${property}`,
            );
        if (!assignment) {
            this.context.contractError(
                clause,
                `Expected the ${caseName} case to assign ` +
                    `params.${property}.`,
            );
        }
        const derived = this.context.nullishDefault(assignment.right);
        if (!derived) {
            this.context.contractError(
                assignment.right,
                `Expected the ${caseName} case to derive ` +
                    `params.${property} behind an option '??'.`,
            );
        }
        return derived.right;
    }

    /**
     * The pinned declarations this port RESTATES, and what must still be
     * true of each.
     *
     * A restated body is safe only while the thing it restates has not
     * moved, so every rule the emitted template folds is listed against the
     * declaration that states it. Two shapes cover all of them: expressions
     * a body must state, and CALLS it must make in order. Both read the
     * declaration's own nodes rather than its text, because a substring
     * scan is satisfied by a comment naming the rule, and an ordering a
     * comment can reorder is not a contract. Each expression is matched
     * structurally (`expressionMatchesShape`), so formatting, parentheses
     * and `as` casts do not pin bytes that carry no meaning.
     */
    /**
     * `MeshAccumulator`, whose rules the emitted accumulator restates: how it
     * addresses a vertex and how it winds a triangle.
     */
    private static readonly meshAccumulatorContracts: ReadonlyArray<
        readonly [string, readonly string[]]
    > = [
        [
            "MeshAccumulator",
            ["this._vertices.length / 3", "this._indices.push(c, b, a)"],
        ],
    ];

    private static readonly shapeContracts: ReadonlyArray<
        readonly [string, readonly string[]]
    > = [
        [
            "_stepWorld",
            [
                // The step gate: which delta, and the tunnelling clamp.
                "world._fixedDeltaMs > 0 ? world._fixedDeltaMs : deltaMs",
                "!Number.isFinite(stepMs) || stepMs <= 0",
                "Math.min(stepMs, MAX_STEP_MS) / 1000",
                // Which bodies each phase touches; the template restates
                // all three predicates, and the whole pre-step gate --
                // DISABLED skips, and only an ANIMATED (kinematic) or
                // explicitly pre-stepped body syncs.
                "b._prestepType !== PhysicsPrestepType.DISABLED",
                "b._prestepType !== PhysicsPrestepType.DISABLED && " +
                    "(b.motionType === (PhysicsMotionType.ANIMATED as number) " +
                    "|| b._preStep)",
                "b._prestepType === PhysicsPrestepType.ACTION",
                "b.motionType === (PhysicsMotionType.DYNAMIC as number)",
            ],
        ],
        [
            // `unshift`, not `push`: physics integrates before every other
            // before-render callback, so a scene reading a pose in one
            // reads this frame pose rather than the previous frame one.
            "createHavokWorld",
            ["scene._beforeRender.unshift(stepCb)"],
        ],
        [
            "_syncBodyToNode",
            [
                "node.position.set(pos[0], pos[1], pos[2])",
                "node.rotationQuaternion.set(rot[0], rot[1], rot[2], rot[3])",
            ],
        ],
        [
            // `mass === 0` is what makes a body static, and a mass is
            // written only for a positive one.
            "createPhysicsAggregate",
            ["options.mass === 0", "options.mass > 0"],
        ],
        [
            // The two mesh arms share one accumulator and split on one
            // boolean, which is what the emitted mesh factory folds into
            // `collect_indices`. If the pin ever collected indices for a
            // convex hull too, or built the soup from something other than
            // the triangle buffer, the emitted split would be wrong in a way
            // no expression below it can show.
            "createPhysicsShape",
            [
                "options.type === PhysicsShapeType.MESH",
                "hknp.HP_Shape_CreateMesh(positions.offset, numVec3s, " +
                    "triangles.offset, numTriangles)[1]",
            ],
        ],
        [
            // The material array in the pin own field order. Which combine
            // mode applies to which channel travels across the PAL surface
            // as data, so a flip upstream has to fail here. The static
            // channel is its own parameter since 1.25.0; the emitted
            // template still writes ONE friction into both, which is only
            // right while that parameter defaults to the dynamic one -- so
            // the default is asserted beside the array rather than assumed
            // (`staticFrictionDefault` below).
            "setPhysicsShapeMaterial",
            [
                "[staticFriction, friction, restitution, combines.MINIMUM, combines.MAXIMUM]",
            ],
        ],
        [
            // The motion-type mapping the generated body factory performs.
            // Upstream does not pass its own enum to the solver either.
            "createPhysicsBody",
            [
                "hknp.MotionType.STATIC",
                "hknp.MotionType.KINEMATIC",
                "hknp.MotionType.DYNAMIC",
            ],
        ],
        [
            // `setPhysicsBodyMass` keeps the shape-derived tensor and
            // overrides only the mass scalar. The generated code performs
            // that branch, so the branch has to still be the pin one --
            // asserted whole, isotropic fallback arm included.
            "setPhysicsBodyMass",
            [
                "body._shape ? buildMassProperties(world, body) : " +
                    "[[0, 0, 0], mass, [mass, mass, mass], [0, 0, 0, 1]]",
                "massProps[1] = mass",
            ],
        ],
        [
            // The two overrides the reached slice writes, by the array index
            // each lands on. The emitted setter fills a named lane of
            // `pal::PhysicsMassProperties` per index, so an upstream reorder of
            // the tuple would silently write a centre into the mass.
            "setPhysicsBodyMassProperties",
            [
                "buildMassProperties(world, body)",
                "massProps[0] = [properties.centerOfMass.x, " +
                    "properties.centerOfMass.y, properties.centerOfMass.z]",
                "massProps[1] = properties.mass",
            ],
        ],
    ];

    /** The calls each declaration must make, in this order. */
    private static readonly orderContracts: ReadonlyArray<
        readonly [string, readonly string[]]
    > = [
        [
            // The four phases of a frame. A reordering is invisible in
            // every single expression and changes every frame.
            "_stepWorld",
            ["_syncNodeToBodyTarget", "HP_World_Step", "_syncBodyToNode"],
        ],
        [
            // Upstream comments this ordering because it is observable:
            // mass derives from the shape, so a mass written before the
            // shape is attached reads a different inertia tensor.
            "createPhysicsAggregate",
            [
                "createPhysicsBody",
                "setPhysicsBodyShape",
                "setPhysicsShapeMaterial",
                "setPhysicsBodyMass",
            ],
        ],
        [
            // Motion type, then add to world, then transform: the solver
            // resets a body transform on add, which is why the pin orders
            // it this way and the generated factory follows.
            "createPhysicsBody",
            [
                "HP_Body_Create",
                "HP_Body_SetMotionType",
                "HP_World_AddBody",
                "HP_Body_SetQTransform",
            ],
        ],
    ];

    private pinnedDeclaration(symbolName: string): ts.FunctionDeclaration {
        return this.context.functionDeclaration(havokModule, symbolName)
            .declaration;
    }

    /**
     * `enableHavokFloatingOrigin`'s own `floatingOriginWorldRadius = 100000`.
     *
     * Read from the parameter rather than restated for the same reason
     * `MAX_STEP_MS` is: the radius decides how far a body travels before it
     * is re-based, so a bump that moves it moves every far-from-origin
     * simulation. The intrinsic emits this constant when a scene omits the
     * argument, which is where the pin applies its default too.
     */
    private floatingOriginRadius(): number {
        const declaration = this.pinnedDeclaration("enableHavokFloatingOrigin");
        const parameter = declaration.parameters[1];
        const initializer = parameter?.initializer;
        if (
            !parameter ||
            !initializer ||
            !ts.isNumericLiteral(initializer) ||
            !ts.isIdentifier(parameter.name) ||
            parameter.name.text !== "floatingOriginWorldRadius"
        ) {
            this.context.contractError(
                parameter ?? declaration,
                "Expected enableHavokFloatingOrigin's second parameter to be " +
                    "floatingOriginWorldRadius with a numeric default. The " +
                    "generated intrinsic emits that default at every call site " +
                    "that omits the argument.",
            );
        }
        return Number(initializer.text);
    }

    /**
     * The three walks each contract table drives, over whichever pinned
     * module declares its symbols.
     *
     * Two modules are restated here -- `havok.ts` and the floating-origin
     * module it dynamic-imports -- and both carry the same three kinds of
     * rule over their own declarations, so each walk takes the resolver
     * rather than being written once per module. A second copy would be a
     * place for the two to disagree about what a violated contract says.
     */
    private assertShapeContracts(
        resolve: (symbolName: string) => ts.Node,
        contracts: ReadonlyArray<readonly [string, readonly string[]]>,
    ): void {
        for (const [symbolName, shapes] of contracts) {
            const declaration = resolve(symbolName);
            for (const shape of shapes) {
                const stated = this.context.findNodes(
                    declaration,
                    (node): node is ts.Expression =>
                        ts.isExpression(node) &&
                        this.context.expressionMatchesShape(node, shape),
                );
                if (stated.length > 0) continue;
                this.context.contractError(
                    declaration,
                    "Expected " +
                        symbolName +
                        " to state '" +
                        shape +
                        "'. The generated physics " +
                        "translation unit restates this rule, so a " +
                        "pinned change to it fails generation rather " +
                        "than shipping a different simulation.",
                );
            }
        }
    }

    private assertInventoryContracts(
        resolve: (symbolName: string) => ts.FunctionDeclaration,
        contracts: ReadonlyArray<readonly [string, string, readonly string[]]>,
        project?: (statement: ts.Statement) => string | undefined,
    ): void {
        for (const [symbolName, restated, kinds] of contracts) {
            const declaration = resolve(symbolName);
            this.context.assertStatementInventory(
                declaration,
                declaration.body!.statements,
                symbolName,
                restated,
                kinds,
                project,
            );
        }
    }

    private assertOrderContracts(
        resolve: (symbolName: string) => ts.FunctionDeclaration,
        contracts: ReadonlyArray<readonly [string, readonly string[]]>,
    ): void {
        for (const [symbolName, callees] of contracts) {
            const declaration = resolve(symbolName);
            const called = this.context
                .findNodes(declaration, ts.isCallExpression)
                .map((call) => {
                    const callee = call.expression;
                    if (ts.isPropertyAccessExpression(callee)) {
                        return callee.name.text;
                    }
                    return ts.isIdentifier(callee) ? callee.text : "";
                });
            let cursor = -1;
            for (const callee of callees) {
                const at = called.indexOf(callee, cursor + 1);
                if (at <= cursor) {
                    this.context.contractError(
                        declaration,
                        "Expected " +
                            symbolName +
                            " to call " +
                            callees.join(" then ") +
                            "; '" +
                            callee +
                            "' is missing or out of that order.",
                    );
                }
                cursor = at;
            }
        }
    }

    /** Every rule the emitted template folds, checked where it is stated. */
    private assertPinnedContracts(): void {
        const resolve = (symbolName: string): ts.FunctionDeclaration =>
            this.pinnedDeclaration(symbolName);
        this.assertShapeContracts(resolve, PhysicsLowerer.shapeContracts);
        this.assertInventoryContracts(
            resolve,
            PhysicsLowerer.inventoryContracts,
        );
        this.assertStaticFrictionDefault();
        // The accumulator's rules live in a class METHOD, which
        // `pinnedDeclaration` does not reach -- but the walk only ever needs a
        // root to search and an owner to blame, so the module file is a legal
        // resolver and this is a table row rather than a fourth copy of the
        // loop.
        this.assertShapeContracts(
            () => this.context.sourceFile(havokModule),
            PhysicsLowerer.meshAccumulatorContracts,
        );
        this.assertOrderContracts(resolve, PhysicsLowerer.orderContracts);
    }

    /**
     * The two rules `MeshAccumulator` states that the emitted accumulator
     * restates, asserted where they are stated.
     *
     * They cannot go in `shapeContracts`: `MeshAccumulator` is a class and
     * its rules live in a METHOD, which `functionDeclaration` does not
     * reach. Both are silent if they drift. The offset is read before the
     * node's own vertices join the list, so a pin that moved the read would
     * address a child's triangles into the wrong vertices; and the winding
     * reversal decides which side of every triangle the back end pushes a
     * resting body out of.
     */
    /**
     * `setPhysicsShapeMaterial`'s static-friction parameter defaults to the
     * dynamic one.
     *
     * The emitted setter resolves an absent static friction to the dynamic
     * one, which is the pin's behaviour only because that is the parameter
     * default -- and the aggregate, the reached caller that passes four
     * arguments, is what makes one friction reach both channels. A pin that
     * gave the static channel a default of its own would keep the array
     * shape above and change the simulation, so the DEFAULT is what has to
     * be read.
     */
    private assertStaticFrictionDefault(): void {
        const declaration = this.pinnedDeclaration("setPhysicsShapeMaterial");
        const parameter = declaration.parameters.find(
            (candidate) =>
                ts.isIdentifier(candidate.name) &&
                candidate.name.text === "staticFriction",
        );
        if (
            !parameter?.initializer ||
            !this.context.expressionMatchesShape(
                parameter.initializer,
                "friction",
            )
        ) {
            this.context.contractError(
                parameter ?? declaration,
                "Expected setPhysicsShapeMaterial's staticFriction to " +
                    "default to friction. The generated setter resolves an " +
                    "absent one that way, which is what puts a single " +
                    "friction into both material channels at the pin's own " +
                    "four-argument call sites.",
            );
        }
    }

    /**
     * Every pinned body the emitted translation unit restates WHOLE, with
     * the statement inventory that keeps the contracts above complete.
     *
     * The two kinds of contract above assert that a shape is PRESENT and
     * that calls happen in an ORDER. Neither can see a statement the pin
     * ADDS: a new expression leaves every shape it looks for where it was,
     * and `orderContracts` walks with a cursor that skips anything between
     * two ordered calls. So a body restated statement by statement into
     * C++ needs its statement count pinned as well, or an added arm is
     * dropped from the emitted copy in silence.
     *
     * That is not hypothetical. 1.26.0 added
     * `body._massPropertiesTransform?.(massProps)` to `setPhysicsBodyMass`
     * -- a hook only the unlowered `lockPhysicsBodyRotationAxes` installs,
     * so the emitted copy is still faithful -- and every shape and order
     * contract in this file passed. It added the identical line to
     * `setPhysicsBodyMassProperties`, which this port does not lower at
     * all. The next such line lands in a body that IS restated.
     *
     * A row is `[symbol, what restates it, the kinds in the pin's order]`,
     * driven by one loop, so guarding a further body is a row rather than a
     * method -- and the set of guarded bodies reads beside the set of
     * restated ones.
     */
    private static readonly inventoryContracts: ReadonlyArray<
        readonly [string, string, readonly string[]]
    > = [
        [
            "_stepWorld",
            "the emitted step_world restates the whole body",
            [
                // const { _hknp, _hkWorld, _bodies } = world;
                "variable statement",
                // const stepMs = <fixed-or-live gate>;
                "variable statement",
                // the non-finite / non-positive rejection
                "if statement",
                // const dt = <MAX_STEP_MS clamp>;
                "variable statement",
                // the floating-origin arm, which RETURNS: a region-stepped world
                // runs neither the prestep gate below nor the after-step hooks
                "if statement",
                // the pre-step sync loop
                "for statement",
                // hknp.HP_World_Step(hkWorld, dt);
                "expression statement",
                // the post-step sync loop
                "for statement",
                // the after-step hooks
                "if statement",
            ],
        ],
        [
            "createPhysicsAggregate",
            "create_physics_aggregate restates its four phases, calling the " +
                "emitted shape and material setters where the pin calls them",
            [
                // const motionType = options.mass === 0 ? STATIC : DYNAMIC;
                "variable statement",
                // Validate thin instances before allocating an owned shape.
                "expression statement",
                // let shape = options.shape;
                "variable statement",
                // the primitive-shape build, and its refusal
                "if statement",
                // const body = createPhysicsBody(...);
                "variable statement",
                // setPhysicsBodyShape(world, body, shape);
                "expression statement",
                // const friction = options.friction ?? 0.2;
                "variable statement",
                // const restitution = options.restitution ?? 0.2;
                "variable statement",
                // setPhysicsShapeMaterial(world, shape, friction, restitution);
                "expression statement",
                // the mass phase, gated on `options.mass > 0`
                "if statement",
                // return { body, shape };
                "return statement",
            ],
        ],
        [
            "createPhysicsBody",
            "the emitted body factory restates the whole body",
            [
                // const { _hknp: hknp, _hkWorld: hkWorld } = world;
                "variable statement",
                // const thinBody = world._thin?.create(...);
                "variable statement",
                "if statement",
                // const hkMotion = <the three-arm motion-type mapping>;
                "variable statement",
                // const hkBody = hknp.HP_Body_Create()[1];
                "variable statement",
                // the body record itself
                "variable statement",
                // hknp.HP_Body_SetMotionType(hkBody, hkMotion);
                "expression statement",
                // the floating-origin arm against the plain add-then-transform
                "if statement",
                // world._bodies.push(body);
                "expression statement",
                // return body;
                "return statement",
            ],
        ],
        [
            "setPhysicsShapeMaterial",
            "the emitted set_physics_shape_material restates the material write",
            [
                // const combines = world._hknp.MaterialCombine;
                "variable statement",
                // the five-term material array
                "variable statement",
                // world._hknp.HP_Shape_SetMaterial(shape._hkShape, material);
                "expression statement",
            ],
        ],
        [
            // The two overrides above are the ones the intrinsic accepts; the
            // other two refuse there, so an ADDED arm here would be a member
            // the intrinsic still accepts and the emitted setter drops.
            "setPhysicsBodyMassProperties",
            "set_physics_body_mass_properties restates the reached overrides",
            [
                // const massProps = buildMassProperties(world, body);
                "variable statement",
                // if (properties.centerOfMass)
                "if statement",
                // if (properties.mass !== undefined)
                "if statement",
                // if (properties.inertia) -- refused by the intrinsic
                "if statement",
                // if (properties.inertiaOrientation) -- refused by the intrinsic
                "if statement",
                // body._massPropertiesTransform?.(massProps) -- installed only by
                // the unlowered `lockPhysicsBodyRotationAxes`, so a no-op here
                "expression statement",
                // hknp.HP_Body_SetMassProperties(body._hkBody, massProps);
                "expression statement",
            ],
        ],
        [
            "setPhysicsBodyMass",
            "two emitted sites restate the mass phase",
            [
                // const massProps = <shape-derived or isotropic fallback>;
                "variable statement",
                // massProps[1] = mass;
                "expression statement",
                // the optional centre-of-mass override (no reached caller passes one)
                "if statement",
                // body._massPropertiesTransform?.(massProps) -- installed only by
                // the unlowered `lockPhysicsBodyRotationAxes`, so a no-op here
                "expression statement",
                // hknp.HP_Body_SetMassProperties(body._hkBody, massProps);
                "expression statement",
            ],
        ],
    ];

    /**
     * The prelude's own declaration inventory, in the pin's order.
     *
     * The emitted builder assigns each term in that order, so every read
     * reaches a written field. A pin that reorders them, or adds one the
     * emitted struct has no lane for, fails here rather than emitting a
     * builder that reads an uninitialised one.
     */
    private assertShapeParamsPrelude(
        declaration: ts.FunctionDeclaration,
    ): void {
        this.context.assertStatementInventory(
            declaration,
            declaration.body!.statements,
            buildShapeParams,
            "the emitted builder restates each term in that order",
            [
                "params",
                ...PRELUDE_SCALARS.map(([pinned]) => pinned),
                "min",
                "max",
                "extents",
                // The two pre-switch overrides. `center` is emitted -- a capsule
                // or a cylinder carries an explicit centre from here even though
                // neither case states one -- and `rotation` is what the reached
                // slice refuses, so a pin that turned either into something other
                // than a guarded write has to be read again.
                "if (options.center)",
                "if (options.rotation)",
                "switch statement",
                "return statement",
            ],
            (statement: ts.Statement) =>
                ts.isVariableStatement(statement)
                    ? statement.declarationList.declarations
                          .map((entry) =>
                              ts.isIdentifier(entry.name)
                                  ? entry.name.text
                                  : "",
                          )
                          .join(", ")
                    : ts.isIfStatement(statement)
                      ? `if (${statement.expression.getText()})`
                      : ts.isSwitchStatement(statement)
                        ? "switch statement"
                        : statementKind(statement),
        );
    }

    public lowerPhysics(options: PhysicsLoweringOptions = {}): LoweredSource {
        this.assertPinnedContracts();
        const trigger = options.trigger === true;
        const floatingOrigin = options.floatingOrigin === true;
        const thin = options.thinInstances
            ? lowerPhysicsThinInstances(this.context, floatingOrigin)
            : undefined;
        const events = lowerPhysicsEvents(this.context, thin !== undefined);
        const afterStep = lowerPhysicsAfterStep(this.context);
        const collisionInfo = lowerPhysicsCollisionInfo(this.context);
        const massSetter = this.context.functionDeclaration(
            havokModule,
            "setPhysicsBodyMassProperties",
        ).declaration;
        this.context.assertStatementShapes(
            massSetter,
            massSetter.body!.statements,
            `
      const massProps = buildMassProperties(world, body);
      if (properties.centerOfMass) { massProps[0] = [properties.centerOfMass.x, properties.centerOfMass.y, properties.centerOfMass.z]; }
      if (properties.mass !== undefined) { massProps[1] = properties.mass; }
      if (properties.inertia) { massProps[2] = [properties.inertia.x, properties.inertia.y, properties.inertia.z]; }
      if (properties.inertiaOrientation) { massProps[3] = [properties.inertiaOrientation.x, properties.inertiaOrientation.y, properties.inertiaOrientation.z, properties.inertiaOrientation.w]; }
      body._massPropertiesTransform?.(massProps);
      world._hknp.HP_Body_SetMassProperties(body._hkBody, massProps);
    `,
            "physics mass override order, tuple slots and PAL write",
        );
        const removeBody = this.context.functionDeclaration(
            havokModule,
            "removePhysicsBody",
        ).declaration;
        this.context.assertStatementShapes(
            removeBody,
            removeBody.body!.statements,
            `
      const { _hknp: hknp, _hkWorld: hkWorld, _bodies: bodies } = world;
      const i = bodies.indexOf(body);
      if (i < 0) { return; }
      bodies.splice(i, 1);
      hknp.HP_World_RemoveBody(hkWorld, body._hkBody);
      if (!world._events?.remove(body)) { hknp.HP_Body_Release(body._hkBody); }
    `,
            "physics body removal and release order",
        );
        const queries = options.queries
            ? lowerPhysicsQueries(this.context)
            : undefined;
        const mesh = lowerPhysicsMesh(this.context);
        const container = options.container
            ? lowerPhysicsContainer(this.context)
            : undefined;
        const viewer = options.viewer
            ? lowerPhysicsViewer(this.context)
            : undefined;
        const constraints = options.constraints
            ? lowerPhysicsConstraints(this.context)
            : undefined;
        const gravitySetter = lowerPhysicsGravity(this.context, floatingOrigin);
        const heightfield = options.heightfield
            ? lowerPhysicsHeightfield(this.context)
            : undefined;
        const queryModule = "src/physics/havok-queries.ts";
        const raycast = this.context.functionDeclaration(
            queryModule,
            "physicsRaycast",
        );
        const distanceLowerer = new PinnedNumericLowerer(raycast.file, {
            bindings: new Map<string, PinnedBinding>([
                ["hitPos", { cpp: "hit.point", type: "f64-list" }],
                ["from", { cpp: "from", type: "vec3" }],
                ...["dx", "dy", "dz"].map(
                    (name) =>
                        [name, { cpp: name, type: "scalar" as const }] as const,
                ),
            ]),
            calls: pinnedNumericMathCalls(),
        });
        const distanceLocals = ["dx", "dy", "dz"]
            .map(
                (name) =>
                    `        const double ${name} = ${distanceLowerer.expression(this.context.variableInitializer(raycast.declaration, name))};`,
            )
            .join("\n");
        const distanceExpression = distanceLowerer.expression(
            this.context.propertyInitializer(
                this.context.returnObject(raycast.declaration),
                "hitDistance",
            ),
        );
        this.assertShapeContracts(
            (symbol) =>
                this.context.functionDeclaration(queryModule, symbol)
                    .declaration,
            [
                [
                    "physicsRaycast",
                    [
                        "findBodyById(world, hitData[0][0])",
                        "query.shouldHitTriggers ?? false",
                    ],
                ],
                [
                    "findBodyById",
                    ["world._bodies", "body._hkBody[0] === hitBodyId"],
                ],
            ],
        );

        const maxStepMs = this.maxStepMs();
        const floatingOriginRadius = this.floatingOriginRadius();
        const gravity = this.defaultGravity();
        const defaults = this.aggregateMaterialDefaults();
        const shapeTypes = this.enumMembers("PhysicsShapeType");
        const motionTypes = this.enumMembers("PhysicsMotionType");
        const prestepTypes = this.enumMembers("PhysicsPrestepType");
        const shapeParams = this.lowerShapeParams();
        const primitiveHandle = this.lowerPrimitiveShapeHandle();

        const enumeratorList = (members: Map<string, number>): string =>
            [...members]
                .map(([name, value]) => `    ${name} = ${value},`)
                .join("\n");

        const header = `// ${this.context.provenance(
            havokModule,
            "createHavokWorld",
            "the pin's own rigid-body semantics; the HP_* back end is " +
                "the PAL's",
        )}
#pragma once

#include <array>
#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <vector>
#include <unordered_map>

#include "bblite/js_data.hpp"
#include "bblite/pal_physics.hpp"
#include "bblite/runtime.hpp"

namespace bbl::upstream {

/** ${havokModule} \`PhysicsShapeType\`. */
enum class PhysicsShapeType : std::int32_t {
${enumeratorList(shapeTypes)}
};

/** ${havokModule} \`PhysicsMotionType\`. */
enum class PhysicsMotionType : std::int32_t {
${enumeratorList(motionTypes)}
};

/**
 * \`createPhysicsBody\`'s own mapping onto the back end's motion types.
 * Upstream does not pass its enum through either -- it maps
 * \`STATIC/ANIMATED/DYNAMIC\` onto \`hknp.MotionType.STATIC/KINEMATIC/
 * DYNAMIC\` -- so the mapping is Babylon behaviour and lives here rather
 * than in whichever solver is linked.
 */
[[nodiscard]] inline pal::PhysicsMotionType pinned_motion_type(
    PhysicsMotionType motion_type) {
    switch (motion_type) {
        case PhysicsMotionType::STATIC:
            return pal::PhysicsMotionType::immovable;
        case PhysicsMotionType::ANIMATED:
            return pal::PhysicsMotionType::node_driven;
        case PhysicsMotionType::DYNAMIC:
            return pal::PhysicsMotionType::simulated;
    }
    return pal::PhysicsMotionType::immovable;
}

/** ${havokModule} \`PhysicsPrestepType\`. */
enum class PhysicsPrestepType : std::int32_t {
${enumeratorList(prestepTypes)}
};

/**
 * \`MAX_STEP_MS\` -- the pin's tunnelling ceiling, read from its own
 * declaration. A long hitch otherwise hands the solver one huge dt.
 */
inline constexpr double physics_max_step_ms = ${this.context.doubleLiteral(
            maxStepMs,
        )};

/** \`createHavokWorld\`'s own \`gravity ?? { ... }\`. */
[[nodiscard]] inline Vec3d pinned_default_gravity() {
    return Vec3d{${gravity
        .map((component) => this.context.doubleLiteral(component))
        .join(", ")}};
}

/** \`createPhysicsAggregate\`'s \`options.friction ?? ...\`. */
inline constexpr double physics_default_friction = ${this.context.doubleLiteral(
            defaults.friction,
        )};
/** \`createPhysicsAggregate\`'s \`options.restitution ?? ...\`. */
inline constexpr double physics_default_restitution = ${this.context.doubleLiteral(
            defaults.restitution,
        )};

${
    floatingOrigin
        ? `/**
 * \`enableHavokFloatingOrigin\`'s own \`floatingOriginWorldRadius = ...\`,
 * read from that parameter rather than restated. The radius decides how far
 * a body travels before it is re-based, so a bump that moves it moves every
 * far-from-origin simulation.
 */
inline constexpr double pinned_floating_origin_radius = ${this.context.doubleLiteral(
              floatingOriginRadius,
          )};

`
        : ""
}/**
 * ${havokModule} \`PhysicsAggregateOptions\`, reached slice.
 *
 * The geometry half is laid out from the same table \`PhysicsShapeParameters\`
 * below is, and in the same order, because upstream declares the same five
 * members on both bags and \`_buildShapeParams\` resolves each aggregate one
 * as an explicit override of the bounds-derived value. The intrinsic fills
 * this positionally, so one table keeps the two in step.
 */
struct PhysicsAggregateOptions {
    double mass = 0.0;
    js::Nullable<double> friction{};
    js::Nullable<double> restitution{};
    pal::PhysicsShapeHandle shape{};
${shapeParameterLanes("options")}
    /**
     * \`createPhysicsBody(world, node, motionType, options.startAsleep)\`,
     * whose parameter defaults to \`false\` -- so an omitted option is that
     * default rather than a nullable this factory settles again.
     */
    bool start_asleep = false;
};

/**
 * ${havokModule} \`PhysicsMassProperties\`, reached slice.
 *
 * Each member overrides one term of what the shape derives, so an absent
 * lane keeps the derived one -- the pin's own \`if (properties.x)\` arms.
 *
 * Inertia overrides are per unit mass in the pin and converted to the
 * PAL's absolute tensor. An absent mass uses the solver's default density.
 */
struct PhysicsMassPropertyOverrides {
    js::Nullable<Vec3d> center_of_mass{};
    js::Nullable<double> mass{};
    js::Nullable<Vec3d> inertia{};
};

/**
 * ${havokModule} \`PhysicsShapeParameters\`, reached slice.
 *
 * The bag \`createPrimitivePhysicsShapeHandle\` reads. Every member is
 * optional upstream and every arm defaults its own, so an absent lane here
 * is the pin's \`undefined\` rather than a value this port settled.
 */
struct PhysicsShapeParameters {
${shapeParameterLanes("params")}
};

/**
 * ${havokModule} \`PhysicsShape\`. The pin's \`_type\` is dropped: it is read
 * only by the mesh-shape arms, which refuse at generation.
 */
struct PhysicsShape {
    pal::PhysicsShapeHandle handle{};
};

/**
 * The node a body follows, which is the pin's \`SceneNode\` -- a mesh or a
 * plain transform node.
 *
 * Upstream has one node type and reads \`node.position\` /
 * \`node.rotationQuaternion\` off it. This port keeps meshes and transform
 * nodes in separate arenas, so a body records which arena its handle
 * addresses; \`sync_node_to_body\` and \`sync_body_to_node\` then read and
 * write the same two properties on either. A trigger volume is the reached
 * case: scene 101 hangs one off a bare \`createTransformNode\`.
 */
using PhysicsNodeRef = std::variant<MeshHandle, TransformNodeHandle>;

[[nodiscard]] std::array<float, 16> physics_node_world(const Engine& engine, PhysicsNodeRef node);

[[nodiscard]] inline PhysicsNodeRef physics_node(MeshHandle mesh) {
    return mesh;
}

[[nodiscard]] inline PhysicsNodeRef physics_node(TransformNodeHandle node) {
    return node;
}

/**
 * ${havokModule} \`PhysicsBody\`, trimmed to the reached slice the way
 * \`PhysicsAggregateOptions\` above it is. The pin's \`_shape\` is held only
 * so \`setPhysicsBodyMass\` can branch on it, and that branch runs while the
 * aggregate is still building, so it is a local there rather than a field.
 */
struct PhysicsWorld;
${floatingOrigin ? floatingOriginForwardDeclaration : ""}
struct PhysicsBody {
    pal::PhysicsBodyHandle handle{};
    // Copies carry the same pinned object identity even after its live fields change.
    [[nodiscard]] bool operator==(const PhysicsBody& other) const noexcept {
        return handle.value == other.handle.value;
    }
    std::weak_ptr<PhysicsWorld> owner;
    PhysicsNodeRef node{};
    PhysicsShape shape{};
    PhysicsMotionType motion_type = PhysicsMotionType::STATIC;
    PhysicsPrestepType prestep_type = PhysicsPrestepType::TELEPORT;
    bool pre_step = false;
${
    floatingOrigin
        ? `    /**
     * ${havokFloatingOriginModule} \`_region\`: the region this body is
     * simulated in, and therefore the frame its stored transform is in.
     * Null until a floating-origin world places it, which is what the pin's
     * own optional \`WorldRegion\` reference means.
     */
    std::shared_ptr<PhysicsRegion> region{};
`
        : ""
}};

${thin?.state ?? ""}
/** ${havokModule} \`PhysicsAggregate\`. */
struct PhysicsAggregate {
    PhysicsBody body{};
    PhysicsShape shape{};
};

enum class PhysicsCollisionType {
    STARTED,
    CONTINUED,
    FINISHED,
};

struct PhysicsCollisionInfo {
    PhysicsCollisionType type = PhysicsCollisionType::FINISHED;
    Vec3d point{};
    Vec3d normal{};
    double impulse = 0.0;
    PhysicsBody collider{};
    double collider_index = 0.0;
    PhysicsBody collided_against{};
    double collided_against_index = 0.0;
    double distance = 0.0;
};

[[nodiscard]] const char* physics_collision_type_name(
    PhysicsCollisionType type);

${
    trigger
        ? `/** ${havokTriggerModule} \`PhysicsTriggerInfo["type"]\`. */
enum class PhysicsTriggerType {
    ENTERED,
    EXITED,
};

/**
 * ${havokTriggerModule} \`PhysicsTriggerInfo\`.
 *
 * One member, because the pin's own interface has one. Its
 * \`PhysicsTriggerBodyInfo\` extension resolves the two participating
 * bodies from the back end's event, and \`onPhysicsTriggerBodies\` -- the
 * only thing that reads them -- is not reached.
 */
struct PhysicsTriggerInfo {
    PhysicsTriggerType type = PhysicsTriggerType::ENTERED;
};

[[nodiscard]] const char* physics_trigger_type_name(
    PhysicsTriggerType type);

`
        : ""
}struct PhysicsRaycastResult {
    bool has_hit = false;
    Vec3d hit_point{};
    Vec3d hit_normal{};
    double hit_distance = 0.0;
    js::Nullable<PhysicsBody> body{};
    double body_index = -1.0;
};

${
    floatingOrigin
        ? `${floatingOriginStructs(this.context)}
`
        : ""
}/**
 * ${havokModule} \`PhysicsWorld\`. The pin keeps \`_hknp\` beside
 * \`_hkWorld\`; here the module is the PAL and only the world handle
 * travels.
 */
struct PhysicsEventState {
    bool draining = false;
    std::optional<std::vector<PhysicsBody>> removed;
};
struct PhysicsWorld {
    ~PhysicsWorld();
    pal::PhysicsWorldHandle handle{};
    Engine* engine = nullptr;
    /**
     * \`_scene\`. \`worldStepSeconds\` reads the scene's own fixed step
     * live, so the world keeps the scene rather than a copy of the value:
     * a scene may write \`fixedDeltaMs\` after the world exists, and the
     * pin would see that write.
     */
    std::shared_ptr<Scene> scene;
    std::vector<PhysicsBody> bodies;
    std::optional<PhysicsEventState> events;
${
    thin
        ? `    bool thin_enabled = false;
    std::unordered_map<std::uint32_t, ThinPhysicsState> thin_states;
`
        : ""
}
    /**
     * \`_fixedDeltaMs\`: the world's own step, independent of the scene.
     * Stays at the pin's own default because the only things that write it
     * -- \`setPhysicsTimestep\` and \`setPhysicsTimestepMs\` -- are outside
     * the reached slice, so the gate below takes its \`deltaMs\` arm exactly
     * as the pin's does. The field is the pin's state, not dead weight: it
     * is what the gate reads.
     */
    double fixed_delta_ms = 0.0;
    /**
     * \`scene.surface.engine._currentDelta\`, the last delta the renderer
     * handed this scene's before-render list. The engine record carries no
     * such field here, and the step callback is where that number arrives,
     * so it is recorded at the step and read by \`world_step_seconds\` as
     * the pin's third arm. Zero before the first frame, which is the state
     * the pin documents on that arm.
     */
    double engine_delta_ms = 0.0;
    std::vector<std::function<void(float)>> after_step;
    /**
     * \`_gravity\`, the world-wide vector set at creation. The pin keeps it
     * for one reader: it is what seeds a floating-origin region.
     */
    std::array<double, 3> gravity{};
${
    floatingOrigin
        ? `    /**
     * \`_fo\`, present only after \`enableHavokFloatingOrigin\`. The pin's
     * own optional field, and the same opt-in: everything that branches on
     * it below takes its absent arm for every ordinary near-origin scene.
     */
    std::optional<PhysicsFloatingOrigin> fo{};
`
        : ""
}};

/**
 * A world is engine-owned state addressed by a typed handle, like every
 * other record here. The scene binds what \`createHavokWorld\` returned with
 * \`auto\`, so a reference would be copied at the binding and the bodies a
 * later \`createPhysicsAggregate\` appends would land on the copy while the
 * step closure kept stepping the original -- a world that simulates and
 * never moves a mesh.
 */
struct PhysicsWorldHandle {
    std::uint32_t value = 0;
    std::weak_ptr<PhysicsWorld> ownership;
};

[[nodiscard]] PhysicsWorldHandle create_havok_world(
    Scene& scene,
    Vec3d gravity);
struct PhysicsBodyInstance { PhysicsBody body; pal::PhysicsBodyHandle handle; double index{}; };
${
    thin
        ? `
std::optional<PhysicsBodyInstance> resolve_physics_thin_instance(PhysicsWorldHandle world, double native_id);
std::optional<Vec3d> physics_thin_center(PhysicsWorldHandle world, PhysicsBody body, pal::PhysicsBodyHandle native_body, const std::array<double, 3>& local_center);
std::optional<std::vector<float>> physics_thin_world_matrix(PhysicsWorldHandle world, PhysicsBody body, pal::PhysicsBodyHandle native_body);
void enable_havok_thin_instance_physics(PhysicsWorldHandle world);
`
        : ""
}double get_physics_body_instance_count(PhysicsBody body);
${
    floatingOrigin
        ? `void enable_havok_floating_origin(
    PhysicsWorldHandle world,
    double floating_origin_world_radius);
`
        : ""
}void on_physics_after_step(
    PhysicsWorldHandle world,
    std::function<void(float)> callback);
void set_physics_timestep_ms(
    PhysicsWorldHandle world,
    double fixed_delta_ms);
PhysicsShape create_physics_mesh_shape(
    PhysicsWorldHandle world,
    PhysicsShapeType type,
    PhysicsNodeRef mesh,
    bool include_child_meshes);
[[nodiscard]] PhysicsShape create_physics_primitive_shape(
    PhysicsWorldHandle world,
    PhysicsShapeType type,
    const PhysicsShapeParameters& parameters);
${container?.header ?? ""}${
            trigger
                ? `void set_physics_shape_is_trigger(
    PhysicsWorldHandle world,
    PhysicsShape shape,
    bool is_trigger);
`
                : ""
        }[[nodiscard]] PhysicsBody create_physics_body(
    PhysicsWorldHandle world,
    PhysicsNodeRef node,
    PhysicsMotionType motion_type,
    bool starts_asleep);
void set_physics_body_shape(
    PhysicsWorldHandle world,
    PhysicsBody body,
    PhysicsShape shape);
${
    trigger
        ? `void on_physics_trigger(
    PhysicsWorldHandle world,
    std::function<void(const PhysicsTriggerInfo&)> callback);
`
        : ""
}PhysicsAggregate create_physics_aggregate(
    PhysicsWorldHandle world,
    MeshHandle mesh,
    PhysicsShapeType type,
    const PhysicsAggregateOptions& options);
void set_physics_body_motion_type(
    PhysicsWorldHandle world,
    PhysicsBody body,
    PhysicsMotionType motion_type);
void set_physics_body_mass(
    PhysicsWorldHandle world,
    PhysicsBody body,
    double mass);
void set_physics_body_mass_properties(
    PhysicsWorldHandle world,
    PhysicsBody body,
    const PhysicsMassPropertyOverrides& properties);
[[nodiscard]] PhysicsWorld& physics_world_state(const PhysicsWorldHandle& world);
[[nodiscard]] PhysicsBody& owning_body_record(const PhysicsBody& body);
[[nodiscard]] double physics_world_step_seconds(PhysicsWorldHandle world);
[[nodiscard]] std::string physics_body_node_name(PhysicsBody body);
void remove_physics_body(PhysicsWorldHandle world, PhysicsBody body);
void set_physics_shape_material(
    PhysicsWorldHandle world,
    PhysicsShape shape,
    double friction,
    double restitution,
    js::Nullable<double> static_friction);
void set_physics_body_pre_step(
    PhysicsBody body,
    bool enabled);
void set_physics_body_prestep_type(
    PhysicsBody body,
    PhysicsPrestepType type);
void apply_physics_impulse(
    PhysicsWorldHandle world,
    PhysicsBody body,
    Vec3d impulse,
    std::optional<Vec3d> point);
void set_physics_shape_filter_membership_mask(
    PhysicsWorldHandle world,
    PhysicsShape shape,
    std::uint32_t membership_mask);
void set_physics_shape_filter_collide_mask(
    PhysicsWorldHandle world,
    PhysicsShape shape,
    std::uint32_t collide_mask);
[[nodiscard]] Vec3d get_physics_body_linear_velocity(
    PhysicsWorldHandle world,
    PhysicsBody body);
void apply_physics_body_force(
    PhysicsWorldHandle world,
    PhysicsBody body,
    Vec3d force,
    Vec3d location);
void set_physics_body_collision_events_enabled(
    PhysicsWorldHandle world,
    PhysicsBody body,
    bool enabled);
void on_physics_collision(
    PhysicsWorldHandle world,
    std::function<void(const PhysicsCollisionInfo&)> callback);
[[nodiscard]] PhysicsRaycastResult physics_raycast(
    PhysicsWorldHandle world,
    Vec3d from,
    Vec3d to,
    std::uint32_t membership,
    std::uint32_t collide_with,
    bool should_hit_triggers);

${queries?.header ?? ""}
${viewer?.header ?? ""}
${constraints?.header ?? ""}
${heightfield?.header ?? ""}
${gravitySetter.header}
}  // namespace bbl::upstream

namespace bbl::js {
template <>
struct ValueHash<upstream::PhysicsBody> {
    [[nodiscard]] std::size_t operator()(const upstream::PhysicsBody& body) const noexcept {
        return std::hash<std::uint32_t>{}(body.handle.value);
    }
};
} // namespace bbl::js
`;

        const source = `// ${this.context.provenance(havokModule, "_stepWorld")}
#include "bblite/upstream/physics.hpp"
#include "bblite/upstream/renderer_plan.hpp"
#include <bblite/upstream/pinned_matrix.hpp>
${viewer ? "#include <bblite/pal_physics_debug.hpp>" : ""}

#include <algorithm>
#include <cstddef>
#include <ranges>
#include <stdexcept>
${floatingOrigin ? "#include <unordered_set>\n" : ""}#include <utility>

namespace bbl::upstream {
namespace {

${mesh.helpers}
${container?.helpers ?? ""}

PhysicsWorld& physics_world_record(const PhysicsWorldHandle& handle) {
    const auto world = handle.ownership.lock();
    if (!world || world->handle.value != handle.value) {
        throw std::runtime_error("Physics world has no live engine owner.");
    }
    return *world;
}

/**
 * The pin's \`mesh.boundMin\` / \`mesh.boundMax\`. \`mesh-factories.ts\`
 * fills them from \`computeAabb(positions)\` over the generated vertices,
 * which is the same box the generated factories already record on the
 * geometry -- so the physics shape is sized from the geometry the renderer
 * draws rather than from a second derivation. Scene code may replace either
 * public bound after the factory created it; those object-local overrides
 * replace the corresponding geometry side here just as they do during
 * default-camera framing. A mesh with no geometry has no box, exactly as the
 * pin's optional pair is absent, and each helper falls back to the pin's own
 * literal.
 */
struct MeshBounds {
    bool present = false;
    Vec3 minimum{};
    Vec3 maximum{};
};

MeshBounds mesh_bounds(const Engine& engine, const MeshRecord& mesh) {
    if (mesh.geometry >= engine.geometries.size()) {
        return MeshBounds{};
    }
    const ModelGeometry& geometry = engine.geometries[mesh.geometry];
    MeshBounds bounds{true, geometry.bounds_min, geometry.bounds_max};
    apply_mesh_bound_overrides(mesh, bounds.minimum, bounds.maximum);
    return bounds;
}

// ${this.context.provenance(
            havokModule,
            buildShapeParams,
            "typed-array reads specialized onto MeshBounds",
        )}
${shapeParams}

// ${this.context.provenance(havokModule, primitiveShapeHandle)}
${primitiveHandle}

/**
 * \`node.position\` and \`node.rotationQuaternion\`, on whichever arena the
 * body's node lives in. Both records carry the same two properties, so the
 * pin's one node type is one accessor here as well.
 */
struct PhysicsNodePose {
    Vec3d position{};
    Vec4 rotation{0.0f, 0.0f, 0.0f, 1.0f};
};

[[nodiscard]] PhysicsNodePose physics_node_pose(
    const Engine& engine,
    PhysicsNodeRef node) {
    if (const auto* transform_node = std::get_if<TransformNodeHandle>(&node)) {
        const TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "*transform_node")};
        return PhysicsNodePose{record.position, record.rotation_quaternion};
    }
    const MeshRecord& mesh = ${recordAt("engine.meshes", "std::get<MeshHandle>(node)")};
    return PhysicsNodePose{mesh.position, mesh.rotation_quaternion};
}

/**
 * Whether the node a body follows still has its record. The pin keeps
 * syncing a body with a mesh \`removeFromScene\` disposed; once a later
 * mesh took that mesh's slot nothing composes under it, nothing can move it
 * and the body teleported to its pose last step, so both directions of the
 * sync skip it (\`current_mesh_record\`).
 */
[[nodiscard]] bool physics_node_current(const Engine& engine, const PhysicsNodeRef& node) {
    const auto* mesh = std::get_if<MeshHandle>(&node);
    return !mesh || current_mesh_record(engine, *mesh) != nullptr;
}

/**
 * The pin's \`node.position.set(...)\` / \`node.rotationQuaternion.set(...)\`
 * pair, on whichever arena the body's node lives in.
 *
 * Upstream states that pair twice -- once in \`havok.ts\`'s
 * \`_syncBodyToNode\` and once in the floating-origin module's, which
 * differ only in the origin they add back -- so the two writers below state
 * the pin's own difference and share the arena dispatch, which is this
 * port's and not the pin's.
 */
void write_node_pose(
    Engine& engine,
    PhysicsNodeRef node,
    Vec3d position,
    Vec4 rotation) {
    if (const auto* transform_node = std::get_if<TransformNodeHandle>(&node)) {
        TransformNodeRecord& record = ${recordAt("engine.transform_nodes", "*transform_node")};
        record.position = position;
        record.rotation_quaternion = rotation;
        record.has_rotation_quaternion = true;
        mark_transform_node_dirty(engine, *transform_node);
        return;
    }
    const MeshHandle handle = std::get<MeshHandle>(node);
    MeshRecord& mesh = ${recordAt("engine.meshes", "handle")};
    mesh.position = position;
    mesh.rotation_quaternion = rotation;
    mesh.has_rotation_quaternion = true;
    mark_mesh_dirty(engine, handle);
}

/** The quaternion half both sync directions read out of a transform. */
[[nodiscard]] Vec4 transform_rotation(const pal::PhysicsTransform& t) {
    return Vec4{
        static_cast<float>(t.rotation[0]),
        static_cast<float>(t.rotation[1]),
        static_cast<float>(t.rotation[2]),
        static_cast<float>(t.rotation[3]),
    };
}

/** \`_syncBodyToNode\`: the integrated pose written back onto the node. */
${thin?.helpers ?? ""}
void physics_release_native_body([[maybe_unused]] PhysicsWorld& world, pal::PhysicsBodyHandle handle) {
${
    thin
        ? `    thin_for_each(world, handle, [](auto native) { pal::physics_body_release(native); });
    world.thin_states.erase(handle.value);`
        : `    pal::physics_body_release(handle);`
}
}
${events}
${afterStep}
void sync_body_to_node(Engine& engine, const PhysicsBody& body) {
    if (!physics_node_current(engine, body.node)) return;
${
    thin
        ? `    if (thin_from(*body.owner.lock(), body)) return;
`
        : ""
}
    const pal::PhysicsTransform transform =
        pal::physics_body_get_transform(body.handle);
    write_node_pose(
        engine,
        body.node,
        Vec3d{
            transform.position[0],
            transform.position[1],
            transform.position[2],
        },
        transform_rotation(transform));
}

/** \`_syncNodeToBody\` / \`_syncNodeToBodyTarget\`. */
void sync_node_to_body(
    const Engine& engine,
    const PhysicsBody& body,
    bool as_target) {
    if (!physics_node_current(engine, body.node)) return;
${
    thin
        ? `    auto& world = *body.owner.lock();
    if (as_target ? thin_target(world, body) : thin_to(world, body)) return;
`
        : ""
}
    const PhysicsNodePose pose = physics_node_pose(engine, body.node);
    const pal::PhysicsTransform transform{
        {pose.position.x, pose.position.y, pose.position.z},
        {pose.rotation.x, pose.rotation.y,
         pose.rotation.z, pose.rotation.w},
    };
    if (as_target) {
        pal::physics_body_set_target_transform(body.handle, transform);
    } else {
        pal::physics_body_set_transform(body.handle, transform);
    }
}

${
    floatingOrigin
        ? `${floatingOriginNodeSettersCpp}

${floatingOriginFunctionsCpp(this.context, motionTypes)}

`
        : ""
}/**
 * \`worldStepSeconds\`. The effective step every physics caller agrees on,
 * derived live from the same three sources the pin reads in the same
 * order -- the world's own fixed step, then the scene's, then the
 * engine's last delta -- under the pin's finite/positive gate and
 * MAX_STEP_MS clamp. It is derived rather than remembered because a
 * caller can reach it before the first step, which is exactly where a
 * remembered step is still zero and the scene's own fixed delta is not.
 */
[[nodiscard]] double world_step_seconds(const PhysicsWorld& world) {
    const double step_ms =
        world.fixed_delta_ms > 0.0
            ? world.fixed_delta_ms
            : (world.scene != nullptr && world.scene->fixed_delta_ms > 0.0
                   ? world.scene->fixed_delta_ms
                   : world.engine_delta_ms);
    if (!std::isfinite(step_ms) || step_ms <= 0.0) {
        return 0.0;
    }
    return std::min(step_ms, physics_max_step_ms) / 1000.0;
}

/**
 * \`_stepWorld\`. The gate, the clamp and the four phases are the pinned
 * module's, and generation fails if any of them moves: the lowerer's
 * \`shapeContracts\` row for _stepWorld holds the three expressions, its
 * \`orderContracts\` row holds the phase order, and its
 * \`inventoryContracts\` row holds the statement count that would
 * otherwise hide an added arm.
 */
void step_world(PhysicsWorld& world, double delta_ms) {
    const double step_ms =
        world.fixed_delta_ms > 0.0 ? world.fixed_delta_ms : delta_ms;
    if (!std::isfinite(step_ms) || step_ms <= 0.0) {
        return;
    }
    const double dt = std::min(step_ms, physics_max_step_ms) / 1000.0;
    // Not the pin's: the engine record carries no _currentDelta, and this
    // is where the renderer's delta reaches the physics layer. Recorded
    // raw, so world_step_seconds applies the pin's own gate and clamp to
    // it rather than reading a number that already went through them.
    // Written ahead of the floating-origin arm because that arm RETURNS
    // and world_step_seconds reads this either way.
    world.engine_delta_ms = delta_ms;
${
    floatingOrigin
        ? `
    if (world.fo) {
        fo_step_world(world, dt);
        return;
    }
`
        : ""
}
    Engine& engine = *world.engine;
    for (const PhysicsBody& body : world.bodies) {
        if (body.prestep_type != PhysicsPrestepType::DISABLED &&
            (body.motion_type == PhysicsMotionType::ANIMATED ||
             body.pre_step)) {
            sync_node_to_body(
                engine,
                body,
                body.prestep_type == PhysicsPrestepType::ACTION);
        }
    }

    pal::physics_world_step(world.handle, dt);

    for (const PhysicsBody& body : world.bodies) {
        if (body.motion_type == PhysicsMotionType::DYNAMIC) {
            sync_body_to_node(engine, body);
        }
    }

    physics_dispatch_after_step(world, dt);
}

}  // namespace

PhysicsWorld::~PhysicsWorld() {
    if (events) physics_events_dispose(*this, *events);
${
    floatingOrigin
        ? `    if (fo) {
        for (const auto& region : fo->regions) {
            if (region->_world.value != handle.value) {
                pal::physics_world_release(region->_world);
            }
        }
    }
`
        : ""
}    if (handle.value != 0) pal::physics_world_release(handle);
}

PhysicsWorldHandle create_havok_world(Scene& scene, Vec3d gravity) {
    if (!scene.engine) throw std::runtime_error("Physics requires a scene engine.");
    auto owned = std::make_shared<PhysicsWorld>();
    PhysicsWorld& world = *owned;
    world.handle = pal::physics_world_create();
    world.engine = scene.engine;
    world.scene = std::make_shared<Scene>(scene);
    // \`_gravity: [g.x, g.y, g.z]\`, kept for the one reader the pin keeps
    // it for: a floating-origin region is seeded from it.
    world.gravity = {gravity.x, gravity.y, gravity.z};
    pal::physics_world_set_gravity(world.handle, world.gravity);
    const PhysicsWorldHandle handle{world.handle.value, owned};
    scene.engine->native_resource_owners.push_back(std::move(owned));

    // \`scene._beforeRender.unshift(stepCb)\`: physics integrates before
    // every other before-render callback, so a scene reading a pose in one
    // reads this frame's rather than the previous frame's.
    try {
        scene.before_render.insert(
            scene.before_render.begin(),
            [handle](float delta_ms) {
                if (const auto live = handle.ownership.lock()) {
                    step_world(*live, static_cast<double>(delta_ms));
                }
            });
    } catch (...) {
        scene.engine->native_resource_owners.pop_back();
        throw;
    }
    return handle;
}

${
    floatingOrigin
        ? `${enableFloatingOriginCpp(this.context, motionTypes)}

`
        : ""
}void on_physics_after_step(
    PhysicsWorldHandle handle,
    std::function<void(float)> callback) {
    physics_world_record(handle).after_step.push_back(
        std::move(callback));
}

void set_physics_timestep_ms(
    PhysicsWorldHandle handle,
    double fixed_delta_ms) {
    // setPhysicsTimestepMs is exactly this state write; step_world owns the
    // finite/positive gate and MAX_STEP_MS clamp when it consumes it.
    physics_world_record(handle).fixed_delta_ms = fixed_delta_ms;
}

${mesh.source}
${container?.source ?? ""}PhysicsShape create_physics_primitive_shape(
    PhysicsWorldHandle handle,
    PhysicsShapeType type,
    const PhysicsShapeParameters& parameters) {
    // \`createPhysicsShape\`: the primitive factory first, and a type it
    // answers nothing for falls through to the mesh, container and
    // convex-hull arms -- which are reached by their own entry point, so
    // one arriving here is the pin's \`Unsupported shape type\` throw.
    // The world is read for the same reason the pin destructures it: a
    // shape belongs to a live world, and a dead handle fails here.
    static_cast<void>(physics_world_record(handle));
    const std::optional<pal::PhysicsShapeHandle> primitive =
        primitive_physics_shape_handle(type, parameters);
    if (!primitive) {
        throw std::runtime_error(
            "createPhysicsShape reached a non-primitive shape type "
            "through its parameter bag.");
    }
    return PhysicsShape{*primitive};
}

${
    trigger
        ? `void set_physics_shape_is_trigger(
    PhysicsWorldHandle handle,
    PhysicsShape shape,
    bool is_trigger) {
    // \`setPhysicsShapeIsTrigger\` is exactly this one back-end write,
    // reached through the world the pin reads it from.
    static_cast<void>(physics_world_record(handle));
    pal::physics_shape_set_trigger(shape.handle, is_trigger);
}

`
        : ""
}PhysicsBody& physics_body_record(
    PhysicsWorld& world,
    const PhysicsBody& body) {
    const auto found = std::find_if(
        world.bodies.begin(),
        world.bodies.end(),
        [value = body.handle.value](const PhysicsBody& candidate) {
            return candidate.handle.value == value;
        });
    if (found == world.bodies.end()) {
        throw std::runtime_error(
            "Physics body is not part of this world.");
    }
    return *found;
}

void set_physics_body_motion_type(
    PhysicsWorldHandle handle,
    PhysicsBody body,
    PhysicsMotionType motion_type) {
    PhysicsWorld& world = physics_world_record(handle);
    PhysicsBody& live = physics_body_record(world, body);
${
    thin
        ? `    thin_for_each(world, live.handle, [&](auto native_handle) {
        pal::physics_body_set_motion_type(native_handle, pinned_motion_type(motion_type));
    });`
        : `    pal::physics_body_set_motion_type(live.handle, pinned_motion_type(motion_type));`
}
    live.motion_type = motion_type;
}

void set_physics_body_mass(
    PhysicsWorldHandle handle,
    PhysicsBody body,
    double mass) {
    PhysicsWorld& world = physics_world_record(handle);
    PhysicsBody& live = physics_body_record(world, body);
    pal::PhysicsMassProperties properties =
        pal::physics_shape_build_mass_properties(
            live.shape.handle, mass);
    // setPhysicsBodyMass preserves the shape-derived tensor and overrides
    // only the mass scalar.
    properties.mass = mass;
${
    thin
        ? `    thin_for_each(world, live.handle, [&](auto native_handle) {
        pal::physics_body_set_mass_properties(native_handle, properties);
    });`
        : `    pal::physics_body_set_mass_properties(live.handle, properties);`
}
}

void set_physics_body_mass_properties(
    PhysicsWorldHandle handle,
    PhysicsBody body,
    const PhysicsMassPropertyOverrides& overrides) {
    PhysicsWorld& world = physics_world_record(handle);
    PhysicsBody& live = physics_body_record(world, body);
    // \`buildMassProperties\`: the shape's own centre, tensor and
    // principal-axis frame, which every override below replaces one term
    // of. The mass reaches the build because Bullet derives a tensor from
    // a mass where Havok derives one from a density and scales its own
    // per-unit-mass term by the mass scalar afterwards -- the same
    // absolute tensor, asked for the other way round.
    const double mass = overrides.mass ? *overrides.mass : pal::physics_shape_default_mass(live.shape.handle);
    pal::PhysicsMassProperties properties =
        pal::physics_shape_build_mass_properties(
            live.shape.handle, mass);
    properties.mass = mass;
    if (overrides.center_of_mass) {
        const Vec3d& center = *overrides.center_of_mass;
        properties.center_of_mass = {center.x, center.y, center.z};
    }
    if (overrides.inertia) {
        const Vec3d& inertia = *overrides.inertia;
        properties.inertia = {inertia.x * mass, inertia.y * mass, inertia.z * mass};
    }
${
    thin
        ? `    thin_for_each(world, live.handle, [&](auto native_handle) {
        pal::physics_body_set_mass_properties(native_handle, properties);
    });`
        : `    pal::physics_body_set_mass_properties(live.handle, properties);`
}
}

void set_physics_shape_material(
    PhysicsWorldHandle handle,
    PhysicsShape shape,
    double friction,
    double restitution,
    js::Nullable<double> static_friction) {
    // The world is read for the same reason the pin destructures it: a
    // shape belongs to a live world, and a dead handle fails here.
    static_cast<void>(physics_world_record(handle));
    // The pin's own \`staticFriction = friction\` parameter default, and its
    // combine mode per channel -- which travels as data rather than being
    // re-decided by the linked solver.
    pal::physics_shape_set_material(
        shape.handle,
        pal::PhysicsShapeMaterial{
            static_friction ? *static_friction : friction,
            friction,
            restitution,
            pal::PhysicsMaterialCombine::minimum,
            pal::PhysicsMaterialCombine::maximum,
        });
}

/**
 * The live record for a body whose world the caller was not handed.
 *
 * The two pre-step setters take \`(body, ...)\` and no world, because the
 * pin reaches it through \`body._world\`. The value a scene holds here is a
 * copy, so the owning world is the one holding a record with the same PAL
 * handle -- the same identity \`physics_body_record\` matches on.
 */
PhysicsBody& owning_body_record(const PhysicsBody& body) {
    if (const auto world = body.owner.lock()) {
        return physics_body_record(*world, body);
    }
    throw std::runtime_error("Physics body has no live engine owner.");
}

PhysicsWorld& physics_world_state(const PhysicsWorldHandle& handle) { return physics_world_record(handle); }
${
    thin
        ? `std::optional<PhysicsBodyInstance> resolve_physics_thin_instance(PhysicsWorldHandle world, double native_id) { return thin_resolve(physics_world_record(world), native_id); }
std::optional<Vec3d> physics_thin_center(PhysicsWorldHandle world, PhysicsBody body, pal::PhysicsBodyHandle native_body, const std::array<double, 3>& local_center) { return thin_com(physics_world_record(world), body, native_body, local_center); }
std::optional<std::vector<float>> physics_thin_world_matrix(PhysicsWorldHandle world, PhysicsBody body, pal::PhysicsBodyHandle native_body) { return thin_matrix(physics_world_record(world), body, native_body); }
void enable_havok_thin_instance_physics(PhysicsWorldHandle handle) { physics_world_record(handle).thin_enabled = true; }
`
        : ""
}double get_physics_body_instance_count(PhysicsBody body) {
${
    thin
        ? `    auto& world = *body.owner.lock();
    if (auto* state = thin_state(world, body.handle)) return static_cast<double>(state->handles.size());
`
        : `    static_cast<void>(body);
`
}    return 1.0;
}
double physics_world_step_seconds(PhysicsWorldHandle handle) { return world_step_seconds(physics_world_record(handle)); }
std::string physics_body_node_name(PhysicsBody body) {
    const auto& live = owning_body_record(body);
    const auto& engine = *live.owner.lock()->engine;
    return std::visit([&engine](const auto& node) -> std::string {
        if constexpr (std::is_same_v<std::decay_t<decltype(node)>, MeshHandle>)
            return ${recordAt("engine.meshes", "node")}.name;
        else
            return ${recordAt("engine.transform_nodes", "node")}.name;
    }, live.node);
}
void remove_physics_body(PhysicsWorldHandle handle, PhysicsBody body) {
    auto& world = physics_world_record(handle);
    const auto found = std::find(world.bodies.begin(), world.bodies.end(), body);
    if (found == world.bodies.end()) return;
    world.bodies.erase(found);
${
    thin
        ? `    thin_for_each(world, body.handle, [&](auto native_handle) {
        pal::physics_world_remove_body(world.handle, native_handle);
    });`
        : `    pal::physics_world_remove_body(world.handle, body.handle);`
}
    if (!world.events || !physics_events_remove(world, *world.events, body)) physics_release_native_body(world, body.handle);
}

/**
 * \`setPhysicsBodyPreStep\`: one write of \`body._preStep\`, which
 * \`_stepWorld\`'s pre-step gate reads.
 */
void set_physics_body_pre_step(PhysicsBody body, bool enabled) {
    owning_body_record(body).pre_step = enabled;
}

/**
 * \`setPhysicsBodyPrestepType\`: the type write and the pin's own
 * \`if (type !== DISABLED) body._preStep = true\`, which is why a scene that
 * names a type never has to call \`setPhysicsBodyPreStep\` beside it.
 */
void set_physics_body_prestep_type(
    PhysicsBody body,
    PhysicsPrestepType type) {
    PhysicsBody& live = owning_body_record(body);
    live.prestep_type = type;
    if (type != PhysicsPrestepType::DISABLED) {
        live.pre_step = true;
    }
}

void apply_physics_impulse(
    PhysicsWorldHandle handle,
    PhysicsBody body,
    Vec3d impulse,
    std::optional<Vec3d> point) {
    PhysicsWorld& world = physics_world_record(handle);
    PhysicsBody& live = physics_body_record(world, body);
${thin ? `    thin_for_each(world, live.handle, [&](auto native_handle) {` : ""}
    Vec3d location{};
    if (point) {
        location = *point;
    } else {
        const pal::PhysicsTransform transform =
            pal::physics_body_get_transform(${thin ? "native_handle" : "live.handle"});
        location = Vec3d{
            transform.position[0],
            transform.position[1],
            transform.position[2],
        };
    }
    pal::physics_body_apply_impulse(
        ${thin ? "native_handle" : "live.handle"},
        {location.x, location.y, location.z},
        {impulse.x, impulse.y, impulse.z});
${thin ? `    });` : ""}
}

void set_physics_shape_filter_membership_mask(
    PhysicsWorldHandle handle,
    PhysicsShape shape,
    std::uint32_t membership_mask) {
    (void)physics_world_record(handle);
    pal::physics_shape_set_filter_membership_mask(
        shape.handle, membership_mask);
}

void set_physics_shape_filter_collide_mask(
    PhysicsWorldHandle handle,
    PhysicsShape shape,
    std::uint32_t collide_mask) {
    (void)physics_world_record(handle);
    pal::physics_shape_set_filter_collide_mask(
        shape.handle, collide_mask);
}

Vec3d get_physics_body_linear_velocity(
    PhysicsWorldHandle handle,
    PhysicsBody body) {
    PhysicsWorld& world = physics_world_record(handle);
    const PhysicsBody& live = physics_body_record(world, body);
    const std::array<double, 3> velocity =
        pal::physics_body_get_linear_velocity(live.handle);
    return Vec3d{velocity[0], velocity[1], velocity[2]};
}

void apply_physics_body_force(
    PhysicsWorldHandle handle,
    PhysicsBody body,
    Vec3d force,
    Vec3d location) {
    const PhysicsWorld& world = physics_world_record(handle);
    const double dt = world_step_seconds(world);
    apply_physics_impulse(
        handle,
        body,
        Vec3d{force.x * dt, force.y * dt, force.z * dt},
        std::optional<Vec3d>{location});
}

void set_physics_body_collision_events_enabled(
    PhysicsWorldHandle handle,
    PhysicsBody body,
    bool enabled) {
    PhysicsWorld& world = physics_world_record(handle);
    const PhysicsBody& live = physics_body_record(world, body);
${
    thin
        ? `    thin_for_each(world, live.handle, [&](auto native_handle) {
        pal::physics_body_set_collision_events_enabled(native_handle, enabled);
    });`
        : `    pal::physics_body_set_collision_events_enabled(live.handle, enabled);`
}
}

const char* physics_collision_type_name(PhysicsCollisionType type) {
    switch (type) {
        case PhysicsCollisionType::STARTED: return "STARTED";
        case PhysicsCollisionType::CONTINUED: return "CONTINUED";
        case PhysicsCollisionType::FINISHED: return "FINISHED";
    }
    return "FINISHED";
}

void on_physics_collision(
    PhysicsWorldHandle handle,
    std::function<void(const PhysicsCollisionInfo&)> callback) {
    auto& state = physics_world_record(handle);
    if (!state.events) state.events.emplace();
    on_physics_after_step(
        handle,
        [handle, callback = std::move(callback)](float) {
            PhysicsWorld& world = physics_world_record(handle);
            if (!world.events) throw std::logic_error("A collision observer requires its world's event context.");
            auto& events = *world.events;
            for (const pal::PhysicsCollisionEvent& event :
                 pal::physics_world_collision_events(world.handle)) {
                const auto body_a = physics_events_resolve(world, events, event.collider_identity);
                const auto body_b = physics_events_resolve(world, events, event.collided_against_identity);
                if (${collisionInfo.guard}) continue;
                const Vec3d point_a{event.point[0], event.point[1], event.point[2]};
                const Vec3d point_b{event.point_other[0], event.point_other[1], event.point_other[2]};
                const Vec3d normal{event.normal[0], event.normal[1], event.normal[2]};
                callback(PhysicsCollisionInfo{
                    ${collisionInfo.fields},
                });
            }
        });
}

${queries?.source ?? ""}
${viewer?.source ?? ""}
${constraints?.source ?? ""}
${heightfield?.source ?? ""}
${gravitySetter.source}
PhysicsRaycastResult physics_raycast(
    PhysicsWorldHandle handle,
    Vec3d from,
    Vec3d to,
    std::uint32_t membership,
    std::uint32_t collide_with,
    bool should_hit_triggers) {
    PhysicsWorld& world = physics_world_record(handle);
    const pal::PhysicsRaycastResult hit = pal::physics_world_raycast(
        world.handle,
        {from.x, from.y, from.z},
        {to.x, to.y, to.z},
        membership,
        collide_with,
        should_hit_triggers);
    // src/physics/havok-queries.ts#findBodyById searches the tracked world
    // list and returns the original body's identity, or null if it is absent.
    js::Nullable<PhysicsBody> body;
    double body_index = -1.0;
    double distance = 0.0;
    if (hit.has_hit) {
${distanceLocals}
        distance = ${distanceExpression};
${
    thin
        ? `        if (const auto instance = thin_resolve(world, hit.body_identity)) {
            body = instance->body;
            body_index = instance->index;
        }
`
        : ""
}
        for (const PhysicsBody& candidate : world.bodies) {
            if (body) break;
            if (candidate.handle.value == hit.body_identity) {
                body = candidate;
                body_index = 0.0;
                break;
            }
        }
    }
    return PhysicsRaycastResult{
        hit.has_hit,
        Vec3d{hit.point[0], hit.point[1], hit.point[2]},
        Vec3d{hit.normal[0], hit.normal[1], hit.normal[2]},
        distance,
        std::move(body),
        body_index,
    };
}

PhysicsBody create_physics_body(
    PhysicsWorldHandle handle,
    PhysicsNodeRef node,
    PhysicsMotionType motion_type,
    bool starts_asleep) {
    // \`createPhysicsBody\`: motion type, add to world, then transform --
    // in that order, because the solver resets a body's transform on add.
    PhysicsWorld& world = physics_world_record(handle);
    Engine& engine = *world.engine;
    PhysicsBody body{};
${
    thin
        ? `    if (world.thin_enabled) {
        if (auto instance_body = thin_create(world, handle.ownership, node, motion_type, starts_asleep)) {
            world.bodies.push_back(*instance_body);
            return *instance_body;
        }
    }
`
        : ""
}
    body.owner = handle.ownership;
    body.node = node;
    body.motion_type = motion_type;
    body.handle = pal::physics_body_create();
    pal::physics_body_set_motion_type(
        body.handle, pinned_motion_type(motion_type));
    // Publish the generated owner before adding the body to its solver world.
    // Roll both memberships back if node synchronization fails.
    world.bodies.push_back(body);
    try {
${
    floatingOrigin
        ? `        if (world.fo) {
            // \`world._fo.placeBody(world, body, startsAsleep)\`: the region
            // decides which solver world the body joins AND the frame its
            // transform is written in, so the plain pair below is replaced
            // rather than followed.
            place_body(world, body, starts_asleep);
        } else {
            pal::physics_world_add_body(
                world.handle, body.handle, starts_asleep);
            sync_node_to_body(engine, body, false);
        }
    } catch (...) {
        if (body.region) {
            pal::physics_world_remove_body(body.region->_world, body.handle);
        } else if (!world.fo) {
            pal::physics_world_remove_body(world.handle, body.handle);
        }
`
        : `        pal::physics_world_add_body(
            world.handle, body.handle, starts_asleep);
        sync_node_to_body(engine, body, false);
    } catch (...) {
        pal::physics_world_remove_body(world.handle, body.handle);
`
}        world.bodies.pop_back();
        throw;
    }
    world.bodies.back() = body;
    return body;
}

void set_physics_body_shape(
    PhysicsWorldHandle handle,
    PhysicsBody body,
    PhysicsShape shape) {
    // \`setPhysicsBodyShape\` writes \`body._shape\` too, and the live record
    // is what reads it back: \`setPhysicsBodyMass\` derives its tensor from
    // there.
    PhysicsWorld& world = physics_world_record(handle);
    PhysicsBody& live = physics_body_record(world, body);
${
    thin
        ? `    thin_for_each(world, live.handle, [&](auto native_handle) {
        pal::physics_body_set_shape(native_handle, shape.handle);
    });`
        : `    pal::physics_body_set_shape(live.handle, shape.handle);`
}
    live.shape = shape;
}

${
    trigger
        ? `const char* physics_trigger_type_name(PhysicsTriggerType type) {
    switch (type) {
        case PhysicsTriggerType::ENTERED: return "ENTERED";
        case PhysicsTriggerType::EXITED: return "EXITED";
    }
    return "EXITED";
}

void on_physics_trigger(
    PhysicsWorldHandle handle,
    std::function<void(const PhysicsTriggerInfo&)> callback) {
    // \`registerTriggerDrain\`: the events are produced by the world step,
    // so they drain through the post-step hook rather than through a
    // channel of their own. The pin returns a disposer that splices the
    // drain back out; nothing reached calls it, so the registration is
    // what is emitted.
    on_physics_after_step(
        handle,
        [handle, callback = std::move(callback)](float) {
            const PhysicsWorld& world = physics_world_record(handle);
            for (const pal::PhysicsTriggerEvent& event :
                 pal::physics_world_trigger_events(world.handle)) {
                callback(PhysicsTriggerInfo{
                    event.type == pal::PhysicsTriggerEventType::entered
                        ? PhysicsTriggerType::ENTERED
                        : PhysicsTriggerType::EXITED});
            }
        });
}

`
        : ""
}/**
 * The three terms a capsule and a cylinder share, each taking the
 * aggregate's own override through the pin's \`??\`.
 *
 * Both pinned cases state the same three assignments over a segment their
 * own arm derived, so the derivation stays two functions -- the pin's two
 * cases -- and what they do with the result is one.
 */
void apply_segment_params(
    PhysicsShapeParameters& params,
    const PhysicsAggregateOptions& options,
    const PinnedSegmentShape& segment) {
    params.radius = options.radius ? *options.radius : segment.radius;
    params.point_a = options.point_a ? *options.point_a : segment.point_a;
    params.point_b = options.point_b ? *options.point_b : segment.point_b;
}

PhysicsAggregate create_physics_aggregate(
    PhysicsWorldHandle handle,
    MeshHandle mesh,
    PhysicsShapeType type,
    const PhysicsAggregateOptions& options) {
    PhysicsWorld& world = physics_world_record(handle);
    Engine& engine = *world.engine;
    const MeshRecord& record = ${recordAt("engine.meshes", "mesh")};
    const MeshBounds bounds = mesh_bounds(engine, record);
${
    thin
        ? `    if (world.thin_enabled) thin_validate(world, physics_node(mesh));
`
        : ""
}

    // \`_buildShapeParams\` then the primitive factory, which is the pin's
    // own pair: the bounds-derived parameters take each explicit override
    // through the same \`??\`, and the factory settles what is still absent.
    PhysicsShape shape{options.shape};
    if (shape.handle.value == 0) {
      const PinnedShapeBounds sized =
          pinned_shape_bounds(bounds, record.scaling);
      PhysicsShapeParameters params{};
      // \`if (options.center) params.center = options.center;\` sits BEFORE
      // the switch upstream, so a capsule or a cylinder carries an explicit
      // centre too even though neither case states one; the two cases that
      // do state one then take it through their own \`??\`.
      if (options.center) {
          params.center = *options.center;
      }
      switch (type) {
        case PhysicsShapeType::SPHERE:
            params.radius =
                options.radius ? *options.radius : sphere_radius(sized);
            if (!params.center) {
                params.center = bounding_center(sized);
            }
            break;
        case PhysicsShapeType::BOX:
            params.extents = options.extents
                ? *options.extents
                : box_extents(sized);
            if (!params.center) {
                params.center = bounding_center(sized);
            }
            break;
        case PhysicsShapeType::CAPSULE:
            apply_segment_params(params, options, capsule_shape(sized));
            break;
        case PhysicsShapeType::CYLINDER:
            apply_segment_params(params, options, cylinder_shape(sized));
            break;
          default:
              break;
      }
      const std::optional<pal::PhysicsShapeHandle> primitive =
          primitive_physics_shape_handle(type, params);
      if (!primitive) {
          throw std::runtime_error(
              "createPhysicsAggregate supports only primitive physics "
              "shapes.");
      }
      shape.handle = *primitive;
    }

    const PhysicsBody body = create_physics_body(
        handle,
        physics_node(mesh),
        options.mass == 0.0 ? PhysicsMotionType::STATIC
                            : PhysicsMotionType::DYNAMIC,
        options.start_asleep);

    // \`setPhysicsBodyShape\`, then the material, then the mass. The order
    // is the pin's and is observable: mass derives from the shape.
    set_physics_body_shape(handle, body, shape);

    // \`setPhysicsShapeMaterial(world, shape, friction, restitution)\`: the
    // pin's own four-argument call, so the fifth parameter takes its
    // \`= friction\` default and one friction reaches both channels.
    const double friction = options.friction ? *options.friction
                                             : physics_default_friction;
    const double restitution = options.restitution ? *options.restitution
                                      : physics_default_restitution;
    set_physics_shape_material(
        handle, shape, friction, restitution, js::Nullable<double>{});

    // \`setPhysicsBodyMass(world, body, options.mass)\`, under the pin's own
    // positive-mass gate. The setter reads its tensor from the shape the
    // phase above wrote into the live record, which is why the pin orders
    // the two this way.
    if (options.mass > 0.0) {
        set_physics_body_mass(handle, body, options.mass);
    }

    return PhysicsAggregate{
        physics_body_record(world, body), shape};
}

}  // namespace bbl::upstream
`;

        this.assertShapeParameterLanesRead(source);
        return {
            header,
            source,
            modulePath: havokModule,
            symbolName: "createHavokWorld",
        };
    }

    /**
     * Every geometry lane the options bag carries is read by the body that
     * consumes it.
     *
     * `SHAPE_PARAMETERS` keeps the struct and the intrinsic in step, which is
     * a claim about LAYOUT. Nothing kept the readers in step, and that is
     * exactly the defect this table was introduced to fix: `radius` reached
     * `PhysicsAggregateOptions`, travelled into the struct, and both segment
     * arms ignored it -- accepted and dropped rather than refused. The
     * sibling check `assertShapeParameterMembers` already asks the pin's
     * interface the same question from the other side; this one asks the
     * emitted text.
     */
    private assertShapeParameterLanesRead(source: string): void {
        const unread = SHAPE_PARAMETERS.filter(
            ([, field]) => !source.includes(`options.${field}`),
        ).map(([pinned]) => pinned);
        if (unread.length > 0) {
            this.context.contractError(
                this.context.functionDeclaration(
                    havokModule,
                    "createPhysicsAggregate",
                ).declaration,
                `The emitted aggregate factory never reads [${unread.join(", ")}], ` +
                    "so a scene passing one would have it accepted and dropped. " +
                    "Every lane SHAPE_PARAMETERS lays into PhysicsAggregateOptions " +
                    "has to be taken through the pin's own `??` by an arm here.",
            );
        }
    }
}
