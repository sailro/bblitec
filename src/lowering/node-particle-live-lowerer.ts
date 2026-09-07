/**
 * A LIVE node-particle system, lowered from the pin's own block evaluators.
 *
 * The frozen bake (`src/pinned-node-particle.ts`) executes the pin because
 * the corpus scenes seed `Math.random` through `Math.sin`, which is not
 * bit-portable, and because the graph build is closures the compiler does
 * not lower. A live system -- one the renderer animates every frame from
 * `renderer._beforeUpdate` -- has neither excuse: the demo draws from the
 * harness's own mulberry32 stub, which `bbl::js::random_js` is bit for bit,
 * and the closures the build installs are functions of the graph's static
 * wiring. So this module PARTIALLY EVALUATES each evaluator's `build` at
 * generation, with the parsed graph as its static input, and RESIDUALISES
 * the `(i) => ...` closures it installs as C++ functions:
 *
 *   - Everything the build decides from the graph -- which input is
 *     connected, which literal it carries, a serialized lock mode, the
 *     contextual source a `switch` selects, the scratch records and `let`
 *     cells the closures capture -- is decided here, by evaluating the
 *     pinned build-time statements over plain data.
 *   - Everything a closure does per particle is translated by
 *     `PinnedNumericLowerer` from the closure's own body, with the captured
 *     environment bound: a column is its typed storage, a scratch record a
 *     struct member, a getter a call to the function its own closure
 *     lowered to, and every shape test (`typeof min === "number"`,
 *     `"r" in min`) an answer the graph already gave.
 *
 * Nothing about the arithmetic is restated: the simulation loop, the
 * creation-slot order, the per-component random draws and the death clamp
 * all come from the pinned declarations, and a construct this module does
 * not recognise fails generation by name. The executed pin still runs in
 * the bake driver, and what it reports about the built system -- its
 * installed slots, step count, scalar settings and traversal order -- is
 * checked against what the evaluation here derived, so a drift between the
 * pin's build and this port's is a generation failure rather than a
 * different set of particles.
 */
import ts from "typescript";
import { doubleLiteral, floatLiteral, snakeCase } from "../cpp-literals.js";
import { LoweringContext } from "./context.js";
import {
    lowerPinnedFunction,
    lowerPinnedFunctionParts,
    type PinnedFunctionParameter,
} from "./pinned-function-lowerer.js";
import {
    absentBinding,
    callShapeOf,
    isRecordType,
    type PinnedBinding,
    PinnedNumericLowerer,
    type PinnedNumericScope,
    RECORD_SHAPES,
    recordLiteralCpp,
    type RecordShapeType,
    recordTypeOfAnnotation,
    recordTypeOfMembers,
} from "./pinned-numeric-lowerer.js";
import { pinnedNumericMathCalls } from "./pinned-operators.js";
import { lowerNodeParticleProviderShared, lowerNodeParticleProviderState } from "./node-particle-provider-lowerer.js";

const buildModule = "src/particle/node/npe-build.ts";
const systemModule = "src/particle/particle-system.ts";
const bufferModule = "src/particle/particle-buffer.ts";
const registryModule = "src/particle/node/npe-registry.ts";

/** One parsed input, as the pin's `ParsedParticleInput` serializes. */
export interface LiveGraphInput {
    name: string;
    targetBlockId: number | null;
    targetConnectionName: string | null;
    value?: unknown;
    valueType?: string;
}

/** One parsed block, as the pin's `ParsedParticleBlock` serializes. */
export interface LiveGraphBlock {
    id: number;
    className: string;
    name: string;
    inputs: LiveGraphInput[];
    serialized: Record<string, unknown>;
}

/** The pin's `ParticleGraph`, with its block map flattened for transport. */
export interface LiveGraph {
    blocks: LiveGraphBlock[];
    systemBlockIds: number[];
}

/**
 * The eight creation slots, in the pin's own order -- asserted against
 * `createParticleSystem`'s returned literal, whose `create*` members are
 * these and no others.
 */
