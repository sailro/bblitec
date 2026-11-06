import ts from "typescript";
import { finalReturn } from "../compiler/loop-control.js";
import {
    conditionalExpression,
    equalityOperator,
    isOperandSelection,
    jsonScalarLiteral,
    notJson,
    operandYield,
    propertyKey,
    sameSource,
    selectionArms,
    type ValueClass,
} from "../compiler/syntax.js";
import type { LoweringContext } from "./context.js";
import { topLevelFunctionDeclaration } from "./context.js";
import { foldNumericBinary } from "./pinned-operators.js";

/**
 * The front face each material family's camera-pass pipeline states, read
 * from the family's pipeline descriptor as the build folds it.
 *
 * Every family answers from one per-mesh fact, the winding mark: the glTF
 * loader's `frontFace: "cw"` / `_primitiveFeatures` bit 11, kept live by
 * the mirrored-mesh opt-in. The answer is a pair of faces, for a mesh
 * without and with the mark. A left-handed PBR descriptor spreads the
 * mesh's own primitive state (`cw` when marked); a right-handed one
 * reverses whatever results, because its view matrix mirrors Z
 * (`#coordinate-system`).
 */

type FrontFace = "cw" | "ccw";

/** A pair of values: for a mesh without the winding mark, then with it. */
type Lanes<T> = readonly [unmarked: T, marked: T];

type Value = string | number | boolean | null | undefined;

/** An object's `frontFace` per lane; `undefined` where it states none. */
type FaceLanes = Lanes<FrontFace | undefined>;

/** The faces a family's camera pass winds a mesh without, then with, the mark. */
export type FamilyFrontFaces = Lanes<FrontFace>;

export interface PipelineFrontFaces {
    readonly pbr: FamilyFrontFaces;
    readonly standard: FamilyFrontFaces;
    readonly shader: FamilyFrontFaces;
    readonly node: FamilyFrontFaces;
}

/** How a descriptor reads the mark, by the source shapes it spells it with. */
interface Scope {
    readonly file: ts.SourceFile;
    /** Values that carry the mark (a feature word, a variant key test). */
    readonly values: ReadonlyArray<readonly [string, Lanes<Value>]>;
    /** Objects that carry it (the mesh's primitive partial). */
    readonly objects?: ReadonlyArray<readonly [string, FaceLanes]>;
    /** Functions an opt-in installs, by the name the descriptor calls. */
    readonly installed?: ReadonlyMap<string, ts.FunctionDeclaration>;
    /** A called function's parameters, bound to its arguments. */
    readonly parameters?: ReadonlyMap<string, Lanes<Value> | undefined>;
}

const lanes = [0, 1] as const;

/** The value class (syntax.ts) a lane's value belongs to. */
const valueClass = (value: Value): ValueClass =>
    value === null || value === undefined
        ? "nullish"
        : value
          ? "truthy"
          : "falsy";

/** The mark as a feature word carries it: bit 11 clear, then set. */
const markWord = (shape: string): readonly [string, Lanes<Value>] => [
    shape,
    [0, 1 << 11],
];

class FrontFaceReader {
    public constructor(private readonly context: LoweringContext) {}

    private refuse(node: ts.Node, message: string): never {
        return this.context.contractError(
            node,
            `Pinned pipeline front face: ${message}`,
        );
    }

