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
import {
  lowerMat4MultiplyWriterCpp,
  lowerObjectComponents,
} from "./pinned-function-lowerer.js";
import {
  PinnedNumericLowerer,
  type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import {
  SHAPE_PARAMETERS,
  shapeParameterStorage,
} from "../compiler/intrinsics/physics.js";

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
const PRIMITIVE_SHAPE_ARMS: ReadonlyArray<
  readonly [string, string, string]
> = [
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
    const initializer = this.context.variableInitializer(declaration, "g");
    const split = this.context.nullishDefault(initializer);
    if (!split || !ts.isObjectLiteralExpression(split.right)) {
      this.context.contractError(
        initializer,
        "Expected createHavokWorld to default its gravity " +
          "through `gravity ?? { x, y, z }`.",
      );
    }
    const fallback = split.right;
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
    const { declaration } = this.context.functionDeclaration(
      havokModule,
      "createPhysicsAggregate",
    );
    const file = this.context.sourceFile(havokModule);
    const read = (name: string): number => {
      const initializer = this.context.variableInitializer(declaration, name);
      const split = this.context.nullishDefault(initializer);
      if (!split) {
        this.context.contractError(
          initializer,
          `Expected createPhysicsAggregate to default ` +
            `${name} through \`options.${name} ?? <value>\`.`,
        );
      }
      return this.context.numericValue(split.right, file);
    };
    return {
      friction: read("friction"),
      restitution: read("restitution"),
    };
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
      ...PRELUDE_SCALARS.map(([pinned, field]): [string, PinnedBinding] => [
        pinned,
        scalar(`shape.${field}`),
      ]),
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
      // The one-to-one names come from `pinnedNumericMathCalls`, so a
      // member one lowerer learns is a member all of them know. Only
      // `Math.max` is stated here, and only because the pin calls it
      // with THREE arguments: the shared spelling is the two-argument
      // `std::max<double>(a, b)`, where a three-way maximum needs the
      // initializer-list overload.
      calls: new Map<string, (args: readonly string[]) => string>([
        ...pinnedNumericMathCalls(),
        [
          "Math.max",
          (args: readonly string[]) => `std::max<double>({${args.join(", ")}})`,
        ],
      ]),
    });
    const vector = (expression: ts.Expression): string => {
      const unwrapped = this.context.unwrapExpression(expression);
      if (!ts.isObjectLiteralExpression(unwrapped)) {
        return lowerer.expression(unwrapped);
      }
      return `Vec3d{${lowerObjectComponents(this.context, lowerer, unwrapped, [
        ...axes,
      ]).join(", ")}}`;
    };
    const preludeTerm = (name: string): string =>
      lowerer.expression(this.context.variableInitializer(declaration, name));
    const boundVector = (name: "min" | "max"): string => {
      const member = name === "min" ? "minimum" : "maximum";
      const initializer = this.context.variableInitializer(declaration, name);
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
              this.context.numericValue(fallback.elements[index]!, file),
            ),
        )
        .join(", ")}}`;
    };
    const sphereCenter = vector(
      this.shapeCaseValue(declaration, "SPHERE", "center"),
    );
    const boxCenter = vector(this.shapeCaseValue(declaration, "BOX", "center"));
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
        clause.expression.getText(file).replace("PhysicsShapeType.", ""),
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
    const otherwise = this.context.findNodes(declaration, ts.isDefaultClause);
    const returnsNull =
      otherwise.length === 1 &&
      otherwise[0]!.statements.length === 1 &&
      ts.isReturnStatement(otherwise[0]!.statements[0]!) &&
      otherwise[0]!.statements[0]!.expression?.kind === ts.SyntaxKind.NullKeyword;
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
        if (!split || !member || split.left.getText(file) !== `params.${member}`) {
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
          field ? `params.${field} ? *params.${field} : ${value}` : value;
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
            candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
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
          (missing.length > 0 ? `Unassigned: ${missing.join(", ")}. ` : "") +
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
          candidate.expression.getText(file) === `PhysicsShapeType.${caseName}`,
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
          candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          candidate.left.getText(file) === `params.${property}`,
      );
    if (!assignment) {
      this.context.contractError(
        clause,
        `Expected the ${caseName} case to assign ` + `params.${property}.`,
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

  /** Every rule the emitted template folds, checked where it is stated. */
  private assertPinnedContracts(): void {
    for (const [symbolName, shapes] of PhysicsLowerer.shapeContracts) {
      const declaration = this.pinnedDeclaration(symbolName);
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
    for (const [
      symbolName,
      restated,
      kinds,
    ] of PhysicsLowerer.inventoryContracts) {
      const declaration = this.pinnedDeclaration(symbolName);
      this.context.assertStatementInventory(
        declaration,
        declaration.body!.statements,
        symbolName,
        restated,
        kinds,
      );
    }
    this.assertStaticFrictionDefault();
    for (const [symbolName, callees] of PhysicsLowerer.orderContracts) {
      const declaration = this.pinnedDeclaration(symbolName);
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

  /**
   * `setPhysicsShapeMaterial`'s static-friction parameter defaults to the
   * dynamic one.
   *
   * The emitted aggregate writes one friction into both channels, which
   * is the pin's behaviour only because the caller passes four arguments
   * and the fifth falls back. A pin that gave the static channel a
   * default of its own would keep the array shape above and change the
   * simulation, so the DEFAULT is what has to be read.
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
      !this.context.expressionMatchesShape(parameter.initializer, "friction")
    ) {
      this.context.contractError(
        parameter ?? declaration,
        "Expected setPhysicsShapeMaterial's staticFriction to " +
          "default to friction. The generated aggregate writes " +
          "one friction into both material channels because " +
          "that default is what the pin's own four-argument " +
          "call resolves to.",
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
        // the floating-origin arm (nothing reached sets `_fo`)
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
      "create_physics_aggregate restates all four phases inline",
      [
        // const motionType = options.mass === 0 ? STATIC : DYNAMIC;
        "variable statement",
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
        // const hkBody = hknp.HP_Body_Create()[1];
        "variable statement",
        // const hkMotion = <the three-arm motion-type mapping>;
        "variable statement",
        // hknp.HP_Body_SetMotionType(hkBody, hkMotion);
        "expression statement",
        // the body record itself
        "variable statement",
        // the floating-origin arm against add-then-transform
        "if statement",
        // world._bodies.push(body);
        "expression statement",
        // return body;
        "return statement",
      ],
    ],
    [
      "setPhysicsShapeMaterial",
      "the emitted aggregate restates the material write",
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
  private assertShapeParamsPrelude(declaration: ts.FunctionDeclaration): void {
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
                ts.isIdentifier(entry.name) ? entry.name.text : "",
              )
              .join(", ")
          : ts.isIfStatement(statement)
            ? `if (${statement.expression.getText()})`
            : ts.isSwitchStatement(statement)
              ? "switch statement"
              : statementKind(statement),
    );
  }

  public lowerPhysics(): LoweredSource {
    this.assertPinnedContracts();

    const maxStepMs = this.maxStepMs();
    const gravity = this.defaultGravity();
    const defaults = this.aggregateMaterialDefaults();
    const shapeTypes = this.enumMembers("PhysicsShapeType");
    const motionTypes = this.enumMembers("PhysicsMotionType");
    const prestepTypes = this.enumMembers("PhysicsPrestepType");
    const shapeParams = this.lowerShapeParams();
    const primitiveHandle = this.lowerPrimitiveShapeHandle();

    const enumeratorList = (members: Map<string, number>): string =>
      [...members].map(([name, value]) => `    ${name} = ${value},`).join("\n");

    const header = `// ${this.context.provenance(
      havokModule,
      "createHavokWorld",
      "the pin's own rigid-body semantics; the HP_* back end is " + "the PAL's",
    )}