export const SLOT_NAMES = [
    "createLifeTime",
    "createPosition",
    "createDirection",
    "createEmitPower",
    "createSize",
    "createAngle",
    "createColor",
    "createColorDead",
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

/**
 * The optional hooks a feature installs on a system -- asserted against the `ParticleSystem`
 * interface's optional members.
 */
export const HOOK_NAMES = [
    "_emitRateGetter",
    "_prepareFrame",
    "_spriteSheet",
    "_writeColorDead",
    "_suppressInitialDirectionCapture",
    "_seedLocalPosition",
    "_registerBillboard",
] as const;
export type HookName = (typeof HOOK_NAMES)[number];

/**
 * What the executed pin reported about one live system, read off the
 * `ParticleSystem` its own build produced. Every field is a cross-check on
 * the evaluation this module performs, not an input to it.
 */
export interface LiveSystemFacts {
    set: number;
    system: number;
    systemBlockId: number;
    capacity: number;
    emitRate: number;
    updateSpeed: number;
    blendMode: number;
    targetStopDuration: number;
    updateSteps: number;
    slots: Record<SlotName, boolean>;
    hooks: Record<HookName, boolean>;
    emitter: readonly [number, number, number];
    emitterWorldMatrix: readonly number[];
    /**
     * Every block lookup the pin's `buildNodeParticleSet` made for the
     * whole SET, in order: each root once from the set loop, then the
     * lookups of that root's `buildBlock` walk.
     */
    visitOrder: readonly number[];
}

export interface LoweredLiveSystem {
    /** The C++ namespace holding this system's state and functions. */
    namespace: string;
    source: string;
}

// ── Static values ────────────────────────────────────────────────────────────

/** One buffer column: its pinned name, its storage and its C++ member. */
interface ColumnSpec {
    name: string;
    element: "f32" | "f64" | "u32" | "u8";
    cpp: string;
}

/** Each column width's native storage, binding type and zero. */
const COLUMN_STORAGE: Record<
    ColumnSpec["element"],
    { vector: string; binding: PinnedBinding["type"]; zero: string }
> = {
    f32: { vector: "std::vector<float>", binding: "f32", zero: "0.0f" },
    f64: { vector: "std::vector<double>", binding: "f64-buffer", zero: "0.0" },
    u32: { vector: "std::vector<std::uint32_t>", binding: "u32", zero: "0u" },
    u8: { vector: "std::vector<std::uint8_t>", binding: "u8", zero: "0u" },
};

const COLUMN_CONSTRUCTORS = new Map<string, ColumnSpec["element"]>([
    ["Float32Array", "f32"], ["Float64Array", "f64"],
    ["Uint32Array", "u32"], ["Uint8Array", "u8"],
]);

/** A `let` the build declares and a closure may capture and mutate. */
interface Cell {
    name: string;
    value: StaticValue;
    member?: string;
    type?: PinnedBinding["type"];
}

/** An object literal the build evaluated: a scratch record once a closure reaches it. */
interface RecordValue {
    type: RecordShapeType;
    initial: number[];
    member?: string;
}

/** A pinned arrow the build installed, with the environment it closed over. */
interface Closure {
    arrow: ts.ArrowFunction | ts.FunctionExpression;
    env: Env;
    file: ts.SourceFile;
    module: string;
    blockId: number;
    /** The C++ name, given where the closure is installed or first reached. */
    cpp?: string;
    /** The shape the lowered body returns, once lowered. */
    shape?: PinnedBinding["type"] | "void";
}

/** A pinned module function, reachable by import or in its own module. */
interface PinnedFunction {
    declaration: ts.FunctionDeclaration;
    file: ts.SourceFile;
    module: string;
}

type StaticValue =
    | { k: "number"; value: number }
    | { k: "boolean"; value: boolean }
    | { k: "string"; value: string }
    | { k: "undefined" }
    | { k: "null" }
    | { k: "json"; value: unknown }
    | { k: "block"; block: LiveGraphBlock }
    | { k: "ctx" }
    | { k: "ctx-method"; name: string }
    | { k: "state" }
    | { k: "system" }
    | { k: "buffer" }
    | { k: "matrix" }
    | { k: "emitter" }
    | { k: "step-list" }
    | { k: "column"; column: ColumnSpec }
    | { k: "column-constructor"; element: ColumnSpec["element"] }
    | { k: "record"; record: RecordValue }
    | { k: "cell"; cell: Cell }
    | { k: "closure"; closure: Closure }
    | { k: "function"; fn: PinnedFunction }
    | { k: "constant-getter"; value: number | RecordValue | null }
    | { k: "array-builtin"; name: string };

class Env {
    private readonly vars = new Map<string, StaticValue>();

    public constructor(public readonly parent?: Env) {}

    public lookup(name: string): StaticValue | undefined {
        return this.vars.get(name) ?? this.parent?.lookup(name);
    }

    public declare(name: string, value: StaticValue): void {
        this.vars.set(name, value);
    }
}

/** How a build-time statement list ended. */
type Completion =
    | { kind: "normal" }
    | { kind: "return"; value: StaticValue }
    | { kind: "break" };

const NORMAL: Completion = { kind: "normal" };

/** The calls every residual body may make: the Math table and the pinned generator. */
function pinnedCalls(): Map<string, (args: readonly string[]) => string> {
    const calls = pinnedNumericMathCalls();
    calls.set("Math.random", () => "bbl::js::random_js()");
    return calls;
}

/** `steps[s]!(i)` over the emitted step table, which takes the state first. */
const indexedCall: NonNullable<PinnedNumericScope["indexedCall"]> = (
    list,
    index,
    args,
) => `${list.cpp}[static_cast<std::size_t>(${index})](state, ${args.join(", ")})`;

function recordDeclaration(cpp: string, type: RecordShapeType, initial: readonly number[]): string {
    return `${RECORD_SHAPES.get(type)!.storage} ${cpp}{${initial
        .map((value) => doubleLiteral(value))
        .join(", ")}};`;
}

function isTruthy(value: StaticValue): boolean {
    switch (value.k) {
        case "number":
            return value.value !== 0 && !Number.isNaN(value.value);
        case "boolean":
            return value.value;
        case "string":
            return value.value.length > 0;
        case "undefined":
        case "null":
            return false;
        case "json":
            return Boolean(value.value);
        default:
            return true;
    }
}

function typeofName(value: StaticValue): string {
    switch (value.k) {
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        case "string":
            return "string";
        case "undefined":
            return "undefined";
        case "null":
            return "object";
        case "json":
            return value.value === null ? "object" : typeof value.value;
        case "closure":
        case "function":
        case "constant-getter":
        case "array-builtin":
        case "ctx-method":
            return "function";
        default:
            return "object";
    }
}

/** A plain JSON value as the static value it is, one level at a time. */
function fromJson(value: unknown): StaticValue {
    if (value === undefined) return { k: "undefined" };
    if (value === null) return { k: "null" };
    if (typeof value === "number") return { k: "number", value };
    if (typeof value === "boolean") return { k: "boolean", value };
    if (typeof value === "string") return { k: "string", value };
    return { k: "json", value };
}

/** The raw value a primitive static value stands for, for `===`. */
function primitiveOf(value: StaticValue): unknown {
    switch (value.k) {
        case "number":
        case "boolean":
        case "string":
            return value.value;
        case "undefined":
            return undefined;
        case "null":
            return null;
        case "json":
            return value.value;
        default:
            return value;
    }
}

function strictEquals(left: StaticValue, right: StaticValue): boolean {
    return primitiveOf(left) === primitiveOf(right);
}

// ── The lowerer ──────────────────────────────────────────────────────────────

/**
 * One live system's lowering: the partial evaluation of its graph's
 * evaluators and the emission of the state, getters, steps, slots and
 * simulation loop that result.
 */
class SystemLowering {
    private readonly outputs = new Map<string, StaticValue>();
    private readonly slots = new Map<SlotName, Closure>();
    private readonly hooks = new Map<HookName, Closure>();
    private readonly dynamicColumns = new Map<string, ColumnSpec>();
    private readonly steps: Closure[] = [];
    private readonly systemInit = new Map<string, number>();
    /** Struct members by C++ name, in declaration order. */
    private readonly members = new Map<string, string>();
    private readonly functions: string[] = [];
    private readonly prototypes: string[] = [];
    private readonly blocks: Map<number, LiveGraphBlock>;
    private readonly moduleEnvs = new Map<string, Env>();
    private capacity = 0;
    private currentBlockId = -1;
    private instanceCounter = 0;

    public constructor(
        private readonly context: LoweringContext,
        private readonly owner: NodeParticleLiveLowerer,
        private readonly graph: LiveGraph,
        private readonly facts: LiveSystemFacts,
        private readonly columns: ColumnSpec[],
        private readonly systemFields: ReadonlyMap<string, number | boolean>,
        public readonly namespace: string,
        private readonly provider: boolean,
    ) {
        this.blocks = new Map(graph.blocks.map((block) => [block.id, block]));
    }

    // ── Traversal ─────────────────────────────────────────────────────────

    public lower(): string {
        this.capacity = this.pinnedCapacity();
        this.traverse(this.facts.systemBlockId, (block) => this.evaluateBlock(block));
        this.assertFacts();
        for (const closure of this.steps) this.lowerClosure(closure, "void");
        for (const closure of this.slots.values()) this.lowerClosure(closure, "void");
        for (const closure of this.hooks.values()) this.lowerClosure(closure, "void");
        if (this.provider) this.functions.push(lowerNodeParticleProviderState(this.context));
        const simulation = this.lowerSimulation();
        return this.emit(simulation);
    }

    /**
     * The pin's own `buildBlock` walk, restated over the parsed graph and
     * asserted against its source by `assertBuildWalk`: mark, recurse the
     * `particle` inputs, recurse the others, then build. `onBlock` runs at
     * the point the pin runs the evaluator, and `lookups` records every
     * block the pin would have looked up -- before the existence check,
     * as the pin does -- which `assertFacts` compares against the driver.
     */
    private traverse(
        root: number,
        onBlock: (block: LiveGraphBlock) => void,
        lookups: number[] = [],
    ): void {
        const built = new Set<number>();
        const visit = (blockId: number): void => {
            if (built.has(blockId)) return;
            built.add(blockId);
            lookups.push(blockId);
            const block = this.blocks.get(blockId);
            if (!block) return;
            for (const input of block.inputs) {
                if (input.name === "particle" && this.connected(input)) {
                    visit(input.targetBlockId!);
                }
            }
            for (const input of block.inputs) {
                if (input.name !== "particle" && this.connected(input)) {
                    visit(input.targetBlockId!);
                }
            }
            onBlock(block);
        };
        visit(root);
    }

    /**
     * Every lookup the pin's set loop makes: each root once from the loop
     * itself (a missing root is skipped there), then its walk.
     */
    private visitLog(): number[] {
        const log: number[] = [];
        for (const root of this.graph.systemBlockIds) {
            log.push(root);
            if (!this.blocks.has(root)) continue;
            this.traverse(root, () => undefined, log);
        }
        return log;
    }

    /** The pin's own `isInputConnected`, executed over the parsed input. */
    private connected(input: LiveGraphInput): boolean {
        const fn = this.owner.pinnedFunction(buildModule, "isInputConnected");
        return isTruthy(
            this.callFunction(fn, [{ k: "json", value: input }], fn.declaration),
        );
    }

    /**
     * `buildNodeParticleSet`'s own capacity rule, evaluated over the root
     * block: `typeof systemBlock.serialized.capacity === "number" ? ... : 1000`.
     */
    private pinnedCapacity(): number {
        const { file, declaration } = this.context.functionDeclaration(
            buildModule,
            "buildNodeParticleSet",
        );
        const env = new Env(this.moduleEnv(buildModule));
        env.declare("systemBlock", { k: "block", block: this.systemBlock() });
        const value = this.expression(
            this.context.variableInitializer(declaration, "capacity"),
            env,
            file,
            buildModule,
        );
        if (value.k !== "number") {
            this.context.contractError(declaration, "buildNodeParticleSet capacity");
        }
        return value.value;
    }

    private systemBlock(): LiveGraphBlock {
        const block = this.blocks.get(this.facts.systemBlockId);
        if (!block) {
            throw new Error(
                `The live graph has no block ${this.facts.systemBlockId} for its system.`,
            );
        }
        return block;
    }

    /** Run one block's pinned `build(block, ctx)` at generation. */
    private evaluateBlock(block: LiveGraphBlock): void {
        // The texture block's whole effect is the asynchronous
        // `loadTexture2D` onto `system.texture`, which the executed pin
        // performed and the bake packaged; nothing of it is per particle.
        if (block.className === "ParticleTextureSourceBlock") return;
        const { module, exportName } = this.owner.evaluatorFor(
            block,
            this.systemBlock().serialized.isLocal === true,
        );
        const file = this.context.sourceFile(module);
        const initializer = this.context.moduleScopeConstant(file, exportName);
        if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
            this.context.contractError(
                file,
                `Expected '${exportName}' to be an evaluator object literal.`,
            );
        }
        const build = initializer.properties.find(
            (property): property is ts.MethodDeclaration =>
                ts.isMethodDeclaration(property) &&
                ts.isIdentifier(property.name) &&
                property.name.text === "build",
        );
        if (!build?.body || build.parameters.length !== 2) {
            this.context.contractError(
                initializer,
                `Expected '${exportName}.build(block, ctx)'.`,
            );
        }
        const env = new Env(this.moduleEnv(module));
        const [blockParameter, ctxParameter] = build.parameters;
        env.declare(blockParameter!.name.getText(file), { k: "block", block });
        env.declare(ctxParameter!.name.getText(file), { k: "ctx" });
        this.currentBlockId = block.id;
        const completion = this.statements(build.body.statements, env, file, module);
        if (completion.kind === "break") {
            this.context.contractError(build, "A build body broke out of nothing.");
        }
    }

    /** The module-scope environment: constants and functions resolve lazily. */
    private moduleEnv(module: string): Env {
        let env = this.moduleEnvs.get(module);
        if (!env) {
            env = new Env();
            this.moduleEnvs.set(module, env);
        }
        return env;
    }

    /**
     * A name no local declared: `undefined`, `Array`, a module constant, a
     * same-module function or a named import -- or undefined when the
     * module declares none of these.
     */
    private findFree(
        name: string,
        file: ts.SourceFile,
        module: string,
    ): StaticValue | undefined {
        const env = this.moduleEnv(module);
        const cached = env.lookup(name);
        if (cached) return cached;
        if (name === "undefined") return { k: "undefined" };
        if (name === "Array") return { k: "array-builtin", name };
        const columnElement = COLUMN_CONSTRUCTORS.get(name);
        if (columnElement) return { k: "column-constructor", element: columnElement };
        const constant = this.context.moduleScopeConstant(file, name);
        if (constant) {
            const value = this.expression(constant, env, file, module);
            env.declare(name, value);
            return value;
        }
        const declaration = file.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) &&
                statement.name?.text === name &&
                statement.body !== undefined,
        );
        if (declaration) {
            const value: StaticValue = {
                k: "function",
                fn: { declaration, file, module },
            };
            env.declare(name, value);
            return value;
        }
        const imported = this.context.moduleOfImport(module, name);
        if (imported) {
            const value: StaticValue = {
                k: "function",
                fn: this.owner.pinnedFunction(imported, name),
            };
            env.declare(name, value);
            return value;
        }
        return undefined;
    }

    private resolveFree(
        name: string,
        file: ts.SourceFile,
        module: string,
        site: ts.Node,
    ): StaticValue {
        return (
            this.findFree(name, file, module) ??
            this.context.contractError(
                site,
                `The live node-particle lowering cannot resolve '${name}'.`,
            )
        );
    }

    // ── Build-time statements ─────────────────────────────────────────────

    private statements(
        statements: readonly ts.Statement[],
        env: Env,
        file: ts.SourceFile,
        module: string,
    ): Completion {
        for (const statement of statements) {
            const completion = this.statement(statement, env, file, module);
            if (completion.kind !== "normal") return completion;
        }
        return NORMAL;
    }

    private statement(
        statement: ts.Statement,
        env: Env,
        file: ts.SourceFile,
        module: string,
    ): Completion {
        if (ts.isVariableStatement(statement)) {
            const isLet =
                (statement.declarationList.flags & ts.NodeFlags.Const) === 0;
            for (const declaration of statement.declarationList.declarations) {
                const value = declaration.initializer
                    ? this.expression(declaration.initializer, env, file, module)
                    : ({ k: "undefined" } as StaticValue);
                if (ts.isObjectBindingPattern(declaration.name)) {
                    for (const element of declaration.name.elements) {
                        if (!ts.isIdentifier(element.name)) {
                            this.context.contractError(element, "binding element");
                        }
                        const property = element.propertyName
                            ? element.propertyName.getText(file)
                            : element.name.text;
                        env.declare(element.name.text, this.member(value, property, element));
                    }
                    continue;
                }
                if (!ts.isIdentifier(declaration.name)) {
                    this.context.contractError(declaration, "declaration name");
                }
                const name = declaration.name.text;
                env.declare(
                    name,
                    isLet ? { k: "cell", cell: { name, value } } : value,
                );
            }
            return NORMAL;
        }
        if (ts.isExpressionStatement(statement)) {
            this.effect(statement.expression, env, file, module);
            return NORMAL;
        }
        if (ts.isIfStatement(statement)) {
            const condition = this.expression(statement.expression, env, file, module);
            if (isTruthy(condition)) {
                return this.statement(statement.thenStatement, env, file, module);
            }
            return statement.elseStatement
                ? this.statement(statement.elseStatement, env, file, module)
                : NORMAL;
        }
        if (ts.isBlock(statement)) {
            return this.statements(statement.statements, new Env(env), file, module);
        }
        if (ts.isReturnStatement(statement)) {
            return {
                kind: "return",
                value: statement.expression
                    ? this.expression(statement.expression, env, file, module)
                    : { k: "undefined" },
            };
        }
        if (ts.isBreakStatement(statement)) return { kind: "break" };
        if (ts.isSwitchStatement(statement)) {
            const discriminant = this.expression(statement.expression, env, file, module);
            const clauses = statement.caseBlock.clauses;
            let selected = clauses.findIndex(
                (clause) =>
                    ts.isCaseClause(clause) &&
                    strictEquals(
                        discriminant,
                        this.expression(clause.expression, env, file, module),
                    ),
            );
            if (selected < 0) selected = clauses.findIndex(ts.isDefaultClause);
            if (selected < 0) return NORMAL;
            const scope = new Env(env);
            for (let index = selected; index < clauses.length; index += 1) {
                const completion = this.statements(
                    clauses[index]!.statements,
                    scope,
                    file,
                    module,
                );
                if (completion.kind === "break") return NORMAL;
                if (completion.kind === "return") return completion;
            }
            return NORMAL;
        }
        if (ts.isThrowStatement(statement)) {
            const thrown = this.context.unwrapExpression(statement.expression);
            const message =
                ts.isNewExpression(thrown) && thrown.arguments?.[0]
                    ? this.expression(thrown.arguments[0], env, file, module)
                    : undefined;
            throw new Error(
                "The pin's node-particle build threw while lowering block " +
                    `${this.currentBlockId}: ${
                        message?.k === "string" ? message.value : thrown.getText(file)
                    }`,
            );
        }
        return this.context.contractError(
            statement,
            "The live node-particle lowering does not evaluate this build-time statement.",
        );
    }

    /** An expression statement: an assignment or a call with an effect. */
    private effect(
        expression: ts.Expression,
        env: Env,
        file: ts.SourceFile,
        module: string,
    ): void {
        const node = this.context.unwrapExpression(expression);
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        ) {
            const value = this.expression(node.right, env, file, module);
            const target = this.context.unwrapExpression(node.left);
            if (ts.isIdentifier(target)) {
                const bound = env.lookup(target.text);
                if (bound?.k !== "cell") {
                    this.context.contractError(target, "assignment to a non-let binding");
                }
                bound.cell.value = value;
                return;
            }
            if (ts.isPropertyAccessExpression(target)) {
                const owner = this.expression(target.expression, env, file, module);
                this.assignMember(owner, target.name.text, value, target);
                return;
            }
            this.context.contractError(target, "assignment target");
        }
        if (ts.isCallExpression(node)) {
            this.expression(node, env, file, module);
            return;
        }
        this.context.contractError(node, "build-time expression statement");
    }

    /** `system.<field> = value` at build time: a setting, or an installed slot. */
    private assignMember(
        owner: StaticValue,
        name: string,
        value: StaticValue,
        site: ts.Node,
    ): void {
        if (owner.k !== "system") {
            this.context.contractError(site, `member assignment on ${owner.k}`);
        }
        if ((SLOT_NAMES as readonly string[]).includes(name)) {
            if (value.k !== "closure") {
                this.context.contractError(site, `slot '${name}' takes a closure`);
            }
            if (this.slots.has(name as SlotName)) {
                this.context.contractError(
                    site,
                    `The graph installs '${name}' twice; the live lowering has no wrapper for that.`,
                );
            }
            value.closure.cpp ??= snakeCase(name);
            this.slots.set(name as SlotName, value.closure);
            return;
        }
        if (this.systemFields.has(name) && value.k === "number") {
            this.systemInit.set(name, value.value);
            return;
        }
        if (name === "_seedLocalPosition" && value.k === "closure") {
            value.closure.cpp ??= snakeCase(name);
            this.hooks.set(name, value.closure);
            return;
        }
        this.context.contractError(
            site,
            `The live node-particle lowering does not install 'system.${name}'.`,
        );
    }

    // ── Build-time expressions ────────────────────────────────────────────

    private expression(
        expression: ts.Expression,
        env: Env,
        file: ts.SourceFile,
        module: string,
    ): StaticValue {
        const node = this.context.unwrapExpression(expression);
        if (ts.isNumericLiteral(node)) return { k: "number", value: Number(node.text) };
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            return { k: "string", value: node.text };
        }
        if (ts.isTemplateExpression(node)) {
            let text = node.head.text;
            for (const span of node.templateSpans) {
                const value = this.expression(span.expression, env, file, module);
                text += `${String(primitiveOf(value))}${span.literal.text}`;
            }
            return { k: "string", value: text };
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword) return { k: "boolean", value: true };
        if (node.kind === ts.SyntaxKind.FalseKeyword) return { k: "boolean", value: false };
        if (node.kind === ts.SyntaxKind.NullKeyword) return { k: "null" };
        if (ts.isIdentifier(node)) {
            const bound = env.lookup(node.text);
            if (bound) return bound.k === "cell" ? bound.cell.value : bound;
            return this.resolveFree(node.text, file, module, node);
        }
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.expression(node.expression, env, file, module);
            if (
                node.questionDotToken &&
                (owner.k === "undefined" || owner.k === "null")
            ) {
                return { k: "undefined" };
            }
            return this.member(owner, node.name.text, node);
        }
        if (ts.isElementAccessExpression(node)) {
            const owner = this.expression(node.expression, env, file, module);
            if (
                node.questionDotToken &&
                (owner.k === "undefined" || owner.k === "null")
            ) {
                return { k: "undefined" };
            }
            const index = this.expression(node.argumentExpression, env, file, module);
            if (owner.k === "json" && Array.isArray(owner.value) && index.k === "number") {
                return fromJson(owner.value[index.value]);
            }
            this.context.contractError(node, "build-time element access");
        }
        if (ts.isTypeOfExpression(node)) {
            return {
                k: "string",
                value: typeofName(this.expression(node.expression, env, file, module)),
            };
        }
        if (ts.isPrefixUnaryExpression(node)) {
            const operand = this.expression(node.operand, env, file, module);
            if (node.operator === ts.SyntaxKind.ExclamationToken) {
                return { k: "boolean", value: !isTruthy(operand) };
            }
            if (node.operator === ts.SyntaxKind.MinusToken && operand.k === "number") {
                return { k: "number", value: -operand.value };
            }
            this.context.contractError(node, "build-time prefix operator");
        }
        if (ts.isConditionalExpression(node)) {
            return isTruthy(this.expression(node.condition, env, file, module))
                ? this.expression(node.whenTrue, env, file, module)
                : this.expression(node.whenFalse, env, file, module);
        }
        if (ts.isBinaryExpression(node)) return this.binary(node, env, file, module);
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            return {
                k: "closure",
                closure: { arrow: node, env, file, module, blockId: this.currentBlockId },
            };
        }
        if (ts.isObjectLiteralExpression(node)) return this.objectLiteral(node, env, file, module);
        if (ts.isCallExpression(node)) return this.call(node, env, file, module);
        return this.context.contractError(
            node,
            "The live node-particle lowering does not evaluate this build-time expression.",
        );
    }

    private binary(
        node: ts.BinaryExpression,
        env: Env,
        file: ts.SourceFile,
        module: string,
    ): StaticValue {
        const kind = node.operatorToken.kind;
        if (kind === ts.SyntaxKind.AmpersandAmpersandToken) {
            const left = this.expression(node.left, env, file, module);
            return isTruthy(left) ? this.expression(node.right, env, file, module) : left;
        }
        if (kind === ts.SyntaxKind.BarBarToken) {
            const left = this.expression(node.left, env, file, module);
            return isTruthy(left) ? left : this.expression(node.right, env, file, module);
        }
        if (kind === ts.SyntaxKind.QuestionQuestionToken) {
            const left = this.expression(node.left, env, file, module);
            return left.k === "undefined" || left.k === "null"
                ? this.expression(node.right, env, file, module)
                : left;
        }
        const left = this.expression(node.left, env, file, module);
        const right = this.expression(node.right, env, file, module);
        switch (kind) {
            case ts.SyntaxKind.EqualsEqualsEqualsToken:
                return { k: "boolean", value: strictEquals(left, right) };
            case ts.SyntaxKind.ExclamationEqualsEqualsToken:
                return { k: "boolean", value: !strictEquals(left, right) };
            case ts.SyntaxKind.EqualsEqualsToken:
            case ts.SyntaxKind.ExclamationEqualsToken: {
                // The pin writes `!= null`, which is the one loose
                // comparison its build makes; both nullish values agree.
                const nullish = (value: StaticValue): boolean =>
                    value.k === "undefined" || value.k === "null";
                const equal =
                    nullish(left) || nullish(right)
                        ? nullish(left) && nullish(right)
                        : strictEquals(left, right);
                return {
                    k: "boolean",
                    value: kind === ts.SyntaxKind.EqualsEqualsToken ? equal : !equal,
                };
            }
            case ts.SyntaxKind.InKeyword:
                if (left.k === "string" && right.k === "record") {
                    return {
                        k: "boolean",
                        value: RECORD_SHAPES.get(right.record.type)!.members.includes(
                            left.value,
                        ),
                    };
                }
                break;
            default:
                break;
        }
        if (left.k === "number" && right.k === "number") {
            const a = left.value;
            const b = right.value;
            switch (kind) {
                case ts.SyntaxKind.LessThanToken:
                    return { k: "boolean", value: a < b };
                case ts.SyntaxKind.LessThanEqualsToken:
                    return { k: "boolean", value: a <= b };
                case ts.SyntaxKind.GreaterThanToken:
                    return { k: "boolean", value: a > b };
                case ts.SyntaxKind.GreaterThanEqualsToken:
                    return { k: "boolean", value: a >= b };
                case ts.SyntaxKind.PlusToken:
                    return { k: "number", value: a + b };
                case ts.SyntaxKind.MinusToken:
                    return { k: "number", value: a - b };
                case ts.SyntaxKind.AsteriskToken:
                    return { k: "number", value: a * b };
                case ts.SyntaxKind.SlashToken:
                    return { k: "number", value: a / b };
                default:
                    break;
            }
        }
        return this.context.contractError(node, "build-time binary operator");
    }

    /** `{ x: 0, y: 0, z: 0 }` -- a positional record the build allocates. */
    private objectLiteral(
        node: ts.ObjectLiteralExpression,
        env: Env,
        file: ts.SourceFile,
        module: string,
    ): StaticValue {
        const names: string[] = [];
        const initial: number[] = [];
        for (const property of node.properties) {
            if (
                !ts.isPropertyAssignment(property) ||
                !ts.isIdentifier(property.name)
            ) {
                this.context.contractError(property, "record literal member");
            }
            const value = this.expression(property.initializer, env, file, module);
            if (value.k !== "number") {
                this.context.contractError(
                    property,
                    "A build-time record literal carries numbers.",
                );
            }
            names.push(property.name.text);
            initial.push(value.value);
        }
        const type = recordTypeOfMembers(names);
        if (!type) {
            this.context.contractError(node, `record literal shape {${names.join(", ")}}`);
        }
        return { k: "record", record: { type, initial } };
    }

    /** One member read off a static value. */
    private member(owner: StaticValue, name: string, site: ts.Node): StaticValue {
        switch (owner.k) {
            case "json": {
                const value = owner.value;
                if (typeof value !== "object" || value === null) {
                    return { k: "undefined" };
                }
                return fromJson((value as Record<string, unknown>)[name]);
            }
            case "block": {
                const block = owner.block;
                if (name === "serialized") return { k: "json", value: block.serialized };
                if (name === "id") return { k: "number", value: block.id };
                if (name === "className") return { k: "string", value: block.className };
                if (name === "name") return { k: "string", value: block.name };
                if (name === "inputs") return { k: "json", value: block.inputs };
                break;
            }
            case "ctx":
                if (name === "state") return { k: "state" };
                return { k: "ctx-method", name };
            case "state":
                if (name === "system") return { k: "system" };
                if (name === "buffer") return { k: "buffer" };
                if (name === "emitter") return { k: "emitter" };
                if (name === "emitterWorldMatrix") return { k: "matrix" };
                if (name === "isLocal") {
                    return {
                        k: "boolean",
                        value: this.systemBlock().serialized.isLocal === true,
                    };
                }
                if (name === "capacity") return { k: "number", value: this.capacity };
                if (name === "textureBaseUrl") return { k: "undefined" };
                break;
            case "system":
                if (name === "buffer") return { k: "buffer" };
                if (name === "updateSteps") return { k: "step-list" };
                if (this.systemFields.has(name)) {
                    const value = this.systemInit.get(name) ?? this.systemFields.get(name)!;
                    return typeof value === "number"
                        ? { k: "number", value }
                        : { k: "boolean", value };
                }
                if ((HOOK_NAMES as readonly string[]).includes(name)) {
                    const closure = this.hooks.get(name as HookName);
                    if (closure) return { k: "closure", closure };
                    return { k: "undefined" };
                }
                break;
            case "buffer": {
                const column = this.columns.find((candidate) => candidate.name === name);
                if (column) return { k: "column", column };
                if (name === "capacity") return { k: "number", value: this.capacity };
                break;
            }
            case "record": {
                const index = RECORD_SHAPES.get(owner.record.type)!.members.indexOf(name);
                if (index >= 0) {
                    return { k: "number", value: owner.record.initial[index]! };
                }
                break;
            }
            case "array-builtin":
                if (name === "isArray") return { k: "array-builtin", name: "isArray" };
                break;
            default:
                break;
        }
        return this.context.contractError(
            site,
            `The live node-particle lowering does not read '${name}' off a ${owner.k} at build time.`,
        );
    }

    private call(
        node: ts.CallExpression,
        env: Env,
        file: ts.SourceFile,
        module: string,
    ): StaticValue {
        const args = node.arguments.map((argument) =>
            this.expression(argument, env, file, module),
        );
        // `system.updateSteps.push(step)`: the one method the build calls
        // on the system, appending a per-particle step in graph order.
        const method = this.context.unwrapExpression(node.expression);
        if (ts.isPropertyAccessExpression(method) && method.name.text === "push") {
            const owner = this.expression(method.expression, env, file, module);
            if (owner.k === "step-list") {
                const [step] = args;
                if (args.length !== 1 || step?.k !== "closure") {
                    this.context.contractError(node, "updateSteps.push takes one closure");
                }
                step.closure.cpp ??= `update_step_${this.currentBlockId}`;
                this.steps.push(step.closure);
                return { k: "number", value: this.steps.length };
            }
        }
        const callee = this.expression(node.expression, env, file, module);
        switch (callee.k) {
            case "ctx-method":
                return this.ctxCall(callee.name, args, node);
            case "array-builtin":
                if (callee.name === "isArray") {
                    const [value] = args;
                    return {
                        k: "boolean",
                        value: value?.k === "json" && Array.isArray(value.value),
                    };
                }
                break;
            case "function":
                return this.callFunction(callee.fn, args, node);
            case "constant-getter":
                // `ctx.input(block, "emitRate", () => 10)(0)`: the pin reads
                // a constant input once at build by calling its getter.
                if (callee.value === null) return { k: "null" };
                return typeof callee.value === "number"
                    ? { k: "number", value: callee.value }
                    : { k: "record", record: callee.value };
            case "closure": {
                // A closure called at build time: only a constant one has a
                // value here, since a per-particle body reads columns.
                const body = callee.closure.arrow.body;
                if (ts.isBlock(body)) {
                    const scope = new Env(callee.closure.env);
                    callee.closure.arrow.parameters.forEach((parameter, index) => {
                        scope.declare(
                            parameter.name.getText(callee.closure.file),
                            args[index] ?? { k: "undefined" },
                        );
                    });
                    const completion = this.statements(
                        body.statements,
                        scope,
                        callee.closure.file,
                        callee.closure.module,
                    );
                    return completion.kind === "return" ? completion.value : { k: "undefined" };
                }
                return this.expression(
                    body,
                    callee.closure.env,
                    callee.closure.file,
                    callee.closure.module,
                );
            }
            default:
                break;
        }
        return this.context.contractError(node, `build-time call of a ${callee.k}`);
    }

    /** A pinned module function evaluated at build time over static args. */
    private callFunction(
        fn: PinnedFunction,
        args: readonly StaticValue[],
        site: ts.Node,
    ): StaticValue {
        if (fn.module === bufferModule && fn.declaration.name?.text === "column") {
            const [buffer, name, ctor] = args;
            if (buffer?.k !== "buffer" || name?.k !== "string" || ctor?.k !== "column-constructor") {
                return this.context.contractError(site, "column requires a buffer, static name and typed-array constructor");
            }
            this.context.expectShapeCount(fn.declaration, "buffer._columns.get(name)", "column lookup");
            this.context.expectShapeCount(fn.declaration, "new ctor(buffer.capacity)", "column allocation");
            this.context.expectShapeCount(fn.declaration, "buffer._columns.set(name, created)", "column identity");
            this.context.expectShapeCount(fn.declaration, "buffer._all.push(created)", "column swap-remove membership");
            this.context.assertStatementInventory(fn.declaration, fn.declaration.body!.statements,
                "column", "optional columns preserve allocation and insertion order",
                ["variable statement", "if statement", "variable statement", "expression statement", "expression statement", "return statement"]);
            const reuse = fn.declaration.body!.statements.find(ts.isIfStatement)!;
            this.context.assertExpressionShape(reuse.expression, "existing", "column reuse guard");
            const returned = this.context.findNodes(reuse.thenStatement, ts.isReturnStatement);
            if (reuse.elseStatement || returned.length !== 1 || !returned[0]!.expression) {
                this.context.contractError(reuse, "column must return existing storage before allocation");
            }
            this.context.assertExpressionShape(returned[0]!.expression!, "existing as T", "column reused storage");
            let column = this.dynamicColumns.get(name.value);
            if (!column) {
                column = { name: name.value, element: ctor.element,
                    cpp: `column_${snakeCase(name.value.replace(/[^a-zA-Z0-9_]/g, "_"))}` };
                if (this.columns.some((existing) => existing.cpp === column!.cpp)) {
                    return this.context.contractError(site, `column '${name.value}' has a colliding native name`);
                }
                this.dynamicColumns.set(name.value, column);
                this.columns.push(column);
            }
            return { k: "column", column };
        }
        const scope = new Env(this.moduleEnv(fn.module));
        fn.declaration.parameters.forEach((parameter, index) => {
            if (!ts.isIdentifier(parameter.name)) {
                this.context.contractError(parameter, "parameter name");
            }
            scope.declare(parameter.name.text, args[index] ?? { k: "undefined" });
        });
        const completion = this.statements(
            fn.declaration.body!.statements,
            scope,
            fn.file,
            fn.module,
        );
        if (completion.kind === "break") {
            this.context.contractError(site, "a function broke out of nothing");
        }
        return completion.kind === "return" ? completion.value : { k: "undefined" };
    }

    /**
     * The build context's own methods, as the pin's `buildNodeParticleSet`
     * defines them and `assertBuildContext` checks: a connected input is
     * the getter its source published, an unconnected one its parsed
     * literal, and otherwise the fallback the block supplied.
     */
    private ctxCall(
        method: string,
        args: readonly StaticValue[],
        site: ts.Node,
    ): StaticValue {
        const block = args[0]?.k === "block" ? args[0].block : undefined;
        switch (method) {
            case "isConnected": {
                const name = args[1];
                if (!block || name?.k !== "string") break;
                const input = block.inputs.find((candidate) => candidate.name === name.value);
                return { k: "boolean", value: input !== undefined && this.connected(input) };
            }
            case "input": {
                const name = args[1];
                if (!block || name?.k !== "string") break;
                const input = block.inputs.find((candidate) => candidate.name === name.value);
                if (input && this.connected(input)) {
                    const getter = this.outputs.get(
                        `${input.targetBlockId}:${input.targetConnectionName}`,
                    );
                    if (getter) return getter;
                    throw new Error(
                        `NodeParticle: unresolved connection ${block.className}.${name.value}`,
                    );
                }
                if (input) {
                    const literal = this.parseInputLiteral(input);
                    if (literal !== undefined) return literal;
                }
                const fallback = args[2];
                if (fallback === undefined || fallback.k === "undefined") {
                    return { k: "constant-getter", value: null };
                }
                return this.constantGetter(fallback, site);
            }
            case "setOutput": {
                const [id, name, getter] = args;
                if (id?.k !== "number" || name?.k !== "string" || !getter) break;
                if (getter.k === "closure") {
                    getter.closure.cpp ??= `getter_${id.value}_${snakeCase(name.value)}`;
                }
                this.outputs.set(`${id.value}:${name.value}`, getter);
                return { k: "undefined" };
            }
            default:
                break;
        }
        return this.context.contractError(
            site,
            `The live node-particle lowering does not evaluate 'ctx.${method}' with these arguments.`,
        );
    }

    /**
     * `parseInputLiteral`, the pin's own, evaluated over the parsed input:
     * a number, or a Vector2/Vector3/Color4 array with the pin's own
     * missing-component defaults, as a constant getter.
     */
    private parseInputLiteral(input: LiveGraphInput): StaticValue | undefined {
        const fn = this.owner.pinnedFunction(buildModule, "parseInputLiteral");
        const result = this.callFunction(fn, [{ k: "json", value: input }], fn.declaration);
        if (result.k === "undefined") return undefined;
        return this.constantGetter(result, fn.declaration);
    }

    /** A static value or a zero-parameter closure over one, as a getter. */
    private constantGetter(value: StaticValue, site: ts.Node): StaticValue {
        if (value.k === "closure") {
            const { arrow, env, file, module } = value.closure;
            if (arrow.parameters.length !== 0 || ts.isBlock(arrow.body)) {
                return value;
            }
            return this.constantGetter(this.expression(arrow.body, env, file, module), site);
        }
        if (value.k === "number") return { k: "constant-getter", value: value.value };
        if (value.k === "record") return { k: "constant-getter", value: value.record };
        if (value.k === "null") return { k: "constant-getter", value: null };
        return this.context.contractError(site, `a ${value.k} is not a constant getter`);
    }

    // ── Cross-checks against the executed pin ─────────────────────────────

    private assertFacts(): void {
        const facts = this.facts;
        const mismatch = (what: string, expected: unknown, actual: unknown): never => {
            throw new Error(
                `The live node-particle lowering of set ${facts.set} system ` +
                    `${facts.system} derived ${what} = ${JSON.stringify(actual)}, but ` +
                    `the executed pin reports ${JSON.stringify(expected)}.`,
            );
        };
        const log = this.visitLog();
        if (
            facts.visitOrder.length !== log.length ||
            facts.visitOrder.some((id, index) => id !== log[index])
        ) {
            mismatch("the build order", facts.visitOrder, log);
        }
        if (this.capacity !== facts.capacity) {
            mismatch("the capacity", facts.capacity, this.capacity);
        }
        if (this.steps.length !== facts.updateSteps) {
            mismatch("the update step count", facts.updateSteps, this.steps.length);
        }
        for (const slot of SLOT_NAMES) {
            if (this.slots.has(slot) !== facts.slots[slot]) {
                mismatch(`slot ${slot}`, facts.slots[slot], this.slots.has(slot));
            }
        }
        for (const hook of HOOK_NAMES) {
            const installed = this.hooks.has(hook) || (this.provider && hook === "_prepareFrame");
            if (facts.hooks[hook] !== installed) mismatch(`hook ${hook}`, facts.hooks[hook], installed);
        }
        const scalar = (name: string, expected: number): void => {
            const actual = this.systemInit.get(name) ?? this.systemFields.get(name);
            if (actual !== expected) mismatch(`system.${name}`, expected, actual);
        };
        scalar("emitRate", facts.emitRate);
        scalar("updateSpeed", facts.updateSpeed);
        scalar("blendMode", facts.blendMode);
        scalar("targetStopDuration", facts.targetStopDuration);
    }

    // ── Residual lowering ─────────────────────────────────────────────────

    private memberFor(cpp: string, declaration: string): string {
        if (this.members.has(cpp)) {
            throw new Error(`The live node-particle state already has a member '${cpp}'.`);
        }
        this.members.set(cpp, declaration);
        return cpp;
    }

    private recordMember(record: RecordValue, blockId: number, name: string): string {
        record.member ??= this.memberFor(
            `b${blockId}_${snakeCase(name)}`,
            recordDeclaration(`b${blockId}_${snakeCase(name)}`, record.type, record.initial),
        );
        return record.member;
    }

    /**
     * The struct member a captured `let` lands on. Its storage is the shape
     * the body assigns to it where the body assigns one (`let stored = 0`
     * then `stored = draw(i)` holds whatever the draw returns, and the pin
     * reads it only after that draw), else its initial value's.
     */
    private cellMember(
        cell: Cell,
        blockId: number,
        assigned: PinnedBinding["type"] | undefined,
    ): { member: string; type: PinnedBinding["type"] } {
        if (!cell.member) {
            const cpp = `b${blockId}_${snakeCase(cell.name)}`;
            const value = cell.value;
            if (assigned && isRecordType(assigned)) {
                cell.type = assigned;
                cell.member = this.memberFor(cpp, `${RECORD_SHAPES.get(assigned)!.storage} ${cpp}{};`);
            } else if (value.k === "number") {
                cell.type = "scalar";
                cell.member = this.memberFor(cpp, `double ${cpp} = ${doubleLiteral(value.value)};`);
            } else if (value.k === "boolean") {
                cell.type = "bool";
                cell.member = this.memberFor(cpp, `bool ${cpp} = ${value.value ? "true" : "false"};`);
            } else if (value.k === "record") {
                cell.type = value.record.type;
                cell.member = this.memberFor(
                    cpp,
                    recordDeclaration(cpp, value.record.type, value.record.initial),
                );
            } else {
                throw new Error(
                    `The live node-particle lowering cannot store a ${value.k} in the ` +
                        `captured variable '${cell.name}'.`,
                );
            }
        }
        return { member: cell.member, type: cell.type! };
    }

    private columnBinding(column: ColumnSpec): PinnedBinding {
        return { cpp: `state.${column.cpp}`, type: COLUMN_STORAGE[column.element].binding };
    }

    /** The text-keyed bindings a `system` or `buffer` local exposes. */
    private recordBindings(
        bindings: Map<string, PinnedBinding>,
        calls: Map<string, (args: readonly string[]) => string>,
        local: string,
        kind: "system" | "buffer",
    ): void {
        bindings.set(local, { cpp: "state", type: "opaque" });
        const buffer = kind === "buffer" ? local : `${local}.buffer`;
        if (kind === "system") bindings.set(buffer, { cpp: "state", type: "opaque" });
        for (const column of this.columns) {
            bindings.set(`${buffer}.${column.name}`, this.columnBinding(column));
        }
        bindings.set(`${buffer}.alive`, { cpp: "state.alive", type: "scalar" });
        bindings.set(`${buffer}.capacity`, { cpp: "state.capacity", type: "scalar" });
        bindings.set(`${buffer}._nextId`, { cpp: "state.next_id", type: "scalar" });
        if (kind !== "system") return;
        for (const [field, value] of this.systemFields) {
            bindings.set(`${local}.${field}`, {
                cpp: `state.${snakeCase(field)}`,
                type: typeof value === "boolean" ? "bool" : "scalar",
            });
        }
        bindings.set(`${local}.updateSteps`, { cpp: "update_steps", type: "function-list" });
        for (const slot of SLOT_NAMES) {
            const closure = this.slots.get(slot);
            if (closure) {
                const cpp = closure.cpp!;
                bindings.set(`${local}.${slot}`, { cpp, type: "bool", staticBoolean: true });
                calls.set(`${local}.${slot}`, (args) => `${cpp}(state, ${args.join(", ")})`);
            } else {
                bindings.set(`${local}.${slot}`, absentBinding());
            }
        }
        for (const hook of [...HOOK_NAMES, "texture"]) {
            if (hook === "_prepareFrame" && this.provider) {
                bindings.set(`${local}.${hook}`, { cpp: "prepare_frame", type: "bool", staticBoolean: true });
                calls.set(`${local}.${hook}`, () => "prepare_frame(state)");
                continue;
            }
            const closure = this.hooks.get(hook as HookName);
            if (closure) {
                const cpp = closure.cpp!;
                bindings.set(`${local}.${hook}`, { cpp, type: "bool", staticBoolean: true });
                calls.set(`${local}.${hook}`, (args) => `${cpp}(state, ${args.join(", ")})`);
            } else {
                bindings.set(`${local}.${hook}`, absentBinding());
            }
        }
    }

    /**
     * The translator scope a closure's body runs under: every captured
     * name the body spells bound to what it is natively, plus the calls the
     * body may make.
     */
    private residualScope(
        env: Env,
        blockId: number,
        file: ts.SourceFile,
        module: string,
        body: ts.Node,
    ): PinnedNumericScope {
        const bindings = new Map<string, PinnedBinding>();
        const calls = pinnedCalls();
        const callShapes = new Map<string, PinnedBinding["type"]>();
        // One walk of the body: the names it spells, the calls it makes and
        // the cells it assigns.
        const referenced = new Set<string>();
        const callSites: ts.CallExpression[] = [];
        const assigned = new Map<string, ts.Expression>();
        const visit = (node: ts.Node): void => {
            if (ts.isIdentifier(node)) referenced.add(node.text);
            if (ts.isCallExpression(node)) callSites.push(node);
            if (
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                ts.isIdentifier(node.left)
            ) {
                assigned.set(node.left.text, this.context.unwrapExpression(node.right));
            }
            ts.forEachChild(node, visit);
        };
        visit(body);
        // Cells last: their storage is what the body assigns to them, which
        // for a stored draw is the shape of a getter bound in this pass.
        const cells: Array<[string, Cell]> = [];
        for (const name of referenced) {
            const value = env.lookup(name);
            if (!value) continue;
            if (value.k === "cell") {
                if (value.cell.value.k === "closure") {
                    this.bindValue(name, value.cell.value, blockId, bindings, calls, callShapes);
                } else {
                    cells.push([name, value.cell]);
                }
                continue;
            }
            this.bindValue(name, value, blockId, bindings, calls, callShapes);
        }
        // Pinned functions the body reaches: a numeric one lowers once for
        // every system; one over getters and scratch instantiates per call.
        for (const call of callSites) {
            const callee = this.context.unwrapExpression(call.expression);
            if (!ts.isIdentifier(callee)) continue;
            const value = env.lookup(callee.text) ?? this.findFree(callee.text, file, module);
            if (value?.k === "function") {
                this.bindFunctionCall(callee.text, value.fn, call, env, blockId, calls, callShapes, file);
            }
        }
        for (const [name, cell] of cells) {
            const value = assigned.get(name);
            const shape = value
                ? ts.isCallExpression(value)
                    ? callShapeOf(callShapes, value, file)
                    : ts.isIdentifier(value)
                      ? bindings.get(value.text)?.type
                      : undefined
                : undefined;
            const { member, type } = this.cellMember(
                cell,
                blockId,
                shape === "opaque" ? undefined : shape,
            );
            bindings.set(name, { cpp: `state.${member}`, type });
        }
        return {
            bindings,
            calls,
            callShapes,
            booleanAnd: true,
            booleanOr: true,
            recordLiteral: recordLiteralCpp,
            indexedCall,
        };
    }

    private bindValue(
        name: string,
        value: StaticValue,
        blockId: number,
        bindings: Map<string, PinnedBinding>,
        calls: Map<string, (args: readonly string[]) => string>,
        callShapes: Map<string, PinnedBinding["type"]>,
    ): void {
        switch (value.k) {
            case "number":
                bindings.set(name, {
                    cpp: doubleLiteral(value.value),
                    type: "scalar",
                    staticNumber: value.value,
                });
                return;
            case "boolean":
                bindings.set(name, {
                    cpp: value.value ? "true" : "false",
                    type: "bool",
                    staticBoolean: value.value,
                });
                return;
            case "column":
                bindings.set(name, this.columnBinding(value.column));
                return;
            case "record": {
                const member = this.recordMember(value.record, blockId, name);
                bindings.set(name, { cpp: `state.${member}`, type: value.record.type });
                return;
            }
            case "closure": {
                const closure = value.closure;
                closure.cpp ??= `${snakeCase(name)}_b${blockId}`;
                const shape = this.lowerClosure(closure);
                const cpp = closure.cpp;
                calls.set(name, (args) => `${cpp}(state, ${args[0] ?? "0.0"})`);
                if (shape !== "void") callShapes.set(name, shape);
                bindings.set(name, { cpp, type: "opaque" });
                return;
            }
            case "constant-getter": {
                const constant = value.value;
                if (constant === null) {
                    bindings.set(name, absentBinding());
                    calls.set(name, () => {
                        throw new Error(
                            `The live node-particle lowering reached the unconnected ` +
                                `input '${name}' of block ${blockId} at run time.`,
                        );
                    });
                    return;
                }
                if (typeof constant === "number") {
                    calls.set(name, () => doubleLiteral(constant));
                } else {
                    const literal = recordLiteralCpp(
                        constant.type,
                        constant.initial.map((component) => doubleLiteral(component)),
                    );
                    calls.set(name, () => literal);
                    callShapes.set(name, constant.type);
                }
                bindings.set(name, { cpp: `/* ${name} */`, type: "opaque" });
                return;
            }
            case "matrix":
                bindings.set(name, { cpp: this.provider ? "state.emitter_world_matrix" : "emitter_world_matrix", type: "f32" });
                return;
            case "emitter":
                bindings.set(name, { cpp: "state.emitter", type: "vec3" });
                return;
            case "system":
                this.recordBindings(bindings, calls, name, "system");
                return;
            case "buffer":
                this.recordBindings(bindings, calls, name, "buffer");
                return;
            default:
                // Build-time-only values (the block, the context, JSON) are
                // not bound; a body that reads one fails by name.
                return;
        }
    }

    /**
     * A pinned function a closure calls. Over numbers, matrices and
     * out-records it is one shared C++ function; over getters, or returning
     * a record, it is an instance specialized to the call site, spelled by
     * the call's text over the pin's numeric arguments.
     */
    private bindFunctionCall(
        name: string,
        fn: PinnedFunction,
        call: ts.CallExpression,
        env: Env,
        blockId: number,
        calls: Map<string, (args: readonly string[]) => string>,
        callShapes: Map<string, PinnedBinding["type"]>,
        file: ts.SourceFile,
    ): void {
        const text = call.getText(file);
        if (calls.has(text)) return;
        const annotations = fn.declaration.parameters.map((parameter) =>
            parameter.type?.getText(fn.file) ?? "",
        );
        const returns = fn.declaration.type?.getText(fn.file);
        // What `sharedFunction` cannot take: a getter parameter, or a
        // record result.
        const perCallSite =
            annotations.includes("NpeGetter") ||
            annotations.includes("ParticleSystem") || annotations.includes("ParticleBuffer") ||
            (returns !== "void" && returns !== "number");
        if (!perCallSite) {
            const shared = this.owner.sharedFunction(fn, annotations);
            calls.set(name, (args) => `${shared}(${args.join(", ")})`);
            return;
        }
        const instance = `${snakeCase(name)}_b${blockId}_${this.instanceCounter++}`;
        const scope = new Env(this.moduleEnv(fn.module));
        const numeric: string[] = [];
        const positions: number[] = [];
        fn.declaration.parameters.forEach((parameter, index) => {
            if (!ts.isIdentifier(parameter.name)) {
                this.context.contractError(parameter, "parameter name");
            }
            const argument = call.arguments[index];
            if (!argument) {
                this.context.contractError(call, `argument ${index} of '${name}'`);
            }
            if (annotations[index] === "number") {
                numeric.push(parameter.name.text);
                positions.push(index);
                return;
            }
            const unwrapped = this.context.unwrapExpression(argument);
            const value = ts.isIdentifier(unwrapped) ? env.lookup(unwrapped.text) : undefined;
            if (!value) {
                this.context.contractError(
                    argument,
                    `argument ${index} of '${name}' must name a captured getter or record`,
                );
            }
            scope.declare(parameter.name.text, value);
        });
        const shape = this.lowerBody(
            fn.declaration.body!,
            scope,
            blockId,
            fn.file,
            fn.module,
            instance,
            numeric,
            returns === "void" ? "void" : undefined,
            `${fn.module}#${fn.declaration.name!.text}`,
        );
        calls.set(text, (args) =>
            `${instance}(state${positions.map((index) => `, ${args[index]}`).join("")})`,
        );
        if (shape !== "void") callShapes.set(text, shape);
    }

    /** Lower a closure once; returns the shape its body returns. */
    private lowerClosure(
        closure: Closure,
        expected?: "void",
    ): PinnedBinding["type"] | "void" {
        if (closure.shape) return closure.shape;
        if (!closure.cpp) {
            this.context.contractError(closure.arrow, "a closure reached before it was installed");
        }
        const params = closure.arrow.parameters.map((parameter) =>
            parameter.name.getText(closure.file),
        );
        closure.shape = this.lowerBody(
            closure.arrow.body,
            new Env(closure.env),
            closure.blockId,
            closure.file,
            closure.module,
            closure.cpp,
            params,
            expected,
            `${closure.module} block ${closure.blockId}`,
        );
        return closure.shape;
    }

    /**
     * The residual lowering of one body: the translator runs over it with
     * the captured environment bound, every `return` reports the shape of
     * what it returns, and the function is emitted with that shape once
     * the body agrees on one.
     */
    private lowerBody(
        body: ts.ConciseBody,
        env: Env,
        blockId: number,
        file: ts.SourceFile,
        module: string,
        cpp: string,
        numericParams: readonly string[],
        expected: "void" | undefined,
        provenance: string,
    ): PinnedBinding["type"] | "void" {
        const scope = this.residualScope(env, blockId, file, module, body);
        // The pin's `(i)` is a particle index; every closure takes it, and a
        // constant one that ignores it still has the parameter.
        const paramNames = numericParams.length > 0 ? numericParams : ["i"];
        for (const name of paramNames) {
            scope.bindings.set(name, { cpp: name, type: "scalar" });
        }
        const shapes = new Set<PinnedBinding["type"]>();
        let bareReturn = false;
        const shapeOf = (expression: ts.Expression): PinnedBinding["type"] => {
            const node = this.context.unwrapExpression(expression);
            const named = scope.bindings.get(node.getText(file));
            if (named && named.type !== "opaque") return named.type;
            return (
                (ts.isCallExpression(node)
                    ? callShapeOf(scope.callShapes, node, file)
                    : undefined) ?? "scalar"
            );
        };
        const lowerer = new PinnedNumericLowerer(file, scope);
        scope.returnValue = (expression) => {
            if (!expression) {
                bareReturn = true;
                return "";
            }
            shapes.add(shapeOf(expression));
            return lowerer.expression(expression);
        };
        const lines = ts.isBlock(body)
            ? lowerer.statements(body.statements, "    ")
            : [`    return ${scope.returnValue(body)};`];
        if (bareReturn && shapes.size > 0) {
            throw new Error(
                `The live node-particle lowering of ${provenance} returns a value on ` +
                    "one path and nothing on another.",
            );
        }
        if (shapes.size > 1) {
            throw new Error(
                `The live node-particle lowering of ${provenance} returns ` +
                    `${[...shapes].join(" and ")} on different paths.`,
            );
        }
        const shape: PinnedBinding["type"] | "void" =
            expected === "void" || shapes.size === 0 ? "void" : [...shapes][0]!;
        const returnType =
            shape === "void"
                ? "void"
                : isRecordType(shape)
                  ? RECORD_SHAPES.get(shape)!.storage
                  : "double";
        // A constant getter reads neither the state nor the index; the
        // signature is every closure's, so both are marked.
        const signature = `${returnType} ${cpp}([[maybe_unused]] State& state${paramNames
            .map((name) => `, [[maybe_unused]] double ${name}`)
            .join("")})`;
        this.prototypes.push(`${signature};`);
        this.functions.push(`// ${provenance}\n${signature} {\n${lines.join("\n")}\n}`);
        return shape;
    }

    // ── The simulation loop ───────────────────────────────────────────────

    /**
     * `animateParticleSystem` and the four functions it reaches, translated
     * from `particle-system.ts` and `particle-buffer.ts` with the system and
     * buffer parameters bound to the state: absent hooks fold away, the
     * installed slots are the graph's, and the step list is the one the
     * evaluation collected.
     */
    private lowerSimulation(): string {
        const lowered: string[] = [];
        const lowerPinned = (
            module: string,
            name: string,
            cpp: string,
            extra: ReadonlyArray<readonly [pinned: string, cpp: string]>,
            returns: "void" | "double",
        ): void => {
            const { file, declaration } = this.context.functionDeclaration(module, name);
            const first = declaration.parameters[0];
            const annotation = first?.type?.getText(file);
            if (
                !first ||
                !ts.isIdentifier(first.name) ||
                (annotation !== "ParticleSystem" && annotation !== "ParticleBuffer")
            ) {
                this.context.contractError(
                    declaration,
                    `Expected ${name}'s first parameter to be a ParticleSystem or ParticleBuffer.`,
                );
            }
            const memberBindings = new Map<string, PinnedBinding>();
            const calls = pinnedCalls();
            this.recordBindings(
                memberBindings,
                calls,
                first.name.text,
                annotation === "ParticleSystem" ? "system" : "buffer",
            );
            for (const callee of [
                "updateExisting",
                "createNew",
                "stopParticleSystem",
                "killParticle",
                "spawnParticle",
            ]) {
                calls.set(callee, (args) => `${snakeCase(callee)}(${args.join(", ")})`);
            }
            const parameters: PinnedFunctionParameter[] = [
                {
                    pinned: first.name.text,
                    kind: "record",
                    cpp: "state",
                    annotation,
                    specialized: true,
                    binding: memberBindings.get(first.name.text)!,
                },
                ...extra.map(([pinned, spelled]): PinnedFunctionParameter => ({
                    pinned,
                    kind: "number",
                    cpp: spelled,
                })),
            ];
            memberBindings.delete(first.name.text);
            const parts = lowerPinnedFunctionParts(this.context, module, name, parameters, {
                cppName: cpp,
                returns,
                calls,
                booleanAnd: true,
                booleanOr: true,
                memberBindings,
                leadingParameters: ["State& state"],
                indexedCall,
            });
            this.prototypes.push(`${parts.declaration};`);
            lowered.push(`// ${parts.provenance}\n${parts.declaration} {\n${parts.body}\n}`);
        };
        lowerPinned(bufferModule, "spawnParticle", "spawn_particle", [], "double");
        lowered.push(this.killParticleCpp());
        this.prototypes.push("void kill_particle(State& state, double i);");
        lowerPinned(systemModule, "startParticleSystem", "start_particle_system", [], "void");
        lowerPinned(systemModule, "stopParticleSystem", "stop_particle_system", [], "void");
        lowerPinned(
            systemModule,
            "updateExisting",
            "update_existing",
            [["scaledUpdateSpeed", "scaled_update_speed"]],
            "void",
        );
        lowerPinned(systemModule, "createNew", "create_new", [["count", "count"]], "void");
        lowerPinned(
            systemModule,
            "animateParticleSystem",
            "animate_particle_system",
            [["scaledRatio", "scaled_ratio"]],
            "void",
        );
        return lowered.join("\n\n");
    }

    /**
     * `killParticle`: swap-remove across every column. The pin loops over
     * `buffer._all`, a list of typed arrays of three element widths, which
     * has no single native storage; the loop is unrolled over the columns
     * `createParticleBuffer` lists in `_all`, and the function's own
     * statements are asserted so a changed release rule fails here.
     */
    private killParticleCpp(): string {
        const { file, declaration } = this.context.functionDeclaration(
            bufferModule,
            "killParticle",
        );
        this.context.assertStatementInventory(
            declaration,
            declaration.body!.statements,
            "killParticle",
            "the live swap-remove restates a body",
            ["variable statement", "if statement"],
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, "last"),
            "--buffer.alive",
            "killParticle release",
        );
        const guard = declaration.body!.statements.find(ts.isIfStatement)!;
        this.context.assertExpressionShape(guard.expression, "i !== last", "killParticle guard");
        const copies = this.context.findNodes(guard, ts.isBinaryExpression).filter(
            (candidate) =>
                candidate.operatorToken.kind === ts.SyntaxKind.EqualsToken,
        );
        if (
            copies.length !== 1 ||
            copies[0]!.getText(file).replace(/\s+/g, " ") !== "col[i] = col[last]!"
        ) {
            this.context.contractError(guard, "killParticle no longer copies each column's last slot.");
        }
        const lines = this.columns.map(
            (column) =>
                `        state.${column.cpp}[static_cast<std::size_t>(i)] = ` +
                `state.${column.cpp}[static_cast<std::size_t>(last)];`,
        );
        return (
            `// ${this.context.provenance(bufferModule, "killParticle")}\n` +
            "void kill_particle(State& state, double i) {\n" +
            "    const double last = static_cast<double>(--state.alive);\n" +
            "    if (i != last) {\n" +
            `${lines.join("\n")}\n` +
            "    }\n" +
            "}"
        );
    }

    // ── Emission ──────────────────────────────────────────────────────────

    private emit(simulation: string): string {
        const facts = this.facts;
        const scalarMembers: string[] = [];
        for (const [field, value] of this.systemFields) {
            const initial = this.systemInit.get(field) ?? value;
            scalarMembers.push(
                typeof initial === "boolean"
                    ? `    bool ${snakeCase(field)} = ${initial ? "true" : "false"};`
                    : `    double ${snakeCase(field)} = ${doubleLiteral(initial)};`,
            );
        }
        const steps = this.steps.map((closure) => `&${closure.cpp!}`);
        // A scratch record or cell declared in an evaluator's build reaches
        // the state only when a residual body reads or writes it: the
        // arms a shape test pruned still named theirs, and the translator
        // never emitted them.
        const emitted = `${this.functions.join("\n")}\n${simulation}`;
        const members = [...this.members].filter(([cpp]) => emitted.includes(`state.${cpp}`));
        const emitterUsed = emitted.includes("state.emitter");
        return `namespace ${this.namespace} {

/**
 * createParticleBuffer + createParticleSystem for one live system: the
 * pin's columns at the pin's widths, its scalar settings as the graph's
 * SystemBlock left them, and the scratch and lock state its block closures
 * captured.
 */
struct State {
${this.columns
    .map((column) => `    ${COLUMN_STORAGE[column.element].vector} ${column.cpp};`)
    .join("\n")}
    double capacity;
    double alive = 0.0;
    double next_id = 0.0;
${scalarMembers.join("\n")}${
            emitterUsed
                ? `\n    Vec3d emitter{${facts.emitter
                      .map((component) => doubleLiteral(component))
                      .join(", ")}};`
                : ""
        }
${this.provider ? `    std::array<float, 16> emitter_world_matrix{};
    std::array<float, 16> next_emitter_matrix{};
    bbl::js::Callback<std::array<float, 16>()> emitter_provider;` : ""}
${members.map(([, declaration]) => `    ${declaration}`).join("\n")}

    explicit State(std::size_t capacity_)
        : ${this.columns
            .map((column) => `${column.cpp}(capacity_, ${COLUMN_STORAGE[column.element].zero})`)
            .join(",\n          ")},
          capacity(static_cast<double>(capacity_)) {}
};

${this.provider ? "" : `// The emitter world matrix the build composed (mat4Translation of the
// emitter option), as the executed pin reported it.
const std::array<float, 16> emitter_world_matrix = {
    ${facts.emitterWorldMatrix.map((value) => floatLiteral(value)).join(", ")}};`}

${this.prototypes.join("\n")}

// The update steps in graph order, which is the order the evaluators
// pushed them.
const std::array<void (*)(State&, double), ${steps.length}> update_steps = {${
            steps.length === 0 ? "" : `\n    ${steps.join(",\n    ")}`
        }};

${this.functions.join("\n\n")}

${simulation}

State state(${this.capacity}u);

} // namespace ${this.namespace}`;
    }
}