    /** A value per lane, or undefined where the descriptor does not decide it. */
    private value(node: ts.Expression, scope: Scope): Lanes<Value> | undefined {
        node = this.context.unwrapExpression(node);
        const bound = scope.values.find(([shape]) => sameSource(node, shape));
        if (bound) return bound[1];
        const literal = jsonScalarLiteral(node);
        if (literal !== notJson) return [literal, literal];
        if (ts.isIdentifier(node))
            return node.text === "undefined"
                ? [undefined, undefined]
                : scope.parameters?.get(node.text);
        const selection = conditionalExpression(node);
        if (selection) {
            const test = this.value(selection.condition, scope);
            const [truthy, falsy] = selectionArms(selection).map((arm) =>
                this.value(arm, scope),
            );
            if (!truthy || !falsy) return undefined;
            if (test)
                return [
                    test[0] ? truthy[0] : falsy[0],
                    test[1] ? truthy[1] : falsy[1],
                ];
            return lanes.every((lane) => truthy[lane] === falsy[lane])
                ? truthy
                : undefined;
        }
        if (!ts.isBinaryExpression(node)) return undefined;
        const left = this.value(node.left, scope);
        const right = this.value(node.right, scope);
        if (!left || !right) return undefined;
        const kind = node.operatorToken.kind;
        const equality = equalityOperator(kind);
        // `??`, `||`, `&&` and `,` yield the left operand for the values
        // syntax.ts names (`operandYield`), the right one otherwise.
        const yielded = isOperandSelection(node)
            ? (operandYield(node, node.left) ?? new Set<ValueClass>())
            : undefined;
        const results = lanes.map((lane): { value: Value } | undefined => {
            const a = left[lane];
            const b = right[lane];
            if (yielded) return { value: yielded.has(valueClass(a)) ? a : b };
            if (equality) {
                const nullish = (value: Value) =>
                    value === null || value === undefined;
                const equal = !equality.loose
                    ? a === b
                    : nullish(a) || nullish(b)
                      ? nullish(a) && nullish(b)
                      : typeof a === typeof b
                        ? a === b
                        : undefined;
                return equal === undefined
                    ? undefined
                    : { value: equal !== equality.negated };
            }
            const folded =
                typeof a === "number" && typeof b === "number"
                    ? foldNumericBinary(kind, a, b)
                    : undefined;
            return folded === undefined ? undefined : { value: folded };
        });
        return results[0] && results[1]
            ? [results[0].value, results[1].value]
            : undefined;
    }