#pragma once

#include <cmath>
#include <cstdint>
#include <functional>
#include <optional>
#include <vector>

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

/**
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
enum class PhysicsNodeKind : std::int32_t {
    mesh,
    transform_node,
};

struct PhysicsNodeRef {
    PhysicsNodeKind kind = PhysicsNodeKind::mesh;
    std::uint32_t value = 0;
};

[[nodiscard]] inline PhysicsNodeRef physics_node(MeshHandle mesh) {
    return PhysicsNodeRef{PhysicsNodeKind::mesh, mesh.value};
}

[[nodiscard]] inline PhysicsNodeRef physics_node(TransformNodeHandle node) {
    return PhysicsNodeRef{PhysicsNodeKind::transform_node, node.value};
}

/**
 * ${havokModule} \`PhysicsBody\`, trimmed to the reached slice the way
 * \`PhysicsAggregateOptions\` above it is. The pin's \`_shape\` is held only
 * so \`setPhysicsBodyMass\` can branch on it, and that branch runs while the
 * aggregate is still building, so it is a local there rather than a field.
 */
struct PhysicsBody {
    pal::PhysicsBodyHandle handle{};
    PhysicsNodeRef node{};
    PhysicsShape shape{};
    PhysicsMotionType motion_type = PhysicsMotionType::STATIC;
    PhysicsPrestepType prestep_type = PhysicsPrestepType::TELEPORT;
    bool pre_step = false;
};

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
};