/**
 * The live lowering's entry point: one system at a time, plus the pinned
 * shapes and shared functions every lowered system reads.
 */
export class NodeParticleLiveLowerer {
    private readonly shared = new Map<string, string>();
    private readonly functions = new Map<string, PinnedFunction>();
    private readonly registries = new Map<string, Map<string, { module: string; exportName: string }>>();
    private columns?: ColumnSpec[];
    private systemFields?: Map<string, number | boolean>;
    private walkAsserted = false;

    public constructor(private readonly context: LoweringContext) {}

    public lowerSystem(graph: LiveGraph, facts: LiveSystemFacts, provider = false): LoweredLiveSystem {
        if (!this.walkAsserted) {
            this.assertBuildWalk();
            this.walkAsserted = true;
        }
        const namespace = `npe_${facts.set}_${facts.system}`;
        if (provider && !this.shared.has("emitter_provider")) {
            this.shared.set("emitter_provider", lowerNodeParticleProviderShared(this.context));
        }
        const lowering = new SystemLowering(
            this.context,
            this,
            graph,
            facts,
            [...this.bufferColumns()],
            this.systemDefaults(),
            namespace,
            provider,
        );
        return { namespace, source: lowering.lower() };
    }

    /**
     * The shared pinned functions the lowered systems reached, plus the two
     * positional records the runtime does not declare, emitted once ahead
     * of every system.
     */
    public sharedSource(): string {
        return [...this.shared.values()].join("\n\n");
    }