    /**
     * A call of a module function (or of one an opt-in installs) whose body
     * returns one expression: that expression, over the call's arguments.
     */
    private inlined(
        node: ts.Expression,
        scope: Scope,
    ): { returned: ts.Expression; scope: Scope } | undefined {
        if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression))
            return undefined;
        const name = node.expression.text;
        const declaration =
            scope.installed?.get(name) ??
            topLevelFunctionDeclaration(scope.file, name);
        if (!declaration) return undefined;
        const returned = finalReturn(declaration.body)?.expression;
        if (!returned || declaration.body!.statements.length !== 1)
            return this.refuse(
                declaration,
                `${name} no longer returns one expression.`,
            );
        const parameters = new Map<string, Lanes<Value> | undefined>();
        declaration.parameters.forEach((parameter, index) => {
            const argument = node.arguments[index];
            if (ts.isIdentifier(parameter.name))
                parameters.set(
                    parameter.name.text,
                    argument
                        ? this.value(argument, scope)
                        : [undefined, undefined],
                );
        });
        return {
            returned,
            scope: { ...scope, file: declaration.getSourceFile(), parameters },
        };
    }

    /**
     * A conditional's lanes: each lane reads only the arm its test selects
     * (an opt-in's resolver exists only where its arm is reached); an
     * undecided test needs both arms to agree.
     */
    private conditional<T extends FrontFace | undefined>(
        node: ts.ConditionalExpression,
        scope: Scope,
        arm: (node: ts.Expression) => Lanes<T>,
    ): Lanes<T> {
        const test = this.value(node.condition, scope);
        const [truthyArm, falsyArm] = selectionArms(node);
        if (test)
            return [
                arm(test[0] ? truthyArm : falsyArm)[0],
                arm(test[1] ? truthyArm : falsyArm)[1],
            ];
        const truthy = arm(truthyArm);
        const falsy = arm(falsyArm);
        if (lanes.some((lane) => truthy[lane] !== falsy[lane]))
            this.refuse(
                node,
                "a test the winding mark does not decide chooses the face.",
            );
        return truthy;
    }

    /** A `frontFace` value per lane: an omitted face is WebGPU's `ccw`. */
    private face(node: ts.Expression, scope: Scope): FamilyFrontFaces {
        node = this.context.unwrapExpression(node);
        const selection = conditionalExpression(node);
        if (selection)
            return this.conditional(selection, scope, (arm) =>
                this.face(arm, scope),
            );
        const call = this.inlined(node, scope);
        if (call) return this.face(call.returned, call.scope);
        const values = this.value(node, scope);
        if (!values)
            return this.refuse(
                node,
                "the winding mark does not decide the face.",
            );
        const face = (value: Value): FrontFace => {
            if (value === undefined) return "ccw";
            if (value === "cw" || value === "ccw") return value;
            return this.refuse(node, `'${String(value)}' is not a front face.`);
        };
        return [face(values[0]), face(values[1])];
    }

    /** The `frontFace` an object-valued expression states, per lane. */
    private objectFace(node: ts.Expression, scope: Scope): FaceLanes {
        node = this.context.unwrapExpression(node);
        const carrier = scope.objects?.find(([shape]) =>
            sameSource(node, shape),
        );
        if (carrier) return carrier[1];
        const selection = conditionalExpression(node);
        if (selection)
            return this.conditional(selection, scope, (arm) =>
                this.objectFace(arm, scope),
            );
        const call = this.inlined(node, scope);
        if (call) return this.objectFace(call.returned, call.scope);
        if (!ts.isObjectLiteralExpression(node))
            return this.refuse(
                node,
                "the build does not decide this primitive state.",
            );
        // The last property stating a face wins, per lane.
        const faces: [FrontFace | undefined, FrontFace | undefined] = [
            undefined,
            undefined,
        ];
        for (const property of [...node.properties].reverse()) {
            if (faces[0] && faces[1]) break;
            let stated: FaceLanes | undefined;
            if (ts.isSpreadAssignment(property))
                stated = this.objectFace(property.expression, scope);
            else if (
                ts.isPropertyAssignment(property) &&
                propertyKey(property.name) === "frontFace"
            )
                stated = this.face(property.initializer, scope);
            else if (
                ts.isShorthandPropertyAssignment(property) &&
                property.name.text === "frontFace"
            )
                this.refuse(property, "the face is a shorthand property.");
            if (stated) for (const lane of lanes) faces[lane] ??= stated[lane];
        }
        return faces;
    }

    /** The faces a primitive state draws at: an unstated face is `ccw`. */
    public faces(node: ts.Expression, scope: Scope): FamilyFrontFaces {
        const [unmarked, marked] = this.objectFace(node, scope);
        return [unmarked ?? "ccw", marked ?? "ccw"];
    }
}

/** The one `primitive` state (a property, or a variable) under `root`. */
function primitiveState(
    context: LoweringContext,
    root: ts.Node,
    label: string,
): ts.Expression {
    const states = context.findNodes(
        root,
        (node): node is ts.PropertyAssignment | ts.VariableDeclaration =>
            (ts.isPropertyAssignment(node) &&
                propertyKey(node.name) === "primitive") ||
            (ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === "primitive" &&
                node.initializer !== undefined),
    );
    if (states.length !== 1)
        return context.contractError(
            root,
            `Expected ${label} to state one primitive state, found ${states.length}.`,
        );
    return states[0]!.initializer!;
}

/** The module function an opt-in installs through `installer(fn)`. */
function installedFunction(
    context: LoweringContext,
    module: string,
    installer: string,
): ts.FunctionDeclaration {
    const file = context.sourceFile(module);
    const calls = context.findNodes(
        file,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === installer,
    );
    const argument = calls[0]?.arguments[0];
    const declaration =
        calls.length === 1 && argument && ts.isIdentifier(argument)
            ? topLevelFunctionDeclaration(file, argument.text)
            : undefined;
    if (!declaration)
        return context.contractError(
            file,
            `Expected ${module} to install one module function through ${installer}.`,
        );
    return declaration;
}