[[nodiscard]] const char* physics_collision_type_name(
    PhysicsCollisionType type);

/** ${havokTriggerModule} \`PhysicsTriggerInfo["type"]\`. */
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

struct PhysicsRaycastResult {
    bool has_hit = false;
    Vec3d hit_point{};
    Vec3d hit_normal{};
    double hit_distance = 0.0;
};

/**
 * ${havokModule} \`PhysicsWorld\`. The pin keeps \`_hknp\` beside
 * \`_hkWorld\`; here the module is the PAL and only the world handle
 * travels.
 */
struct PhysicsWorld {
    pal::PhysicsWorldHandle handle{};
    Engine* engine = nullptr;
    /**
     * \`_scene\`. \`worldStepSeconds\` reads the scene's own fixed step
     * live, so the world keeps the scene rather than a copy of the value:
     * a scene may write \`fixedDeltaMs\` after the world exists, and the
     * pin would see that write.
     */
    Scene* scene = nullptr;
    std::vector<PhysicsBody> bodies;
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
};

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
};

[[nodiscard]] PhysicsWorldHandle create_havok_world(
    Scene& scene,
    Vec3d gravity);
void on_physics_after_step(
    PhysicsWorldHandle world,
    std::function<void(float)> callback);
void set_physics_timestep_ms(
    PhysicsWorldHandle world,
    double fixed_delta_ms);
PhysicsShape create_physics_convex_hull_shape(
    PhysicsWorldHandle world,
    MeshHandle mesh,
    bool include_child_meshes);
[[nodiscard]] PhysicsShape create_physics_primitive_shape(
    PhysicsWorldHandle world,
    PhysicsShapeType type,
    const PhysicsShapeParameters& parameters);
void set_physics_shape_is_trigger(
    PhysicsWorldHandle world,
    PhysicsShape shape,
    bool is_trigger);
[[nodiscard]] PhysicsBody create_physics_body(
    PhysicsWorldHandle world,
    PhysicsNodeRef node,
    PhysicsMotionType motion_type,
    bool starts_asleep);
void set_physics_body_shape(
    PhysicsWorldHandle world,
    PhysicsBody body,
    PhysicsShape shape);
void on_physics_trigger(
    PhysicsWorldHandle world,
    std::function<void(const PhysicsTriggerInfo&)> callback);
PhysicsAggregate create_physics_aggregate(
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
    std::uint32_t collide_with);

}  // namespace bbl::upstream
`;

    const source = `// ${this.context.provenance(havokModule, "_stepWorld")}
#include "bblite/upstream/physics.hpp"
#include "bblite/upstream/renderer_plan.hpp"

#include <algorithm>
#include <deque>
#include <stdexcept>