    /** A pinned function declaration, resolved once per module and name. */
    public pinnedFunction(module: string, name: string): PinnedFunction {
        const key = `${module}#${name}`;
        let fn = this.functions.get(key);
        if (!fn) {
            const { declaration, file } = this.context.functionDeclaration(module, name);
            fn = { declaration, file, module };
            this.functions.set(key, fn);
        }
        return fn;
    }

    /**
     * Which evaluator the pin selects for a block, read off the registry's
     * own `switch` once: a case label names the class, and its arm names
     * the module and the export. A variant, a local shape or a class the
     * base registry routes elsewhere refuses -- those evaluators are not
     * lowered -- and the predicates that select them are asserted against
     * the pin's text by `assertBuildWalk`.
     */
    public evaluatorFor(
        block: LiveGraphBlock,
        isLocal: boolean,
    ): { module: string; exportName: string } {
        const contextual =
            typeof block.serialized.contextualValue === "number"
                ? block.serialized.contextualValue
                : 0;
        if (isLocal && block.className.endsWith("ShapeBlock")) {
            const local = this.registryEntries(
                "src/particle/node/npe-registry-local-shapes.ts", "loadLocalShapeEvaluator",
            ).get(block.className);
            if (!local) throw new Error(`No pinned local shape evaluator for '${block.className}'.`);
            return local;
        }
        if (block.className === "ParticleInputBlock") {
            const module = "src/particle/node/npe-registry-variants.ts";
            const { declaration } = this.context.functionDeclaration(module, "loadVariantBlockEvaluator");
            const clause = this.context.findNodes(declaration, ts.isCaseClause).find((candidate) =>
                ts.isStringLiteral(candidate.expression) && candidate.expression.text === block.className);
            const guard = clause ? this.context.findNodes(clause, ts.isIfStatement)[0] : undefined;
            if (!guard || !ts.isBinaryExpression(guard.expression) ||
                guard.expression.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) {
                this.context.contractError(clause ?? declaration, "Expected the local particle-input variant guard.");
            }
            this.context.assertExpressionShape(guard.expression.left,
                "block.serialized.contextualValue", "local particle-input variant source");
            if (contextual === this.context.numericValue(guard.expression.right, declaration.getSourceFile())) {
                const returned = this.context.findNodes(guard.thenStatement, ts.isReturnStatement)[0];
                if (!returned) this.context.contractError(guard, "Local input variant returns no evaluator.");
                return this.evaluatorReturn(module, returned);
            }
        }
        const input = (name: string): LiveGraphInput | undefined =>
            block.inputs.find((candidate) => candidate.name === name);
        const left = input("left");
        const right = input("right");
        const emitRate = input("emitRate");
        const variant =
            (block.className === "ParticleInputBlock" &&
                contextual !== 0 &&
                !((contextual <= 6 && contextual !== 2) || contextual === 0x17)) ||
            (block.className === "ParticleRandomBlock" && block.serialized.lockMode === 3) ||
            (block.className === "ParticleMathBlock" &&
                left?.targetBlockId === right?.targetBlockId &&
                left?.targetConnectionName === right?.targetConnectionName) ||
            (block.className === "SystemBlock" &&
                emitRate !== undefined &&
                emitRate.targetBlockId !== null &&
                emitRate.targetConnectionName !== null) ||
            (block.className === "SetupSpriteSheetBlock" &&
                block.serialized.randomStartCell === true) ||
            (isLocal && block.className.endsWith("ShapeBlock"));
        if (variant) {
            throw new Error(
                `The live node-particle lowering does not cover the variant ` +
                    `evaluator '${block.className}' (block ${block.id}) selects.`,
            );
        }
        const evaluator = this.registryEntries(registryModule, "loadNpeBlockEvaluator").get(block.className);
        if (!evaluator) {
            throw new Error(
                `The live node-particle lowering does not cover the block class ` +
                    `'${block.className}' (block ${block.id}).`,
            );
        }
        return evaluator;
    }