/**
 * Each family's camera-pass front faces. A draw keys one pipeline kind for
 * its camera pass and its geometry views, so each geometry view's own
 * descriptor is read too and must agree. `mirroredMeshes`: the program
 * reaches `enableMirroredMeshes`, whose module installs the Standard
 * resolvers.
 */
export function lowerPipelineFrontFaces(
    context: LoweringContext,
    mirroredMeshes: boolean,
): PipelineFrontFaces {
    const reader = new FrontFaceReader(context);
    const resolver = (
        name: string,
        installer: string,
    ): {
        value: readonly [string, Lanes<Value>];
        installed: ReadonlyMap<string, ts.FunctionDeclaration>;
    } => ({
        value: [name, mirroredMeshes ? [true, true] : [null, null]],
        installed: new Map(
            mirroredMeshes
                ? [
                      [
                          name,
                          installedFunction(
                              context,
                              "src/material/standard/std-mirrored-support.ts",
                              installer,
                          ),
                      ],
                  ]
                : [],
        ),
    });
    const read = (
        module: string,
        symbol: string | undefined,
        scope: Omit<Scope, "file">,
    ): FamilyFrontFaces => {
        const file = context.sourceFile(module);
        const root = symbol
            ? context.functionDeclaration(module, symbol).declaration
            : file;
        return reader.faces(primitiveState(context, root, symbol ?? module), {
            ...scope,
            file,
        });
    };
    // PBR spreads the mesh's primitive partial, whose `frontFace` the glTF
    // loader and the mirrored opt-in write.
    const partial = (owner: string): Omit<Scope, "file"> => ({
        values: [[`${owner}._prim?.frontFace`, [undefined, "cw"]]],
        objects: [[`${owner}._prim`, [undefined, "cw"]]],
    });
    const standardResolver = resolver(
        "_stdPrimitiveResolver",
        "_installStdPrimitiveResolver",
    );
    const geometryWinding = resolver(
        "_geometryWinding",
        "_installStdGeometryWinding",
    );
    const pbr = read(
        "src/material/pbr/pbr-pipeline.ts",
        "getOrCreatePbrPipeline",
        partial("composed"),
    );
    const standard = read(
        "src/material/standard/standard-pipeline.ts",
        "getOrCreateStandardPipeline",
        {
            values: [
                standardResolver.value,
                markWord("bindings._meshFeatures"),
            ],
            installed: standardResolver.installed,
        },
    );
    // A shader renderable keys a marked mesh's pipeline "|ccw".
    const shader = read(
        "src/material/shader/shader-pipeline.ts",
        "getOrCreateShaderPipeline",
        { values: [['variantKey.includes("|ccw")', [false, true]]] },
    );
    const node = nodeFrontFaces(context, reader);
    for (const [module, view, forward] of [
        [
            "src/material/pbr/pbr-geometry-renderable.ts",
            read(
                "src/material/pbr/pbr-geometry-renderable.ts",
                undefined,
                partial("res._composed"),
            ),
            pbr,
        ],
        [
            "src/material/standard/standard-geometry-renderable.ts",
            read(
                "src/material/standard/standard-geometry-renderable.ts",
                undefined,
                {
                    values: [
                        geometryWinding.value,
                        markWord("res._meshFeatures"),
                    ],
                    installed: geometryWinding.installed,
                },
            ),
            standard,
        ],
        [
            "src/material/node/node-geometry-renderable.ts",
            node.geometry,
            node.forward,
        ],
    ] as const)
        if (lanes.some((lane) => view[lane] !== forward[lane]))
            context.contractError(
                context.sourceFile(module),
                `The pinned geometry view winds [${view.join(", ")}] where its camera pass winds [${forward.join(", ")}].`,
            );
    return { pbr, standard, shader, node: node.forward };
}