namespace bbl::upstream {
namespace {

${lowerMat4MultiplyWriterCpp(this.context)}

/**
 * The worlds a scene created. A \`PhysicsWorld\` is handed out by
 * reference and captured by the step closure, so the container must not
 * move its elements -- the same reason the engine's own record arenas are
 * stable.
 */
std::deque<PhysicsWorld>& physics_worlds() {
    static std::deque<PhysicsWorld> worlds;
    return worlds;
}

PhysicsWorld& physics_world_record(PhysicsWorldHandle handle) {
    return physics_worlds()[handle.value];
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

/**
 * MeshAccumulator.addNodeMeshes for the reached runtime-created hierarchy.
 * The pin maps every vertex through rootScale * inverse(rootWorld) *
 * nodeWorld. For a node below this tagged mesh root, cancelling rootWorld
 * leaves rootScale followed by the child's local chain, which is what this
 * recursive form composes. Imported glTF hierarchy mutation remains outside
 * this slice; those vertices keep the loader's bake-to-world model.
 */
void append_convex_hull_vertices(
    const Engine& engine,
    MeshHandle mesh,
    const std::array<float, 16>& mesh_to_body,
    bool include_children,
    std::vector<std::array<double, 3>>& positions) {
    if (mesh.value >= engine.meshes.size()) return;
    const MeshRecord& record = engine.meshes[mesh.value];
    if (record.geometry < engine.geometries.size()) {
        const ModelGeometry& geometry = engine.geometries[record.geometry];
        positions.reserve(positions.size() + geometry.vertices.size());
        for (const ModelVertex& vertex : geometry.vertices) {
            const double x = vertex.position.x;
            const double y = vertex.position.y;
            const double z = vertex.position.z;
            positions.push_back({
                mesh_to_body[0] * x + mesh_to_body[4] * y +
                    mesh_to_body[8] * z + mesh_to_body[12],
                mesh_to_body[1] * x + mesh_to_body[5] * y +
                    mesh_to_body[9] * z + mesh_to_body[13],
                mesh_to_body[2] * x + mesh_to_body[6] * y +
                    mesh_to_body[10] * z + mesh_to_body[14],
            });
        }
    }
    if (!include_children) return;
    for (const MeshHandle child : record.children) {
        if (child.value >= engine.meshes.size()) continue;
        const std::array<float, 16> local =
            mesh_local_matrix(engine.meshes[child.value]);
        std::array<float, 16> child_to_body{};
        mat4_multiply_into(
            child_to_body, 0, mesh_to_body, 0, local, 0);
        append_convex_hull_vertices(
            engine, child, child_to_body, true, positions);
    }
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
    if (node.kind == PhysicsNodeKind::transform_node) {
        const TransformNodeRecord& record = engine.transform_nodes[node.value];
        return PhysicsNodePose{record.position, record.rotation_quaternion};
    }
    const MeshRecord& mesh = engine.meshes[node.value];
    return PhysicsNodePose{mesh.position, mesh.rotation_quaternion};
}

/** \`_syncBodyToNode\`: the integrated pose written back onto the node. */
void sync_body_to_node(Engine& engine, const PhysicsBody& body) {
    const pal::PhysicsTransform transform =
        pal::physics_body_get_transform(body.handle);
    const Vec3d position{
        transform.position[0],
        transform.position[1],
        transform.position[2],
    };
    const Vec4 rotation{
        static_cast<float>(transform.rotation[0]),
        static_cast<float>(transform.rotation[1]),
        static_cast<float>(transform.rotation[2]),
        static_cast<float>(transform.rotation[3]),
    };
    if (body.node.kind == PhysicsNodeKind::transform_node) {
        TransformNodeRecord& record =
            engine.transform_nodes[body.node.value];
        record.position = position;
        record.rotation_quaternion = rotation;
        record.has_rotation_quaternion = true;
        mark_transform_node_runtime_transform(
            engine,
            TransformNodeHandle{body.node.value});
        return;
    }
    MeshRecord& mesh = engine.meshes[body.node.value];
    mesh.position = position;
    mesh.rotation_quaternion = rotation;
    mesh.has_rotation_quaternion = true;
    mark_mesh_runtime_transform(engine, MeshHandle{body.node.value});
}

/** \`_syncNodeToBody\` / \`_syncNodeToBodyTarget\`. */
void sync_node_to_body(
    const Engine& engine,
    const PhysicsBody& body,
    bool as_target) {
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

/**
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
            : (world.scene != nullptr &&
               static_cast<double>(world.scene->fixed_delta_ms) > 0.0
                   ? static_cast<double>(world.scene->fixed_delta_ms)
                   : world.engine_delta_ms);
    if (!std::isfinite(step_ms) || step_ms <= 0.0) {
        return 0.0;
    }
    return std::min(step_ms, physics_max_step_ms) / 1000.0;
}

/**
 * \`_stepWorld\`. The gate, the clamp and the four phases are the pinned
 * module's; \`assertStepGate\` in the lowerer fails generation if any of
 * them moves.
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
    world.engine_delta_ms = delta_ms;

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

    for (const auto& callback : world.after_step) {
        callback(static_cast<float>(dt));
    }
}

}  // namespace

PhysicsWorldHandle create_havok_world(Scene& scene, Vec3d gravity) {
    const PhysicsWorldHandle handle{
        static_cast<std::uint32_t>(physics_worlds().size())};
    PhysicsWorld& world = physics_worlds().emplace_back();
    world.handle = pal::physics_world_create();
    world.engine = scene.engine;
    world.scene = &scene;
    pal::physics_world_set_gravity(
        world.handle, {gravity.x, gravity.y, gravity.z});

    // \`scene._beforeRender.unshift(stepCb)\`: physics integrates before
    // every other before-render callback, so a scene reading a pose in one
    // reads this frame's rather than the previous frame's.
    scene.before_render.insert(
        scene.before_render.begin(),
        [handle](float delta_ms) {
            step_world(
                physics_world_record(handle),
                static_cast<double>(delta_ms));
        });
    return handle;
}

void on_physics_after_step(
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

PhysicsShape create_physics_convex_hull_shape(
    PhysicsWorldHandle handle,
    MeshHandle mesh,
    bool include_child_meshes) {
    PhysicsWorld& world = physics_world_record(handle);
    Engine& engine = *world.engine;
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error(
            "Physics mesh shapes require a live mesh hierarchy.");
    }
    const MeshRecord& root = engine.meshes[mesh.value];
    const std::array<float, 16> root_scale{
        root.scaling.x, 0.0f, 0.0f, 0.0f,
        0.0f, root.scaling.y, 0.0f, 0.0f,
        0.0f, 0.0f, root.scaling.z, 0.0f,
        0.0f, 0.0f, 0.0f, 1.0f,
    };
    std::vector<std::array<double, 3>> positions;
    append_convex_hull_vertices(
        engine, mesh, root_scale, include_child_meshes, positions);
    if (positions.empty()) {
        throw std::runtime_error(
            "Cannot create physics mesh shape without vertex positions.");
    }
    return PhysicsShape{
        pal::physics_shape_create_convex_hull(positions)};
}

PhysicsShape create_physics_primitive_shape(
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

void set_physics_shape_is_trigger(
    PhysicsWorldHandle handle,
    PhysicsShape shape,
    bool is_trigger) {
    // \`setPhysicsShapeIsTrigger\` is exactly this one back-end write,
    // reached through the world the pin reads it from.
    static_cast<void>(physics_world_record(handle));
    pal::physics_shape_set_trigger(shape.handle, is_trigger);
}

PhysicsBody& physics_body_record(
    PhysicsWorld& world,
    PhysicsBody body) {
    const auto found = std::find_if(
        world.bodies.begin(),
        world.bodies.end(),
        [body](const PhysicsBody& candidate) {
            return candidate.handle.value == body.handle.value;
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
    pal::physics_body_set_motion_type(
        live.handle, pinned_motion_type(motion_type));
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
    pal::physics_body_set_mass_properties(live.handle, properties);
}

/**
 * The live record for a body whose world the caller was not handed.
 *
 * The two pre-step setters take \`(body, ...)\` and no world, because the
 * pin reaches it through \`body._world\`. The value a scene holds here is a
 * copy, so the owning world is the one holding a record with the same PAL
 * handle -- the same identity \`physics_body_record\` matches on.
 */
PhysicsBody& owning_body_record(PhysicsBody body) {
    for (PhysicsWorld& world : physics_worlds()) {
        for (PhysicsBody& live : world.bodies) {
            if (live.handle.value == body.handle.value) {
                return live;
            }
        }
    }
    throw std::runtime_error(
        "Physics body is not part of any world.");
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
    Vec3d location{};
    if (point) {
        location = *point;
    } else {
        const pal::PhysicsTransform transform =
            pal::physics_body_get_transform(live.handle);
        location = Vec3d{
            transform.position[0],
            transform.position[1],
            transform.position[2],
        };
    }
    pal::physics_body_apply_impulse(
        live.handle,
        {location.x, location.y, location.z},
        {impulse.x, impulse.y, impulse.z});
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
    pal::physics_body_set_collision_events_enabled(live.handle, enabled);
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
    on_physics_after_step(
        handle,
        [handle, callback = std::move(callback)](float) {
            const PhysicsWorld& world = physics_world_record(handle);
            for (const pal::PhysicsCollisionEvent& event :
                 pal::physics_world_collision_events(world.handle)) {
                const PhysicsCollisionType type =
                    event.type == pal::PhysicsCollisionEventType::started
                        ? PhysicsCollisionType::STARTED
                        : event.type == pal::PhysicsCollisionEventType::continued
                            ? PhysicsCollisionType::CONTINUED
                            : PhysicsCollisionType::FINISHED;
                callback(PhysicsCollisionInfo{
                    type,
                    Vec3d{event.point[0], event.point[1], event.point[2]},
                    Vec3d{event.normal[0], event.normal[1], event.normal[2]},
                    event.impulse,
                });
            }
        });
}

PhysicsRaycastResult physics_raycast(
    PhysicsWorldHandle handle,
    Vec3d from,
    Vec3d to,
    std::uint32_t membership,
    std::uint32_t collide_with) {
    const PhysicsWorld& world = physics_world_record(handle);
    const pal::PhysicsRaycastResult hit = pal::physics_world_raycast(
        world.handle,
        {from.x, from.y, from.z},
        {to.x, to.y, to.z},
        membership,
        collide_with);
    return PhysicsRaycastResult{
        hit.has_hit,
        Vec3d{hit.point[0], hit.point[1], hit.point[2]},
        Vec3d{hit.normal[0], hit.normal[1], hit.normal[2]},
        hit.distance,
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
    body.node = node;
    body.motion_type = motion_type;
    body.handle = pal::physics_body_create();
    pal::physics_body_set_motion_type(
        body.handle, pinned_motion_type(motion_type));
    pal::physics_world_add_body(world.handle, body.handle, starts_asleep);
    sync_node_to_body(engine, body, false);
    world.bodies.push_back(body);
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
    pal::physics_body_set_shape(live.handle, shape.handle);
    live.shape = shape;
}

const char* physics_trigger_type_name(PhysicsTriggerType type) {
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

/**
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
    mark_mesh_runtime_transform(engine, mesh);
    const MeshRecord& record = engine.meshes[mesh.value];
    const MeshBounds bounds = mesh_bounds(engine, record);

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

    // \`setPhysicsShapeMaterial\`: the pin writes one friction into both
    // channels and picks a combine mode per channel, which travels as data
    // rather than being re-decided by the linked solver.
    const double friction = options.friction ? *options.friction
                                             : physics_default_friction;
    const double restitution = options.restitution ? *options.restitution
                                      : physics_default_restitution;
    pal::physics_shape_set_material(
        shape.handle,
        pal::PhysicsShapeMaterial{
            friction,
            friction,
            restitution,
            pal::PhysicsMaterialCombine::minimum,
            pal::PhysicsMaterialCombine::maximum,
        });

    // \`setPhysicsBodyMass\`: start from the shape-derived mass properties
    // and override only the mass scalar. The branch is the pin's -- a
    // shapeless body would take its isotropic fallback instead -- and the
    // aggregate always has a shape by here, which is why only this arm is
    // emitted.
    if (options.mass > 0.0) {
        pal::PhysicsMassProperties properties =
            pal::physics_shape_build_mass_properties(
                shape.handle, options.mass);
        properties.mass = options.mass;
        pal::physics_body_set_mass_properties(body.handle, properties);
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
        this.context.functionDeclaration(havokModule, "createPhysicsAggregate")
          .declaration,
        `The emitted aggregate factory never reads [${unread.join(", ")}], ` +
          "so a scene passing one would have it accepted and dropped. " +
          "Every lane SHAPE_PARAMETERS lays into PhysicsAggregateOptions " +
          "has to be taken through the pin's own `??` by an arm here.",
      );
    }
  }
}