    private registryEntries(module: string, symbol: string): Map<string, { module: string; exportName: string }> {
        const key = `${module}#${symbol}`;
        const cached = this.registries.get(key);
        if (cached) return cached;
        const { declaration } = this.context.functionDeclaration(
            module, symbol,
        );
        const switchStatement = this.context.findNodes(declaration, ts.isSwitchStatement)[0];
        if (!switchStatement) {
            this.context.contractError(declaration, "The registry is no longer a switch.");
        }
        const entries = new Map<string, { module: string; exportName: string }>();
        for (const clause of switchStatement.caseBlock.clauses) {
            if (!ts.isCaseClause(clause) || !ts.isStringLiteral(clause.expression)) continue;
            const returned = clause.statements.find(ts.isReturnStatement);
            if (!returned) this.context.contractError(clause, "Registry arm must return an evaluator.");
            entries.set(clause.expression.text, this.evaluatorReturn(module, returned));
        }
        this.registries.set(key, entries);
        return entries;
    }

    private evaluatorReturn(registry: string, returned: ts.ReturnStatement): { module: string; exportName: string } {
        return this.context.dynamicImportExport(registry, returned);
    }

    /**
     * The pin's `buildNodeParticleSet` as this module restates it: the walk
     * (particle inputs first, then the rest), the three predicates that
     * select a variant evaluator, and the build context's `input`,
     * `isConnected` and `setOutput`.
     */
    private assertBuildWalk(): void {
        const { declaration } = this.context.functionDeclaration(
            buildModule,
            "buildNodeParticleSet",
        );
        const shape = (name: string, expected: string): void => {
            this.context.assertExpressionShape(
                this.context.variableInitializer(declaration, name),
                expected,
                `buildNodeParticleSet ${name}`,
            );
        };
        shape(
            "scalarOnce",
            'block.className === "ParticleRandomBlock" && ' +
                'block.serialized.lockMode === 3 && onceValueType === "number"',
        );
        shape("localShape", 'state.isLocal && block.className.endsWith("ShapeBlock")');
        shape(
            "variant",
            '(block.className === "ParticleInputBlock" && contextualSource !== 0 && ' +
                "!((contextualSource <= 6 && contextualSource !== 2) || contextualSource === 0x17)) || " +
                '(block.className === "ParticleRandomBlock" && block.serialized.lockMode === 3 && !scalarOnce) || ' +
                '(block.className === "ParticleMathBlock" && left?.targetBlockId === right?.targetBlockId && ' +
                "left?.targetConnectionName === right?.targetConnectionName) || " +
                '(block.className === "SystemBlock" && isInputConnected(block.inputs.find((input) => input.name === "emitRate"))) || ' +
                '(block.className === "SetupSpriteSheetBlock" && block.serialized.randomStartCell === true)',
        );
        const guards = this.context
            .findNodes(declaration, ts.isForOfStatement)
            .map((loop) => {
                const body = ts.isBlock(loop.statement)
                    ? loop.statement.statements.length === 1
                        ? loop.statement.statements[0]
                        : undefined
                    : loop.statement;
                return body && ts.isIfStatement(body)
                    ? body.expression.getText(declaration.getSourceFile()).replace(/\s+/g, " ")
                    : undefined;
            });
        const expected = [
            'input.name === "particle" && isInputConnected(input)',
            'input.name !== "particle" && isInputConnected(input)',
        ];
        if (!expected.every((text) => guards.includes(text))) {
            this.context.contractError(
                declaration,
                "buildNodeParticleSet no longer recurses the particle " +
                    "inputs first and the other connected inputs second.",
            );
        }
        const file = declaration.getSourceFile();
        const ctx = this.context.variableInitializer(declaration, "ctx");
        if (!ts.isObjectLiteralExpression(ctx)) {
            this.context.contractError(ctx, "buildNodeParticleSet ctx");
        }
        const method = (name: string): ts.MethodDeclaration => {
            const found = ctx.properties.find(
                (property): property is ts.MethodDeclaration =>
                    ts.isMethodDeclaration(property) &&
                    ts.isIdentifier(property.name) &&
                    property.name.text === name,
            );
            if (!found?.body) this.context.contractError(ctx, `ctx.${name}`);
            return found;
        };
        const input = method("input");
        this.context.assertStatementInventory(
            input,
            input.body!.statements,
            "ctx.input",
            "the live lowering restates a body",
            ["variable statement", "if statement", "if statement", "return statement"],
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(input, "input"),
            "block.inputs.find((i) => i.name === name)",
            "ctx.input lookup",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(input, "getter"),
            "outputs.get(`${input.targetBlockId}:${input.targetConnectionName}`)",
            "ctx.input connection key",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(input, "literal"),
            "parseInputLiteral(input)",
            "ctx.input literal",
        );
        const returned = input.body!.statements[input.body!.statements.length - 1];
        if (
            !returned ||
            !ts.isReturnStatement(returned) ||
            !returned.expression ||
            returned.expression.getText(file).replace(/\s+/g, " ") !==
                "fallback ?? (() => null as unknown as NpeValue)"
        ) {
            this.context.contractError(input, "ctx.input fallback");
        }
        this.context.expectShapeCount(
            method("setOutput"),
            "outputs.set(`${blockId}:${name}`, getter)",
            "ctx.setOutput key",
        );
    }