/**
 * A node graph compiles one descriptor, whose face serves an unmarked
 * mesh; a marked one binds `_pipelineForCcwMesh` where the build assigns
 * it, which restates that primitive state with its own face. The forward
 * renderable and the geometry view select it by the mark.
 */
function nodeFrontFaces(
    context: LoweringContext,
    reader: FrontFaceReader,
): { forward: FamilyFrontFaces; geometry: FamilyFrontFaces } {
    const { file, declaration } = context.functionDeclaration(
        "src/material/node/node-pipeline.ts",
        "compileNodePipeline",
    );
    const scope: Scope = { file, values: [] };
    // The camera pass compiles without a geometry view's MRT descriptor.
    const initializer = context.variableInitializer(declaration, "descriptor");
    const descriptor = conditionalExpression(initializer);
    if (!descriptor || !sameSource(descriptor.condition, "mrt"))
        return context.contractError(
            initializer,
            "Expected the node descriptor to be a geometry view's or the camera pass's.",
        );
    const unmarked = reader.faces(
        primitiveState(
            context,
            selectionArms(descriptor)[1],
            "the node camera pass",
        ),
        scope,
    )[0];
    const assigned = context.findNodes(
        declaration,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            sameSource(node.left, "result._pipelineForCcwMesh"),
    );
    const selects = (module: string): boolean =>
        context.hasNode(context.sourceFile(module), (node) => {
            const selection = ts.isExpression(node)
                ? conditionalExpression(node)
                : undefined;
            return (
                selection !== undefined &&
                context.hasNode(selectionArms(selection)[0], (inner) =>
                    sameSource(inner, "compile._pipelineForCcwMesh"),
                )
            );
        });
    const forwardSelects = selects("src/material/node/node-renderable.ts");
    const geometrySelects = selects(
        "src/material/node/node-geometry-renderable.ts",
    );
    if (assigned.length > 1 || (assigned.length === 1) !== forwardSelects)
        context.contractError(
            declaration,
            "Expected the marked node pipeline to be assigned exactly where its renderables select it.",
        );
    const marked = assigned[0]
        ? reader.faces(
              primitiveState(
                  context,
                  assigned[0].right,
                  "the marked node pipeline",
              ),
              scope,
          )[1]
        : unmarked;
    const geometryFile = context.sourceFile(
        "src/material/node/node-geometry-renderable.ts",
    );
    const geometryUnmarked = reader.faces(
        primitiveState(context, geometryFile, "the node geometry view"),
        { file: geometryFile, values: [] },
    )[0];
    return {
        forward: [unmarked, marked],
        geometry: [
            geometryUnmarked,
            geometrySelects ? marked : geometryUnmarked,
        ],
    };
}

/**
 * `render_pipeline_clockwise`: the lowered faces as one switch over the
 * family, for the mesh's winding mark `reverse_winding`.
 */
export function renderPipelineClockwiseCpp(faces: PipelineFrontFaces): string {
    const arm = ([unmarked, marked]: FamilyFrontFaces): string =>
        unmarked === marked
            ? String(unmarked === "cw")
            : unmarked === "cw"
              ? "!reverse_winding"
              : "reverse_winding";
    return `/**
 * Whether a family's camera-pass pipeline winds front faces clockwise, for
 * a mesh's winding mark (\`_primitiveFeatures\` bit 11, the glTF primitive's
 * "cw"): the face each family's pipeline descriptor states as the build
 * folds it (pbr-pipeline.ts, standard-pipeline.ts, shader-pipeline.ts,
 * node-pipeline.ts).
 */
constexpr bool render_pipeline_clockwise(RenderMaterialKind family, [[maybe_unused]] bool reverse_winding) {
    switch (family) {
        case RenderMaterialKind::pbr:
            return ${arm(faces.pbr)};
        case RenderMaterialKind::standard:
            return ${arm(faces.standard)};
        case RenderMaterialKind::shader:
            return ${arm(faces.shader)};
        case RenderMaterialKind::node:
            return ${arm(faces.node)};
    }
    return false;
}`;
}
