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
import type { LoweredSource, LoweringContext } from "./context.js";
import {
  lowerMat4MultiplyWriterCpp,
  lowerObjectComponents,
} from "./pinned-function-lowerer.js";
import {
  PinnedNumericLowerer,
  type PinnedBinding,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";

export const havokModule = "src/physics/havok.ts";

/** The pinned builder every aggregate's shape parameters come from. */
const buildShapeParams = "_buildShapeParams";

/** The statement kinds a restated pinned body's inventory names. */
const STATEMENT_KINDS: ReadonlyArray<
  readonly [string, (statement: ts.Statement) => boolean]
> = [
  ["variable statement", ts.isVariableStatement],
  ["if statement", ts.isIfStatement],
  ["for statement", ts.isForStatement],
  ["expression statement", ts.isExpressionStatement],
  ["return statement", ts.isReturnStatement],
];

/**
 * A statement's kind, as an inventory row names it.
 *
 * One projection for every statement-kind inventory below, so the `"other
 * statement"` fallback the refusal message prints is stated once: two copies
 * can disagree about a kind the table has no entry for, which is exactly the
 * case an inventory exists to notice.
 */
function statementKind(statement: ts.Statement): string {
  return (
    STATEMENT_KINDS.find(([, is]) => is(statement))?.[0] ?? "other statement"
  );
}

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
   * member. A `const enum` is inlined by the TypeScript emitter, so the
   * declaration is the only place the number exists -- and both PALs
   * translate the emitted enumerator, so a member the pin renumbers has
   * to renumber here too.
   */
  private enumMembers(name: string): Map<string, number> {
    const file = this.context.sourceFile(havokModule);
    const declaration = file.statements.find(
      (statement): statement is ts.EnumDeclaration =>
        ts.isEnumDeclaration(statement) && statement.name.text === name,
    );
    if (!declaration) {
      this.context.contractError(
        file,
        `Expected ${havokModule} to declare enum ${name}.`,
      );
    }
    const members = new Map<string, number>();
    for (const member of declaration.members) {
      if (!ts.isIdentifier(member.name) || !member.initializer) {
        this.context.contractError(
          member,
          `Expected ${name} members to carry explicit ` +
            "numeric initializers.",
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
   * The reached aggregate slice names no explicit geometry option --
   * `radius`, `extents`, `center`, `pointA` and `pointB` all refuse at
   * generation -- so each per-case `??` is emitted as its right arm, the
   * derived one, read from the pin rather than restated.
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
      this.assertInventory(
        this.pinnedDeclaration(symbolName),
        symbolName,
        restated,
        kinds,
        statementKind,
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
    this.assertInventory(
      declaration,
      buildShapeParams,
      "the emitted builder restates each term in that order",
      [
        "params",
        ...PRELUDE_SCALARS.map(([pinned]) => pinned),
        "min",
        "max",
        "extents",
      ],
      (statement) =>
        ts.isVariableStatement(statement)
          ? statement.declarationList.declarations
              .map((entry) =>
                ts.isIdentifier(entry.name) ? entry.name.text : "",
              )
              .join(", ")
          : undefined,
    );
  }

  /**
   * A pinned body's own top-level inventory, in the pin's order.
   *
   * Each body it is called for is restated whole rather than translated
   * statement by statement, and for each the per-expression contracts
   * above are complete only while the body still has exactly these
   * statements: an arm the pin ADDS is invisible to every one of them.
   * `project` is what a caller compares -- a statement kind for the
   * `inventoryContracts` rows, a declaration name for the shape prelude
   * -- and returning undefined skips a statement the inventory does not
   * describe.
   */
  private assertInventory(
    declaration: ts.FunctionDeclaration,
    symbolName: string,
    restated: string,
    expected: readonly string[],
    project: (statement: ts.Statement) => string | undefined,
  ): void {
    const found = declaration
      .body!.statements.map(project)
      .filter((entry): entry is string => entry !== undefined);
    if (
      found.length === expected.length &&
      found.every((entry, index) => entry === expected[index])
    ) {
      return;
    }
    this.context.contractError(
      declaration,
      `${symbolName} carries [${found.join("; ")}]; ${restated} of ` +
        `exactly [${expected.join("; ")}], so an added or reordered ` +
        "arm must be read and re-emitted rather than silently " +
        "dropped.",
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

/** ${havokModule} \`PhysicsAggregateOptions\`, reached slice. */
struct PhysicsAggregateOptions {
    double mass = 0.0;
    js::Nullable<double> friction{};
    js::Nullable<double> restitution{};
    pal::PhysicsShapeHandle shape{};
    js::Nullable<double> radius{};
    js::Nullable<Vec3d> extents{};
    /**
     * \`createPhysicsBody(world, node, motionType, options.startAsleep)\`,
     * whose parameter defaults to \`false\` -- so an omitted option is that
     * default rather than a nullable this factory settles again.
     */
    bool start_asleep = false;
};

/**
 * ${havokModule} \`PhysicsShape\`. The pin's \`_type\` is dropped: it is read
 * only by the mesh-shape arms, which refuse at generation.
 */
struct PhysicsShape {
    pal::PhysicsShapeHandle handle{};
};

/**
 * ${havokModule} \`PhysicsBody\`, trimmed to the reached slice the way
 * \`PhysicsAggregateOptions\` above it is. The pin's \`_shape\` is held only
 * so \`setPhysicsBodyMass\` can branch on it, and that branch runs while the
 * aggregate is still building, so it is a local there rather than a field.
 */
struct PhysicsBody {
    pal::PhysicsBodyHandle handle{};
    MeshHandle node{};
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
    double step_seconds = 0.0;
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
void apply_physics_impulse(
    PhysicsWorldHandle world,
    PhysicsBody body,
    Vec3d impulse,
    std::optional<Vec3d> point);
void set_physics_shape_filter_membership_mask(
    PhysicsWorldHandle world,
    PhysicsShape shape,
    std::uint32_t membership_mask);
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
    if (mesh.has_bounds_min_override) {
        bounds.minimum = mesh.bounds_min_override;
    }
    if (mesh.has_bounds_max_override) {
        bounds.maximum = mesh.bounds_max_override;
    }
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

/** \`_syncBodyToNode\`: the integrated pose written back onto the node. */
void sync_body_to_node(Engine& engine, const PhysicsBody& body) {
    const pal::PhysicsTransform transform =
        pal::physics_body_get_transform(body.handle);
    MeshRecord& mesh = engine.meshes[body.node.value];
    mesh.position = Vec3d{
        transform.position[0],
        transform.position[1],
        transform.position[2],
    };
    mesh.rotation_quaternion = Vec4{
        static_cast<float>(transform.rotation[0]),
        static_cast<float>(transform.rotation[1]),
        static_cast<float>(transform.rotation[2]),
        static_cast<float>(transform.rotation[3]),
    };
    mesh.has_rotation_quaternion = true;
    mark_mesh_runtime_transform(engine, body.node);
}

/** \`_syncNodeToBody\` / \`_syncNodeToBodyTarget\`. */
void sync_node_to_body(
    const Engine& engine,
    const PhysicsBody& body,
    bool as_target) {
    const MeshRecord& mesh = engine.meshes[body.node.value];
    const pal::PhysicsTransform transform{
        {mesh.position.x, mesh.position.y, mesh.position.z},
        {mesh.rotation_quaternion.x, mesh.rotation_quaternion.y,
         mesh.rotation_quaternion.z, mesh.rotation_quaternion.w},
    };
    if (as_target) {
        pal::physics_body_set_target_transform(body.handle, transform);
    } else {
        pal::physics_body_set_transform(body.handle, transform);
    }
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
    world.step_seconds = dt;

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
    PhysicsWorld& world = physics_world_record(handle);
    const double dt = world.step_seconds;
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

    // \`_buildShapeParams\`: the reached slice names no explicit geometry,
    // so every parameter comes from the mesh's own bounds, scaled by the
    // node's own scaling exactly as the pinned builder scales them.
    PhysicsShape shape{options.shape};
    if (shape.handle.value == 0) {
      const PinnedShapeBounds sized =
          pinned_shape_bounds(bounds, record.scaling);
      const Vec3d center = bounding_center(sized);
      switch (type) {
        case PhysicsShapeType::SPHERE:
            shape.handle = pal::physics_shape_create_sphere(
                {center.x, center.y, center.z},
                options.radius ? *options.radius : sphere_radius(sized));
            break;
        case PhysicsShapeType::BOX: {
            const Vec3d extents = options.extents
                ? *options.extents
                : box_extents(sized);
            shape.handle = pal::physics_shape_create_box(
                {center.x, center.y, center.z},
                {0.0, 0.0, 0.0, 1.0},
                {extents.x, extents.y, extents.z});
            break;
        }
        case PhysicsShapeType::CAPSULE: {
            const PinnedSegmentShape segment = capsule_shape(sized);
            shape.handle = pal::physics_shape_create_capsule(
                {segment.point_a.x, segment.point_a.y, segment.point_a.z},
                {segment.point_b.x, segment.point_b.y, segment.point_b.z},
                segment.radius);
            break;
        }
        case PhysicsShapeType::CYLINDER: {
            const PinnedSegmentShape segment = cylinder_shape(sized);
            shape.handle = pal::physics_shape_create_cylinder(
                {segment.point_a.x, segment.point_a.y, segment.point_a.z},
                {segment.point_b.x, segment.point_b.y, segment.point_b.z},
                segment.radius);
            break;
        }
          default:
              throw std::runtime_error(
                  "createPhysicsAggregate supports only primitive physics "
                  "shapes without a supplied shape.");
      }
    }

    // \`createPhysicsBody\`: motion type, add to world, then transform --
    // in that order, because the solver resets a body's transform on add.
    PhysicsBody body{};
    body.node = mesh;
    body.shape = shape;
    body.motion_type = options.mass == 0.0
                           ? PhysicsMotionType::STATIC
                           : PhysicsMotionType::DYNAMIC;
    body.handle = pal::physics_body_create();
    pal::physics_body_set_motion_type(
        body.handle, pinned_motion_type(body.motion_type));
    pal::physics_world_add_body(
        world.handle, body.handle, options.start_asleep);
    sync_node_to_body(engine, body, false);

    // \`setPhysicsBodyShape\`, then the material, then the mass. The order
    // is the pin's and is observable: mass derives from the shape.
    pal::physics_body_set_shape(body.handle, shape.handle);

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

    world.bodies.push_back(body);
    return PhysicsAggregate{body, shape};
}

}  // namespace bbl::upstream
`;

    return {
      header,
      source,
      modulePath: havokModule,
      symbolName: "createHavokWorld",
    };
  }
}