    /**
     * One pinned function over numbers, matrices and out-records, lowered
     * whole through `lowerPinnedFunction` the first time any system reaches
     * it. Returns the C++ name.
     */
    public sharedFunction(fn: PinnedFunction, annotations: readonly string[]): string {
        const name = fn.declaration.name!.text;
        const cpp = `npe_${snakeCase(name)}`;
        if (this.shared.has(cpp)) return cpp;
        const parameters: PinnedFunctionParameter[] = fn.declaration.parameters.map(
            (parameter, index) => {
                const pinned = parameter.name.getText(fn.file);
                const annotation = annotations[index]!;
                if (annotation === "number") {
                    return { pinned, kind: "number", cpp: snakeCase(pinned) };
                }
                if (annotation === "Mat4") {
                    return { pinned, kind: "mat4Const", cpp: snakeCase(pinned) };
                }
                const record = recordTypeOfAnnotation(annotation);
                if (record) {
                    return {
                        pinned,
                        kind: "record",
                        cpp: snakeCase(pinned),
                        annotation,
                        cppType: RECORD_SHAPES.get(record)!.storage,
                        mutableRecord: true,
                        binding: { cpp: snakeCase(pinned), type: record },
                    };
                }
                return this.context.contractError(
                    parameter,
                    `The live node-particle lowering has no binding for a '${annotation}' parameter.`,
                );
            },
        );
        this.shared.set(
            cpp,
            lowerPinnedFunction(this.context, fn.module, name, parameters, {
                cppName: cpp,
                returns: fn.declaration.type?.getText(fn.file) === "void" ? "void" : "double",
                calls: pinnedCalls(),
                booleanAnd: true,
                booleanOr: true,
            }),
        );
        return cpp;
    }

    /**
     * The buffer's columns, read off `createParticleBuffer`: one typed
     * array per `const <name> = new <Ctor>(capacity)`, in the order the
     * returned `_all` list names them, which is the order swap-remove copies.
     */
    private bufferColumns(): ColumnSpec[] {
        if (this.columns) return this.columns;
        const { file, declaration } = this.context.functionDeclaration(
            bufferModule,
            "createParticleBuffer",
        );
        const declared = new Map<string, ColumnSpec["element"]>();
        for (const statement of declaration.body!.statements) {
            if (!ts.isVariableStatement(statement)) continue;
            for (const column of statement.declarationList.declarations) {
                const initializer = column.initializer
                    ? this.context.unwrapExpression(column.initializer)
                    : undefined;
                if (
                    !ts.isIdentifier(column.name) ||
                    !initializer ||
                    !ts.isNewExpression(initializer) ||
                    !ts.isIdentifier(initializer.expression) ||
                    initializer.arguments?.length !== 1 ||
                    initializer.arguments[0]!.getText(file) !== "capacity"
                ) {
                    this.context.contractError(column, "createParticleBuffer column");
                }
                const element = COLUMN_CONSTRUCTORS.get(initializer.expression.text);
                if (!element) {
                    this.context.contractError(
                        initializer,
                        `createParticleBuffer column '${column.name.text}' has a width this port does not store.`,
                    );
                }
                declared.set(column.name.text, element);
            }
        }
        const returned = this.context.returnObject(declaration);
        const all = this.context.propertyInitializer(returned, "_all");
        if (!ts.isArrayLiteralExpression(all)) {
            this.context.contractError(all, "createParticleBuffer _all");
        }
        this.columns = all.elements.map((element) => {
            const name = element.getText(file);
            const width = declared.get(name);
            if (!width) {
                this.context.contractError(element, `_all names an undeclared column '${name}'.`);
            }
            return { name, element: width, cpp: snakeCase(name) };
        });
        if (this.columns.length !== declared.size) {
            this.context.contractError(all, "createParticleBuffer _all omits a declared column.");
        }
        return this.columns;
    }

    /**
     * `createParticleSystem`'s scalar and boolean defaults, off its own
     * returned literal. The buffer, the step list and the eight slots are
     * the structure the lowering itself emits -- the slots are asserted to
     * be exactly `SLOT_NAMES`, and the `ParticleSystem` interface's
     * optional members exactly `HOOK_NAMES` -- everything else is a field.
     */
    private systemDefaults(): Map<string, number | boolean> {
        if (this.systemFields) return this.systemFields;
        const { file, declaration } = this.context.functionDeclaration(
            systemModule,
            "createParticleSystem",
        );
        const returned = this.context.returnObject(declaration);
        const fields = new Map<string, number | boolean>();
        const slots: string[] = [];
        for (const property of returned.properties) {
            if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
                this.context.contractError(property, "createParticleSystem field");
            }
            const name = property.name.text;
            const initializer = this.context.unwrapExpression(property.initializer);
            if (name === "buffer") continue;
            if (name === "updateSteps") {
                if (!ts.isArrayLiteralExpression(initializer) || initializer.elements.length !== 0) {
                    this.context.contractError(initializer, "createParticleSystem updateSteps");
                }
                continue;
            }
            if (initializer.kind === ts.SyntaxKind.NullKeyword) {
                if (name !== "texture") slots.push(name);
                continue;
            }
            if (initializer.kind === ts.SyntaxKind.TrueKeyword) fields.set(name, true);
            else if (initializer.kind === ts.SyntaxKind.FalseKeyword) fields.set(name, false);
            else fields.set(name, this.context.numericValue(initializer, file));
        }
        if (slots.join(",") !== SLOT_NAMES.join(",")) {
            this.context.contractError(
                returned,
                `createParticleSystem's null slots are [${slots.join(", ")}]; the live ` +
                    `lowering fills [${SLOT_NAMES.join(", ")}].`,
            );
        }
        const optional = this.context
            .interfaceDeclaration(systemModule, "ParticleSystem")
            .declaration.members.filter(
                (member): member is ts.PropertySignature =>
                    ts.isPropertySignature(member) && member.questionToken !== undefined,
            )
            .map((member) => member.name.getText(file));
        if (optional.join(",") !== HOOK_NAMES.join(",")) {
            this.context.contractError(
                declaration,
                `ParticleSystem's optional members are [${optional.join(", ")}]; the ` +
                    `live lowering refuses [${HOOK_NAMES.join(", ")}].`,
            );
        }
        this.systemFields = fields;
        return fields;
    }
}
