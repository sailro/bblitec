/**
 * A glTF `KHR_interactivity` flow graph, lowered from the pin's own block
 * definitions.
 *
 * Upstream the graph is data the runtime interprets: `runtime.ts` pulls a
 * data input by running the producer block's `updateOutputs` on every read
 * and pushes a signal by calling each target's `execute`, and every block is
 * a `FgBlockDef` record of pure functions over `(block, ctx, env)`. The
 * graph itself is fixed by the asset, so this module PARTIALLY EVALUATES
 * each reached block's pinned body over the parsed graph
 * (`src/pinned-flow-graph.ts` ran the pin's parser) and emits one C++
 * function per block:
 *
 *   - Everything a body decides from the graph -- the socket a pull names,
 *     the producer it is wired to, a configuration value, the variables a
 *     `variable/set` writes, the accessor a pointer resolved to, the shape
 *     tests `fg-math` makes on its operands -- is decided here, by
 *     evaluating the pinned statements over plain data.
 *   - Everything that depends on run-time state -- a variable's value, a
 *     transport slot another block wrote, an accessor read, a pointer
 *     event's node -- is a residual C++ expression carrying the shape the
 *     graph gave it, and the arithmetic the pinned bodies perform on it is
 *     emitted from those same bodies.
 *
 * The runtime plumbing (`getDataValue`, `setDataValue`, `activateSignal`,
 * the scene coordinator and the pointer bridge) is dictionary traffic over
 * string keys with no arithmetic in it; it is restated here over the static
 * graph and its pinned bodies are asserted shape by shape, so a changed
 * pull, push or dispatch rule fails generation by name. A block type, a
 * pointer form or a construct this module does not evaluate refuses by
 * name rather than approximating.
 */
import ts from "typescript";
import { doubleLiteral, sanitizeCppIdentifier, snakeCase } from "../cpp-literals.js";
import type {
    FlowGraphAssetPrograms,
    FlowGraphBlock,
    FlowGraphProgram,
    FlowGraphSocket,
} from "../pinned-flow-graph.js";
import { type LoweredSource, LoweringContext, statementKind } from "./context.js";
import { PINNED_ARITHMETIC_OPERATORS, pinnedNumericMathCalls } from "./pinned-operators.js";

/** A graph-authored name as one C++ identifier fragment. */
function identifier(name: string): string {
    return snakeCase(sanitizeCppIdentifier(name));
}

/** The comparisons `fg-math` and `rich-type` state over numbers. */
const COMPARISON_OPERATORS: ReadonlyMap<ts.SyntaxKind, string> = new Map([
    [ts.SyntaxKind.LessThanToken, "<"],
    [ts.SyntaxKind.LessThanEqualsToken, "<="],
    [ts.SyntaxKind.GreaterThanToken, ">"],
    [ts.SyntaxKind.GreaterThanEqualsToken, ">="],
]);

/** `Math.*` over a run-time number, spelled by the shared table. */
const PINNED_MATH_CALLS = pinnedNumericMathCalls();

const RUNTIME_MODULE = "src/flow-graph/runtime.ts";
const REGISTRY_MODULE = "src/flow-graph/block-registry.ts";
const BLOCK_TYPE_MODULE = "src/flow-graph/block-type.ts";
const POINTER_TEMPLATE_MODULE = "src/flow-graph/pointer-template.ts";
const PATH_CONVERTER_MODULE = "src/flow-graph/gltf/path-converter.ts";
const SCENE_MODULE = "src/flow-graph/scene-flow-graph.ts";
const POINTER_MODULE = "src/flow-graph/scene-flow-graph-pointer.ts";
const LOADER_MODULE = "src/loader-gltf/gltf-feature-interactivity.ts";
const VISIBILITY_MODULE = "src/scene/visibility.ts";

/**
 * The pin's event channel names (`FgEventType`) the lowering dispatches.
 * `Tick`, `CustomEvent` and `Key` blocks are refused by type below.
 */
const START_EVENT = "start";
const POINTER_EVENT = "pointer";

/** The pinned event references the lifecycle pumps hand each receiver. */
const START_EVENT_REFERENCE = "/extensions/KHR_interactivity/events/sceneReady";
const POINTER_EVENT_REFERENCE = "/extensions/KHR_interactivity/events/pointer";

// ── Values ───────────────────────────────────────────────────────────────────

/** The shape a residual C++ expression carries. */
type Shape = "number" | "boolean" | "string" | "vec2" | "vec3" | "vec4";

type Val =
    /** A value generation knows: JSON data, a serialized record, a string. */
    | { k: "static"; value: unknown }
    /** A C++ expression of a known shape. */
    | { k: "residual"; cpp: string; shape: Shape }
    /** An object literal the body built, member by member. */
    | { k: "record"; members: Map<string, Val> }
    /** An array literal with at least one residual element. */
    | { k: "array"; elements: Val[] }
    | {
          k: "closure";
          node: ts.ArrowFunction | ts.FunctionExpression;
          env: Env;
          file: ts.SourceFile;
          module: string;
      }
    | {
          k: "function";
          declaration: ts.FunctionDeclaration | ts.MethodDeclaration;
          file: ts.SourceFile;
          module: string;
          thisValue?: Val;
      }
    | { k: "opaque"; tag: OpaqueTag; data?: unknown };

type OpaqueTag =
    | "ctx"
    | "env"
    | "user-vars"
    | "accessor"
    | "accessor-get"
    | "accessor-set"
    | "def"
    | "math"
    | "string-ctor"
    | "number-ctor"
    | "array-ctor"
    | "object-ctor"
    | "typed-array-ctor"
    | "incoming-signal";

/** One native accessor, the port of a `path-converter.ts` resolution. */
interface NativeAccessor {
    pointer: string;
    /** The pin's `FgType` tag the accessor declares. */
    type: string;
    shape: Shape;
    get: () => Val;
    /** Absent where the pin's accessor has no setter. */
    set?: (value: Val, emit: (line: string) => void) => void;
}

const STATIC_UNDEFINED: Val = { k: "static", value: undefined };

interface Binding {
    value: Val;
    mutable: boolean;
}

class Env {
    private readonly bindings = new Map<string, Binding>();

    public constructor(public readonly parent?: Env) {}

    public lookup(name: string): Binding | undefined {
        return this.bindings.get(name) ?? this.parent?.lookup(name);
    }

    public declare(name: string, value: Val, mutable = false): void {
        this.bindings.set(name, { value, mutable });
    }
}

type Completion =
    | { kind: "normal" }
    | { kind: "return"; value: Val }
    | { kind: "break" };

const NORMAL: Completion = { kind: "normal" };

function isNullish(value: Val): boolean {
    return value.k === "static" && (value.value === undefined || value.value === null);
}

function staticBoolean(value: boolean): Val {
    return { k: "static", value };
}

function staticNumber(value: number): Val {
    return { k: "static", value };
}

const SHAPE_CPP: Record<Shape, string> = {
    number: "double",
    boolean: "bool",
    string: "std::string",
    vec2: "Vec2d",
    vec3: "Vec3d",
    vec4: "Vec4d",
};

const VECTOR_LANES: Record<"vec2" | "vec3" | "vec4", readonly string[]> = {
    vec2: ["x", "y"],
    vec3: ["x", "y", "z"],
    vec4: ["x", "y", "z", "w"],
};

/** The pin's `FgType` tag of a socket or variable, as a native shape. */
function shapeOfFgType(type: string): Shape | "int" | undefined {
    switch (type) {
        case "number":
            return "number";
        case "boolean":
            return "boolean";
        case "string":
        case "ref":
            return "string";
        case "FlowGraphInteger":
            return "int";
        case "Vector2":
            return "vec2";
        case "Vector3":
            return "vec3";
        case "Vector4":
        case "Quaternion":
            return "vec4";
        default:
            return undefined;
    }
}

/** A residual expression's shape, or the static value's. */
function shapeOf(value: Val): Shape | "int" | "record" | "array" | "undefined" | "null" | "other" {
    switch (value.k) {
        case "residual":
            return value.shape;
        case "static": {
            const raw = value.value;
            if (typeof raw === "number") return "number";
            if (typeof raw === "boolean") return "boolean";
            if (typeof raw === "string") return "string";
            if (raw === undefined) return "undefined";
            if (raw === null) return "null";
            if (Array.isArray(raw)) return "array";
            if (typeof raw === "object") {
                const record = raw as Record<string, unknown>;
                if (record.__fgInt === true) return "int";
                const lanes = Object.keys(record).sort().join(",");
                if (lanes === "x,y") return "vec2";
                if (lanes === "x,y,z") return "vec3";
                if (lanes === "w,x,y,z") return "vec4";
                return "record";
            }
            return "other";
        }
        case "record": {
            const names = [...value.members.keys()].sort().join(",");
            if (value.members.get("__fgInt")?.k === "static" &&
                (value.members.get("__fgInt") as { value: unknown }).value === true) {
                return "int";
            }
            if (names === "x,y") return "vec2";
            if (names === "x,y,z") return "vec3";
            if (names === "w,x,y,z") return "vec4";
            return "record";
        }
        case "array":
            return "array";
        default:
            return "other";
    }
}

function cppOfStatic(value: unknown, at: () => never): string {
    if (typeof value === "number") return doubleLiteral(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        const lanes = Object.keys(record).sort().join(",");
        const storage =
            lanes === "x,y" ? "FlowGraphVec2" : lanes === "x,y,z" ? "FlowGraphVec3" : lanes === "w,x,y,z" ? "FlowGraphVec4" : undefined;
        if (storage) {
            const names = VECTOR_LANES[storage === "FlowGraphVec2" ? "vec2" : storage === "FlowGraphVec3" ? "vec3" : "vec4"];
            return `${storage}{${names.map((lane) => cppOfStatic(record[lane], at)).join(", ")}}`;
        }
    }
    return at();
}

// ── The per-graph lowering ───────────────────────────────────────────────────

interface SlotState {
    member: string;
    /** `int` slots hold the `fgInt` record's `value` lane as a double. */
    shape: Shape | "int";
    /** A slot every store writes the same static value into. */
    staticValue?: unknown;
    stored: boolean;
}

interface VariableState {
    member: string;
    shape: Shape | "int";
}

interface EmittedFunction {
    name: string;
    signature: string;
    lines: string[];
}

/**
 * The residual body being emitted: its lines and the indentation of the
 * statement under evaluation. A nested residual `if` deepens the indent.
 */
class Emitter {
    public readonly lines: string[] = [];
    public indent = "    ";

    public emit(line: string): void {
        this.lines.push(`${this.indent}${line}`);
    }
}

class GraphLowering {
    private readonly blocks = new Map<string, FlowGraphBlock>();
    /** Output slots some consumer's input names, by `<block>:<socket>`. */
    private readonly consumed = new Set<string>();
    private readonly slots = new Map<string, SlotState>();
    private readonly variables = new Map<string, VariableState>();
    private readonly members: string[] = [];
    private readonly functions: EmittedFunction[] = [];
    private readonly lowered = new Map<string, string>();
    private readonly lowering = new Set<string>();
    private readonly accessors = new Map<string, NativeAccessor | null>();
    private readonly selectableNodes = new Map<number, string>();
    private readonly moduleEnvs = new Map<string, Env>();
    private readonly startBlocks: FlowGraphBlock[] = [];
    private readonly pointerBlocks: FlowGraphBlock[] = [];

    public constructor(
        private readonly context: LoweringContext,
        private readonly owner: FlowGraphLowerer,
        private readonly program: FlowGraphProgram,
        public readonly namespace: string,
    ) {
        for (const block of program.blocks) this.blocks.set(block.id, block);
        for (const block of program.blocks) {
            for (const socket of block.dataIn) {
                if (socket.source) {
                    this.consumed.add(`${socket.source.blockId}:${socket.source.socket}`);
                }
            }
        }
    }

    // ── Entry ─────────────────────────────────────────────────────────────

    public lower(): string {
        for (const [name, variable] of Object.entries(this.program.variables)) {
            const shape = shapeOfFgType(variable.type);
            if (!shape || shape === "string") {
                throw new Error(
                    `The flow-graph lowering does not store a ${variable.type} variable ('${name}').`,
                );
            }
            const member = `var_${identifier(name)}`;
            const seed = variable.value;
            this.variables.set(name, { member, shape });
            this.members.push(`${this.memberType(shape)} ${member} = ${this.memberInitializer(shape, seed)};`);
        }
        for (const pointer of Object.keys(this.program.accessors)) this.accessorFor(pointer);
        for (const block of this.program.blocks) {
            this.owner.blockDefinition(block.type);
            if (block.event === undefined) continue;
            if (block.event === START_EVENT) this.startBlocks.push(block);
            else if (block.event === POINTER_EVENT) this.pointerBlocks.push(block);
            else {
                throw new Error(
                    `The flow-graph lowering does not dispatch the '${block.event}' event ` +
                        `channel (block ${block.id}, ${block.type}).`,
                );
            }
        }
        // The pin fires every receiver of a channel in block order
        // (`pumpFlowGraphLifecycle` filters `rt.graph.blocks`).
        for (const block of this.startBlocks) this.ensureExecute(block.id);
        for (const block of this.pointerBlocks) this.ensureExecute(block.id);
        return this.emit();
    }

    private memberType(shape: Shape | "int"): string {
        return shape === "int" ? "double" : SHAPE_CPP[shape];
    }

    private memberInitializer(shape: Shape | "int", seed: unknown): string {
        if (shape === "int") {
            const record = seed as { value?: unknown } | undefined;
            return doubleLiteral(typeof record?.value === "number" ? record.value : 0);
        }
        if (shape === "number") return doubleLiteral(typeof seed === "number" ? seed : 0);
        if (shape === "boolean") return seed ? "true" : "false";
        return cppOfStatic(seed, () => {
            throw new Error(`A ${shape} variable seed must be a vector.`);
        });
    }

    // ── Accessors: the port of path-converter.ts over static pointers ─────

    public accessorFor(pointer: string): NativeAccessor | null {
        const cached = this.accessors.get(pointer);
        if (cached !== undefined) return cached;
        const accessor = this.resolvePointer(pointer);
        this.accessors.set(pointer, accessor);
        return accessor;
    }

    /**
     * The native field behind a constant pointer, from what the pin's own
     * `resolvePointerAccessor` touched when `src/pinned-flow-graph.ts`
     * executed it over recording stand-ins: a node's `visible` (the pin's
     * cascade walks `children` on the way) and its closure-held
     * selectability, and a material's base-colour texture transform lanes
     * (`_uboVersion` is the pin's dirty bump; the native record is rebuilt
     * per draw). An accessor touching anything else -- node TRS, another
     * texture slot, camera or animation state -- refuses by name.
     */
    private resolvePointer(pointer: string): NativeAccessor | null {
        const accessor = this.program.accessors[pointer];
        if (accessor === undefined) {
            throw new Error(`The parser resolved no accessor for the pointer ${pointer}.`);
        }
        // The pin binds nothing: the block reads the type's default with
        // `isValid` false, and a set fires `error`.
        if (accessor === null) return null;
        const { target, touches, type } = accessor;
        const members = touches.map((touch) => touch.path);
        const shape = shapeOfFgType(type);
        const refuse = (): never => {
            throw new Error(
                `The flow-graph lowering does not map the pin's accessor for ${pointer} ` +
                    `(${type}; ${target ? `${target.kind} ${target.index}` : "no target"}; ` +
                    `touches ${members.join(", ") || "nothing"}).`,
            );
        };
        if (!target || touches.some((touch) => touch.kind !== target.kind || touch.index !== target.index)) {
            return refuse();
        }
        if (target.kind === "node") {
            if (shape !== "boolean") return refuse();
            const node = target.index;
            if (members.length === 0) {
                // `resolveSelectability`: a closure the pick filter reads.
                let member = this.selectableNodes.get(node);
                if (!member) {
                    member = `selectable_${node}`;
                    this.selectableNodes.set(node, member);
                    this.members.push(`bool ${member} = true;`);
                }
                const cpp = `state.${member}`;
                return {
                    pointer,
                    type,
                    shape,
                    get: () => ({ k: "residual", cpp, shape }),
                    set: (value, emit) => {
                        emit(`${cpp} = ${this.booleanCpp(value)};`);
                    },
                };
            }
            if (!members.includes("visible") || !members.every((member) => member === "visible" || member === "children.length")) {
                return refuse();
            }
            return {
                pointer,
                type,
                shape,
                get: () => ({
                    k: "residual",
                    cpp: `gltf_node_visible(host.engine, host.asset, ${node}u)`,
                    shape,
                }),
                ...(accessor.writable
                    ? {
                          set: (value: Val, emit: (line: string) => void) => {
                              emit(`set_gltf_node_visible(host.engine, host.asset, ${node}u, ${this.booleanCpp(value)});`);
                          },
                      }
                    : {}),
            };
        }
        if (shape !== "vec2") return refuse();
        const lanes = members.filter((member) => member !== "_uboVersion");
        const [slot, ...otherSlots] = [...new Set(lanes.map((member) => member.split(".")[0]))];
        if (slot === undefined || otherSlots.length > 0) return refuse();
        if (slot !== "baseColorTexture") {
            throw new Error(
                `The flow-graph lowering maps KHR_texture_transform pointers on ` +
                    `baseColorTexture only; ${pointer} touches ${slot}.`,
            );
        }
        const fields = new Set(lanes.map((member) => member.split(".")[1]));
        const pair = (u: string, v: string): boolean => fields.size === 2 && fields.has(u) && fields.has(v);
        const native = pair("uOffset", "vOffset")
            ? ["u_offset", "v_offset"]
            : pair("uScale", "vScale")
              ? ["u_scale", "v_scale"]
              : refuse();
        const transform = `gltf_base_color_transform(host.engine, host.asset, ${target.index}u)`;
        return {
            pointer,
            type,
            shape,
            get: () => ({
                k: "record",
                members: new Map<string, Val>([
                    ["x", { k: "residual", cpp: `static_cast<double>(${transform}.${native[0]})`, shape: "number" }],
                    ["y", { k: "residual", cpp: `static_cast<double>(${transform}.${native[1]})`, shape: "number" }],
                ]),
            }),
            ...(accessor.writable
                ? {
                      set: (value: Val, emit: (line: string) => void) => {
                          const [x, y] = this.vec2Lanes(value);
                          emit(`{`);
                          emit(`    TextureTransform& transform = ${transform};`);
                          emit(`    transform.${native[0]} = static_cast<float>(${x});`);
                          emit(`    transform.${native[1]} = static_cast<float>(${y});`);
                          emit(`}`);
                      },
                  }
                : {}),
        };
    }

    /** `toVec2(v)`: `{ x: o.x ?? 0, y: o.y ?? 0 }` over the value a set carries. */
    private vec2Lanes(value: Val): [string, string] {
        const lane = (name: string): string => {
            const member = this.member(value, name);
            if (isNullish(member)) return "0.0";
            return this.numberCpp(member);
        };
        return [lane("x"), lane("y")];
    }

    public booleanCpp(value: Val): string {
        if (value.k === "static") return value.value ? "true" : "false";
        if (value.k === "residual" && value.shape === "boolean") return value.cpp;
        throw new Error("A boolean accessor write takes a boolean.");
    }

    public numberCpp(value: Val): string {
        if (value.k === "static" && typeof value.value === "number") return doubleLiteral(value.value);
        if (value.k === "residual" && value.shape === "number") return value.cpp;
        if (value.k === "record" && shapeOf(value) === "int") return this.numberCpp(value.members.get("value")!);
        throw new Error("Expected a number.");
    }

    // ── Block functions ───────────────────────────────────────────────────

    private block(id: string): FlowGraphBlock {
        const block = this.blocks.get(id);
        if (!block) throw new Error(`The flow graph has no block '${id}'.`);
        return block;
    }

    private functionName(kind: "update" | "execute", id: string): string {
        return `${kind}_${identifier(id)}`;
    }

    /** The producer's `updateOutputs`, emitted once; every pull calls it. */
    private ensureUpdate(id: string): string {
        const key = `update:${id}`;
        const existing = this.lowered.get(key);
        if (existing) return existing;
        if (this.lowering.has(key)) {
            throw new Error(
                `The flow graph's data edges form a cycle through block '${id}'; ` +
                    "the pin breaks one with the socket default, which this port does not emulate.",
            );
        }
        this.lowering.add(key);
        const block = this.block(id);
        const definition = this.owner.blockDefinition(block.type);
        if (!definition.updateOutputs) {
            throw new Error(`Block '${id}' (${block.type}) has no updateOutputs and is pulled from.`);
        }
        const name = this.functionName("update", id);
        this.lowered.set(key, name);
        const emitter = new Emitter();
        this.runBlockMethod(definition, "updateOutputs", block, emitter, undefined);
        this.functions.push({
            name,
            signature: `void ${name}([[maybe_unused]] State& state, [[maybe_unused]] FlowGraphHost& host)`,
            lines: emitter.lines,
        });
        this.lowering.delete(key);
        return name;
    }

    private isPointerBlock(block: FlowGraphBlock): boolean {
        return block.event === POINTER_EVENT;
    }

    /** A target's `execute`, emitted once; every push calls it. */
    private ensureExecute(id: string): string {
        const key = `execute:${id}`;
        const existing = this.lowered.get(key);
        if (existing) return existing;
        const block = this.block(id);
        const definition = this.owner.blockDefinition(block.type);
        if (!definition.execute) {
            throw new Error(`Block '${id}' (${block.type}) has no execute and is signalled.`);
        }
        const name = this.functionName("execute", id);
        // Flow edges may cycle (a loop is a signal cascade); the prototype
        // is declared ahead, so a call into a body still being emitted is
        // an ordinary call.
        this.lowered.set(key, name);
        const emitter = new Emitter();
        const payload = this.eventPayload(block);
        this.runBlockMethod(definition, "execute", block, emitter, payload);
        const parameters = [
            "[[maybe_unused]] State& state",
            "[[maybe_unused]] FlowGraphHost& host",
            ...(this.isPointerBlock(block)
                ? ["[[maybe_unused]] const FlowGraphPointerEvent& payload"]
                : []),
        ];
        this.functions.push({
            name,
            signature: `void ${name}(${parameters.join(", ")})`,
            lines: emitter.lines,
        });
        return name;
    }

    /** `ctx.executionVariables["<id>:lastEvent"]`, as the lifecycle pump set it. */
    private eventPayload(block: FlowGraphBlock): Val | undefined {
        if (block.event === START_EVENT) {
            return { k: "static", value: { event: START_EVENT_REFERENCE } };
        }
        if (block.event === POINTER_EVENT) {
            return {
                k: "record",
                members: new Map<string, Val>([
                    ["nodeIndex", { k: "residual", cpp: "payload.node_index", shape: "number" }],
                    ["controllerIndex", { k: "residual", cpp: "payload.controller_index", shape: "number" }],
                    ["event", { k: "static", value: POINTER_EVENT_REFERENCE }],
                ]),
            };
        }
        return undefined;
    }

    private runBlockMethod(
        definition: BlockDefinition,
        method: "updateOutputs" | "execute",
        block: FlowGraphBlock,
        emitter: Emitter,
        payload: Val | undefined,
    ): void {
        const declaration = definition[method]!;
        const interpreter = new Interpreter(this, this.context, emitter);
        const env = new Env(this.moduleEnv(definition.module));
        const params = declaration.parameters.map((parameter) => parameter.name.getText(definition.file));
        const values: Val[] = [
            { k: "static", value: block },
            { k: "opaque", tag: "ctx", data: { block, payload } },
            { k: "opaque", tag: "env" },
            { k: "opaque", tag: "incoming-signal" },
        ];
        params.forEach((name, index) => env.declare(name, values[index] ?? STATIC_UNDEFINED));
        const thisValue: Val = { k: "opaque", tag: "def", data: definition };
        const completion = interpreter.statements(
            declaration.body!.statements,
            env,
            definition.file,
            definition.module,
            thisValue,
            "emit",
        );
        if (completion.kind === "break") {
            this.context.contractError(declaration, "A block body broke out of nothing.");
        }
    }

    public moduleEnv(module: string): Env {
        let env = this.moduleEnvs.get(module);
        if (!env) {
            env = new Env();
            this.moduleEnvs.set(module, env);
        }
        return env;
    }

    // ── The restated runtime: pull, store, push ───────────────────────────

    /**
     * `getDataValue(ctx, env, block, socket)`: the socket's wired producer
     * runs, its transport slot is read, and the value is coerced to the
     * socket's type -- or the socket default where nothing is wired.
     */
    public pull(block: FlowGraphBlock, socket: string, interpreter: Interpreter, emitter: Emitter): Val {
        const input = block.dataIn.find((candidate) => candidate.name === socket);
        if (!input) return STATIC_UNDEFINED;
        let raw: Val;
        if (input.source) {
            const producerId = input.source.blockId;
            if (!this.blocks.has(producerId)) {
                raw = this.socketDefault(input, interpreter);
            } else {
                if (input.source.scale !== undefined) {
                    throw new Error(
                        `The flow-graph lowering does not scale a connected value (block ${block.id}, socket ${socket}).`,
                    );
                }
                const update = this.ensureUpdate(producerId);
                emitter.emit(`${update}(state, host);`);
                const key = `${producerId}:${input.source.socket}`;
                const slot = this.slots.get(key);
                raw = slot?.stored ? this.readSlot(slot) : this.socketDefault(input, interpreter);
            }
        } else {
            raw = this.socketDefault(input, interpreter);
        }
        return interpreter.callPinned("src/flow-graph/rich-type.ts", "coerceValue", [
            raw,
            { k: "static", value: input.type },
        ]);
    }

    private socketDefault(input: FlowGraphSocket, interpreter: Interpreter): Val {
        if (input.defaultValue !== undefined && input.defaultValue !== null) {
            return { k: "static", value: input.defaultValue };
        }
        return interpreter.callPinned("src/flow-graph/rich-type.ts", "defaultForType", [
            { k: "static", value: input.type },
        ]);
    }

    private readSlot(slot: SlotState): Val {
        if (slot.staticValue !== undefined) {
            return { k: "static", value: slot.staticValue };
        }
        const cpp = `state.${slot.member}`;
        if (slot.shape === "int") {
            return {
                k: "record",
                members: new Map<string, Val>([
                    ["value", { k: "residual", cpp, shape: "number" }],
                    ["__fgInt", staticBoolean(true)],
                ]),
            };
        }
        if (slot.shape === "vec2" || slot.shape === "vec3" || slot.shape === "vec4") {
            return {
                k: "record",
                members: new Map(
                    VECTOR_LANES[slot.shape].map((lane): [string, Val] => [
                        lane,
                        { k: "residual", cpp: `${cpp}.${lane}`, shape: "number" },
                    ]),
                ),
            };
        }
        return { k: "residual", cpp, shape: slot.shape };
    }

    /** `setDataValue(ctx, block, socket, value)`: the transport slot write. */
    public store(block: FlowGraphBlock, socket: string, value: Val, emitter: Emitter): void {
        const key = `${block.id}:${socket}`;
        if (!this.consumed.has(key)) return;
        const shape = shapeOf(value);
        let slot = this.slots.get(key);
        if (value.k === "static" && (shape === "number" || shape === "boolean" || shape === "string" || shape === "int" || shape === "vec2" || shape === "vec3" || shape === "vec4")) {
            if (slot && slot.staticValue !== value.value) {
                throw new Error(
                    `Block ${block.id} writes '${socket}' with different values on different paths.`,
                );
            }
            if (!slot) {
                slot = { member: "", shape: shape === "int" ? "int" : shape, staticValue: value.value, stored: true };
                this.slots.set(key, slot);
            }
            return;
        }
        if (shape !== "number" && shape !== "boolean" && shape !== "int" && shape !== "vec2" && shape !== "vec3" && shape !== "vec4") {
            throw new Error(
                `Block ${block.id} writes a ${shape} into '${socket}', which this port does not transport.`,
            );
        }
        if (!slot) {
            const member = `slot_${identifier(block.id)}_${identifier(socket)}`;
            slot = { member, shape, stored: true };
            this.slots.set(key, slot);
            this.members.push(`${this.memberType(shape)} ${member}{};`);
        } else if (slot.staticValue !== undefined || slot.shape !== shape) {
            throw new Error(
                `Block ${block.id} writes '${socket}' with different shapes on different paths.`,
            );
        }
        emitter.emit(`state.${slot.member} = ${this.storeCpp(value, shape)};`);
    }

    private storeCpp(value: Val, shape: Shape | "int"): string {
        if (shape === "int") return this.numberCpp(value);
        if (shape === "number") return this.numberCpp(value);
        if (shape === "boolean") return this.booleanCpp(value);
        if (shape === "vec2" || shape === "vec3" || shape === "vec4") {
            const lanes = VECTOR_LANES[shape].map((lane) => this.numberCpp(this.member(value, lane)));
            return `${SHAPE_CPP[shape]}{${lanes.join(", ")}}`;
        }
        throw new Error(`No storage for a ${shape}.`);
    }

    public member(value: Val, name: string): Val {
        if (value.k === "record") return value.members.get(name) ?? STATIC_UNDEFINED;
        if (value.k === "static") {
            const raw = value.value;
            if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
                return { k: "static", value: (raw as Record<string, unknown>)[name] };
            }
            if (Array.isArray(raw) && name === "length") return staticNumber(raw.length);
            return STATIC_UNDEFINED;
        }
        if (value.k === "residual" && (value.shape === "vec2" || value.shape === "vec3" || value.shape === "vec4")) {
            if (VECTOR_LANES[value.shape].includes(name)) {
                return { k: "residual", cpp: `${value.cpp}.${name}`, shape: "number" };
            }
            return STATIC_UNDEFINED;
        }
        if (value.k === "array" && name === "length") return staticNumber(value.elements.length);
        if (value.k === "residual") return STATIC_UNDEFINED;
        throw new Error(`No member '${name}' on a ${value.k}.`);
    }

    /** `activateSignal(ctx, env, block, socket)`: each target's `execute`. */
    public push(block: FlowGraphBlock, socket: string, emitter: Emitter): void {
        const output = block.signalOut.find((candidate) => candidate.name === socket);
        if (!output) return;
        for (const target of output.targets) {
            const targetBlock = this.blocks.get(target.blockId);
            if (!targetBlock) continue;
            if (!targetBlock.signalIn.includes(target.socket)) {
                throw new Error(
                    `Block ${block.id} signals '${target.socket}' on ${target.blockId}, which declares no such input.`,
                );
            }
            const execute = this.ensureExecute(target.blockId);
            if (this.isPointerBlock(targetBlock)) {
                throw new Error(`Block ${block.id} signals the event block ${target.blockId}.`);
            }
            emitter.emit(`${execute}(state, host);`);
        }
    }

    /** `ctx.userVariables[name]` as a read. */
    public readVariable(name: string): Val {
        const variable = this.variables.get(name);
        if (!variable) throw new Error(`The flow graph declares no variable '${name}'.`);
        const cpp = `state.${variable.member}`;
        if (variable.shape === "int") {
            return {
                k: "record",
                members: new Map<string, Val>([
                    ["value", { k: "residual", cpp, shape: "number" }],
                    ["__fgInt", staticBoolean(true)],
                ]),
            };
        }
        if (variable.shape === "vec2" || variable.shape === "vec3" || variable.shape === "vec4") {
            return {
                k: "record",
                members: new Map(
                    VECTOR_LANES[variable.shape].map((lane): [string, Val] => [
                        lane,
                        { k: "residual", cpp: `${cpp}.${lane}`, shape: "number" },
                    ]),
                ),
            };
        }
        return { k: "residual", cpp, shape: variable.shape };
    }

    /** `ctx.userVariables[name] = value`. */
    public writeVariable(name: string, value: Val, emitter: Emitter): void {
        const variable = this.variables.get(name);
        if (!variable) throw new Error(`The flow graph declares no variable '${name}'.`);
        emitter.emit(`state.${variable.member} = ${this.storeCpp(value, variable.shape)};`);
    }

    // ── Emission ──────────────────────────────────────────────────────────

    private emit(): string {
        const prototypes = this.functions.map((fn) => `${fn.signature};`);
        const bodies = this.functions.map(
            (fn) => `${fn.signature} {\n${fn.lines.join("\n")}\n}`,
        );
        const startCalls = this.startBlocks.map(
            (block) => `        ${this.functionName("execute", block.id)}(state, host);`,
        );
        const pointerCalls = this.pointerBlocks.map(
            (block) => `        ${this.functionName("execute", block.id)}(state, host, payload);`,
        );
        const selectableCases = [...this.selectableNodes].map(
            ([node, member]) => `            case ${node}u: return state.${member};`,
        );
        return `namespace ${this.namespace} {

/** The graph's variables, transport slots and selectability flags. */
struct State {
${this.members.map((member) => `    ${member}`).join("\n")}
};

${prototypes.join("\n")}

${bodies.join("\n\n")}

struct Runtime final : FlowGraphRuntime {
    State state{};
    FlowGraphHost host;

    Runtime(Engine& engine, AssetHandle asset)
        : host{engine, asset} {
        asset_scope = asset;
    }

    bool uses_pointer_event() const override {
        return ${this.pointerBlocks.length > 0 ? "true" : "false"};
    }

    void fire_start() override {
${startCalls.length > 0 ? startCalls.join("\n") : "        // No event/onStart receiver."}
    }

    void pointer([[maybe_unused]] const FlowGraphPointerEvent& payload) override {
${pointerCalls.length > 0 ? pointerCalls.join("\n") : "        // No event/onSelect receiver."}
    }

    bool node_selectable([[maybe_unused]] std::size_t node_index) const override {
${selectableCases.length > 0
            ? `        switch (node_index) {\n${selectableCases.join("\n")}\n            default: return true;\n        }`
            : "        return true;"}
    }
};

} // namespace ${this.namespace}`;
    }
}

// ── The interpreter over pinned bodies ───────────────────────────────────────

/**
 * Evaluates pinned statements over `Val`s: static data folds, residual
 * operands emit C++, and the block-runtime calls resolve through the graph.
 */
class Interpreter {
    /** The pinned helpers the plumbing calls directly, resolved once each. */
    private readonly pinnedCalls = new Map<
        string,
        { target: Val & { k: "function" }; site: ts.CallExpression }
    >();

    public constructor(
        private readonly graph: GraphLowering,
        private readonly context: LoweringContext,
        private readonly emitter: Emitter,
    ) {}

    private fail(node: ts.Node, what: string): never {
        return this.context.contractError(
            node,
            `The flow-graph lowering does not evaluate this ${what}.`,
        );
    }

    // ── Statements ────────────────────────────────────────────────────────

    public statements(
        list: readonly ts.Statement[],
        env: Env,
        file: ts.SourceFile,
        module: string,
        thisValue: Val | undefined,
        mode: "emit" | "inline",
    ): Completion {
        for (const statement of list) {
            const completion = this.statement(statement, env, file, module, thisValue, mode);
            if (completion.kind !== "normal") return completion;
        }
        return NORMAL;
    }

    private statement(
        statement: ts.Statement,
        env: Env,
        file: ts.SourceFile,
        module: string,
        thisValue: Val | undefined,
        mode: "emit" | "inline",
    ): Completion {
        if (ts.isVariableStatement(statement)) {
            const mutable = (statement.declarationList.flags & ts.NodeFlags.Const) === 0;
            for (const declaration of statement.declarationList.declarations) {
                const value = declaration.initializer
                    ? this.expression(declaration.initializer, env, file, module, thisValue)
                    : STATIC_UNDEFINED;
                this.bindPattern(declaration.name, value, env, file, mutable);
            }
            return NORMAL;
        }
        if (ts.isExpressionStatement(statement)) {
            this.expression(statement.expression, env, file, module, thisValue);
            return NORMAL;
        }
        if (ts.isIfStatement(statement)) {
            const condition = this.expression(statement.expression, env, file, module, thisValue);
            const known = this.truthiness(condition, statement.expression);
            if (known.k === "static") {
                if (known.value) return this.statement(statement.thenStatement, new Env(env), file, module, thisValue, mode);
                return statement.elseStatement
                    ? this.statement(statement.elseStatement, new Env(env), file, module, thisValue, mode)
                    : NORMAL;
            }
            if (mode === "inline") {
                this.fail(statement, "run-time branch inside an inlined pinned body");
            }
            this.emitter.emit(`if (${known.cpp}) {`);
            this.emitter.indent += "    ";
            const thenCompletion = this.statement(statement.thenStatement, new Env(env), file, module, thisValue, mode);
            if (thenCompletion.kind === "return") {
                if (thenCompletion.value.k !== "static" || thenCompletion.value.value !== undefined) {
                    this.fail(statement, "value return inside a run-time branch");
                }
                this.emitter.emit("return;");
            } else if (thenCompletion.kind === "break") {
                this.fail(statement, "break inside a run-time branch");
            }
            this.emitter.indent = this.emitter.indent.slice(4);
            if (statement.elseStatement) {
                this.emitter.emit("} else {");
                this.emitter.indent += "    ";
                const elseCompletion = this.statement(statement.elseStatement, new Env(env), file, module, thisValue, mode);
                if (elseCompletion.kind === "return") {
                    if (elseCompletion.value.k !== "static" || elseCompletion.value.value !== undefined) {
                        this.fail(statement, "value return inside a run-time branch");
                    }
                    this.emitter.emit("return;");
                } else if (elseCompletion.kind === "break") {
                    this.fail(statement, "break inside a run-time branch");
                }
                this.emitter.indent = this.emitter.indent.slice(4);
            }
            this.emitter.emit("}");
            return NORMAL;
        }
        if (ts.isBlock(statement)) {
            return this.statements(statement.statements, new Env(env), file, module, thisValue, mode);
        }
        if (ts.isReturnStatement(statement)) {
            return {
                kind: "return",
                value: statement.expression
                    ? this.expression(statement.expression, env, file, module, thisValue)
                    : STATIC_UNDEFINED,
            };
        }
        if (ts.isBreakStatement(statement)) return { kind: "break" };
        if (ts.isForOfStatement(statement)) {
            const iterated = this.expression(statement.expression, env, file, module, thisValue);
            const elements = this.staticElements(iterated, statement.expression);
            const initializer = statement.initializer;
            if (!ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) {
                this.fail(statement, "for-of initializer");
            }
            for (const element of elements) {
                const scope = new Env(env);
                this.bindPattern(initializer.declarations[0]!.name, element, scope, file, false);
                const completion = this.statement(statement.statement, scope, file, module, thisValue, mode);
                if (completion.kind === "break") break;
                if (completion.kind === "return") return completion;
            }
            return NORMAL;
        }
        if (ts.isSwitchStatement(statement)) {
            const discriminant = this.expression(statement.expression, env, file, module, thisValue);
            if (discriminant.k !== "static") this.fail(statement, "switch over a run-time value");
            const clauses = statement.caseBlock.clauses;
            let selected = clauses.findIndex((clause) => {
                if (!ts.isCaseClause(clause)) return false;
                const value = this.expression(clause.expression, env, file, module, thisValue);
                if (value.k !== "static") this.fail(clause, "switch case over a run-time value");
                return value.value === discriminant.value;
            });
            if (selected < 0) selected = clauses.findIndex(ts.isDefaultClause);
            if (selected < 0) return NORMAL;
            const scope = new Env(env);
            for (let index = selected; index < clauses.length; index += 1) {
                const completion = this.statements(clauses[index]!.statements, scope, file, module, thisValue, mode);
                if (completion.kind === "break") return NORMAL;
                if (completion.kind === "return") return completion;
            }
            return NORMAL;
        }
        if (ts.isThrowStatement(statement)) {
            return this.context.contractError(
                statement,
                "The flow graph reaches a pinned throw at generation.",
            );
        }
        return this.fail(statement, "statement");
    }

    private bindPattern(
        name: ts.BindingName,
        value: Val,
        env: Env,
        file: ts.SourceFile,
        mutable: boolean,
    ): void {
        if (ts.isIdentifier(name)) {
            env.declare(name.text, value, mutable);
            return;
        }
        if (ts.isArrayBindingPattern(name)) {
            const elements = this.staticElements(value, name);
            name.elements.forEach((element, index) => {
                if (ts.isOmittedExpression(element)) return;
                if (!ts.isIdentifier(element.name) || element.dotDotDotToken) {
                    this.fail(element, "binding element");
                }
                env.declare(element.name.text, elements[index] ?? STATIC_UNDEFINED, mutable);
            });
            return;
        }
        for (const element of name.elements) {
            if (!ts.isIdentifier(element.name) || element.dotDotDotToken) {
                this.fail(element, "binding element");
            }
            const property = element.propertyName
                ? element.propertyName.getText(file)
                : element.name.text;
            env.declare(element.name.text, this.graph.member(value, property), mutable);
        }
    }

    private staticElements(value: Val, at: ts.Node): Val[] {
        if (value.k === "array") return value.elements;
        if (value.k === "static" && Array.isArray(value.value)) {
            return value.value.map((element): Val => ({ k: "static", value: element }));
        }
        return this.fail(at, "iteration over a run-time list");
    }

    // ── Expressions ───────────────────────────────────────────────────────

    public expression(
        expression: ts.Expression,
        env: Env,
        file: ts.SourceFile,
        module: string,
        thisValue: Val | undefined,
    ): Val {
        const node = this.context.unwrapExpression(expression);
        if (ts.isNumericLiteral(node)) return staticNumber(Number(node.text));
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            return { k: "static", value: node.text };
        }
        if (ts.isTemplateExpression(node)) {
            let text = node.head.text;
            for (const span of node.templateSpans) {
                const value = this.expression(span.expression, env, file, module, thisValue);
                if (value.k !== "static") this.fail(span, "template over a run-time value");
                text += `${String(value.value)}${span.literal.text}`;
            }
            return { k: "static", value: text };
        }
        if (node.kind === ts.SyntaxKind.TrueKeyword) return staticBoolean(true);
        if (node.kind === ts.SyntaxKind.FalseKeyword) return staticBoolean(false);
        if (node.kind === ts.SyntaxKind.NullKeyword) return { k: "static", value: null };
        if (node.kind === ts.SyntaxKind.ThisKeyword) {
            return thisValue ?? this.fail(node, "this outside a method");
        }
        if (ts.isIdentifier(node)) {
            const bound = env.lookup(node.text);
            if (bound) return bound.value;
            return this.resolveFree(node.text, file, module, node);
        }
        if (ts.isPropertyAccessExpression(node)) {
            const owner = this.expression(node.expression, env, file, module, thisValue);
            if (node.questionDotToken && isNullish(owner)) return STATIC_UNDEFINED;
            return this.propertyRead(owner, node.name.text, node);
        }
        if (ts.isElementAccessExpression(node)) {
            const owner = this.expression(node.expression, env, file, module, thisValue);
            if (node.questionDotToken && isNullish(owner)) return STATIC_UNDEFINED;
            const index = this.expression(node.argumentExpression, env, file, module, thisValue);
            return this.elementRead(owner, index, node);
        }
        if (ts.isTypeOfExpression(node)) {
            return { k: "static", value: this.typeofName(this.expression(node.expression, env, file, module, thisValue)) };
        }
        if (ts.isPrefixUnaryExpression(node)) {
            const operand = this.expression(node.operand, env, file, module, thisValue);
            if (node.operator === ts.SyntaxKind.ExclamationToken) {
                const known = this.truthiness(operand, node.operand);
                return known.k === "static"
                    ? staticBoolean(!known.value)
                    : { k: "residual", cpp: `(!${known.cpp})`, shape: "boolean" };
            }
            if (node.operator === ts.SyntaxKind.MinusToken) {
                if (operand.k === "static" && typeof operand.value === "number") {
                    return staticNumber(-operand.value);
                }
                return { k: "residual", cpp: `(-${this.graph.numberCpp(operand)})`, shape: "number" };
            }
            return this.fail(node, "prefix operator");
        }
        if (ts.isConditionalExpression(node)) {
            const condition = this.truthiness(
                this.expression(node.condition, env, file, module, thisValue),
                node.condition,
            );
            if (condition.k === "static") {
                return this.expression(condition.value ? node.whenTrue : node.whenFalse, env, file, module, thisValue);
            }
            const whenTrue = this.expression(node.whenTrue, env, file, module, thisValue);
            const whenFalse = this.expression(node.whenFalse, env, file, module, thisValue);
            const shape = this.commonShape(whenTrue, whenFalse, node);
            return {
                k: "residual",
                cpp: `(${condition.cpp} ? ${this.renderShape(whenTrue, shape)} : ${this.renderShape(whenFalse, shape)})`,
                shape,
            };
        }
        if (ts.isBinaryExpression(node)) return this.binary(node, env, file, module, thisValue);
        if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
            return { k: "closure", node, env, file, module };
        }
        if (ts.isObjectLiteralExpression(node)) {
            const members = new Map<string, Val>();
            for (const property of node.properties) {
                if (ts.isShorthandPropertyAssignment(property)) {
                    members.set(property.name.text, this.expression(property.name, env, file, module, thisValue));
                    continue;
                }
                if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name)) {
                    this.fail(property, "object literal member");
                }
                members.set(property.name.text, this.expression(property.initializer, env, file, module, thisValue));
            }
            return { k: "record", members };
        }
        if (ts.isArrayLiteralExpression(node)) {
            const elements = node.elements.map((element) => this.expression(element, env, file, module, thisValue));
            if (elements.every((element) => element.k === "static")) {
                return { k: "static", value: elements.map((element) => (element as { value: unknown }).value) };
            }
            return { k: "array", elements };
        }
        if (ts.isCallExpression(node)) return this.call(node, env, file, module, thisValue);
        if (ts.isNewExpression(node)) return this.fail(node, "constructor call");
        return this.fail(node, "expression");
    }

    private typeofName(value: Val): string {
        switch (value.k) {
            case "static": {
                const raw = value.value;
                return raw === null ? "object" : typeof raw;
            }
            case "residual":
                return value.shape === "boolean" ? "boolean" : value.shape === "number" ? "number" : value.shape === "string" ? "string" : "object";
            case "record":
            case "array":
            case "opaque":
                return "object";
            case "closure":
            case "function":
                return "function";
        }
    }

    /** JavaScript truthiness, static where the value is, else a C++ bool. */
    private truthiness(value: Val, at: ts.Node): { k: "static"; value: boolean } | { k: "residual"; cpp: string } {
        switch (value.k) {
            case "static": {
                const raw = value.value;
                return { k: "static", value: Boolean(raw) && !(typeof raw === "number" && Number.isNaN(raw)) };
            }
            case "residual":
                if (value.shape === "boolean") return { k: "residual", cpp: value.cpp };
                if (value.shape === "number") {
                    return { k: "residual", cpp: `(${value.cpp} != 0.0 && !std::isnan(${value.cpp}))` };
                }
                if (value.shape === "string") return this.fail(at, "truthiness of a run-time string");
                return { k: "static", value: true };
            case "record":
            case "array":
            case "closure":
            case "function":
                return { k: "static", value: true };
            case "opaque":
                if (value.tag === "accessor-set" || value.tag === "accessor-get") return { k: "static", value: true };
                return { k: "static", value: true };
        }
    }

    private commonShape(left: Val, right: Val, at: ts.Node): Shape {
        const shapes = new Set([shapeOf(left), shapeOf(right)]);
        if (shapes.size === 1) {
            const [shape] = shapes;
            if (shape === "number" || shape === "boolean" || shape === "string") return shape;
        }
        return this.fail(at, `conditional over ${[...shapes].join(" and ")}`);
    }

    private renderShape(value: Val, shape: Shape): string {
        if (shape === "number") return this.graph.numberCpp(value);
        if (shape === "boolean") return this.graph.booleanCpp(value);
        if (value.k === "static") return cppOfStatic(value.value, () => { throw new Error("Unrenderable static."); });
        if (value.k === "residual") return value.cpp;
        throw new Error(`Cannot render a ${value.k} as ${shape}.`);
    }

    private propertyRead(owner: Val, name: string, at: ts.Node): Val {
        if (owner.k === "opaque") {
            switch (owner.tag) {
                case "ctx":
                    if (name === "userVariables") return { k: "opaque", tag: "user-vars" };
                    // No admitted block type registers a pending task, so
                    // the list the pin scans for interpolations is empty.
                    if (name === "pending") return { k: "static", value: [] };
                    if (name === "rightHanded") return staticBoolean(true);
                    return this.fail(at, `read of ctx.${name}`);
                case "accessor": {
                    const accessor = owner.data as NativeAccessor;
                    if (name === "type") return { k: "static", value: accessor.type };
                    if (name === "get") return { k: "opaque", tag: "accessor-get", data: accessor };
                    if (name === "set") {
                        return accessor.set
                            ? { k: "opaque", tag: "accessor-set", data: accessor }
                            : STATIC_UNDEFINED;
                    }
                    if (name === "target") return this.fail(at, "read of an accessor target");
                    return STATIC_UNDEFINED;
                }
                case "def": {
                    const definition = owner.data as BlockDefinition;
                    if (name === "updateOutputs" || name === "execute") {
                        const declaration = definition[name];
                        if (!declaration) return STATIC_UNDEFINED;
                        return { k: "function", declaration, file: definition.file, module: definition.module, thisValue: owner };
                    }
                    if (name === "type") return { k: "static", value: definition.type };
                    return this.fail(at, `read of def.${name}`);
                }
                case "math":
                    return { k: "opaque", tag: "math", data: name };
                case "number-ctor":
                    return { k: "opaque", tag: "number-ctor", data: name };
                case "array-ctor":
                    return { k: "opaque", tag: "array-ctor", data: name };
                default:
                    return this.fail(at, `read of ${owner.tag}.${name}`);
            }
        }
        if (owner.k === "closure" || owner.k === "function") this.fail(at, "member of a function");
        return this.graph.member(owner, name);
    }

    private elementRead(owner: Val, index: Val, at: ts.Node): Val {
        if (owner.k === "opaque" && owner.tag === "user-vars") {
            if (index.k !== "static" || typeof index.value !== "string") {
                this.fail(at, "variable read by a run-time name");
            }
            return this.graph.readVariable(index.value);
        }
        if (index.k !== "static") this.fail(at, "element access by a run-time index");
        const key = index.value;
        if (owner.k === "static") {
            const raw = owner.value;
            if (Array.isArray(raw) && typeof key === "number") return { k: "static", value: raw[key] };
            if (typeof raw === "object" && raw !== null) {
                return { k: "static", value: (raw as Record<string, unknown>)[String(key)] };
            }
            return STATIC_UNDEFINED;
        }
        if (owner.k === "array" && typeof key === "number") return owner.elements[key] ?? STATIC_UNDEFINED;
        if (owner.k === "record") return owner.members.get(String(key)) ?? STATIC_UNDEFINED;
        return this.fail(at, "element access");
    }

    private binary(
        node: ts.BinaryExpression,
        env: Env,
        file: ts.SourceFile,
        module: string,
        thisValue: Val | undefined,
    ): Val {
        const kind = node.operatorToken.kind;
        if (kind === ts.SyntaxKind.EqualsToken) {
            return this.assign(node, env, file, module, thisValue);
        }
        if (kind === ts.SyntaxKind.AmpersandAmpersandToken || kind === ts.SyntaxKind.BarBarToken) {
            const left = this.expression(node.left, env, file, module, thisValue);
            const or = kind === ts.SyntaxKind.BarBarToken;
            const known = this.truthiness(left, node.left);
            if (known.k === "static") {
                if (or ? known.value : !known.value) return left;
                return this.expression(node.right, env, file, module, thisValue);
            }
            const right = this.expression(node.right, env, file, module, thisValue);
            const rightKnown = this.truthiness(right, node.right);
            if (shapeOf(left) !== "boolean" || shapeOf(right) !== "boolean") {
                this.fail(node, "value-selecting boolean join over run-time operands");
            }
            const rightCpp = rightKnown.k === "static" ? (rightKnown.value ? "true" : "false") : rightKnown.cpp;
            return { k: "residual", cpp: `(${known.cpp} ${or ? "||" : "&&"} ${rightCpp})`, shape: "boolean" };
        }
        if (kind === ts.SyntaxKind.QuestionQuestionToken) {
            const left = this.expression(node.left, env, file, module, thisValue);
            if (isNullish(left)) return this.expression(node.right, env, file, module, thisValue);
            return left;
        }
        if (kind === ts.SyntaxKind.InKeyword) {
            const key = this.expression(node.left, env, file, module, thisValue);
            const owner = this.expression(node.right, env, file, module, thisValue);
            if (key.k !== "static" || typeof key.value !== "string") this.fail(node, "in over a run-time key");
            return staticBoolean(this.hasMember(owner, key.value, node));
        }
        if (kind === ts.SyntaxKind.InstanceOfKeyword) {
            const left = this.expression(node.left, env, file, module, thisValue);
            const shape = shapeOf(left);
            if (shape === "other") this.fail(node, "instanceof over an unknown value");
            return staticBoolean(false);
        }
        const left = this.expression(node.left, env, file, module, thisValue);
        const right = this.expression(node.right, env, file, module, thisValue);
        const equality =
            kind === ts.SyntaxKind.EqualsEqualsEqualsToken || kind === ts.SyntaxKind.EqualsEqualsToken
                ? true
                : kind === ts.SyntaxKind.ExclamationEqualsEqualsToken || kind === ts.SyntaxKind.ExclamationEqualsToken
                  ? false
                  : undefined;
        if (equality !== undefined) {
            if (left.k === "static" && right.k === "static") {
                return staticBoolean((left.value === right.value) === equality);
            }
            // A residual is never nullish, and only scalars compare by
            // value; a residual against a static of another kind is a
            // question about kinds the shapes already answer.
            if (isNullish(left) || isNullish(right)) return staticBoolean(!equality);
            const leftShape = shapeOf(left);
            const rightShape = shapeOf(right);
            if (leftShape !== rightShape) return staticBoolean(!equality);
            if (leftShape === "number" || leftShape === "boolean") {
                const cpp = `(${this.renderShape(left, leftShape)} ${equality ? "==" : "!="} ${this.renderShape(right, leftShape)})`;
                return { k: "residual", cpp, shape: "boolean" };
            }
            return this.fail(node, `equality over ${leftShape}`);
        }
        const arithmetic = PINNED_ARITHMETIC_OPERATORS;
        const comparison = COMPARISON_OPERATORS;
        if (left.k === "static" && right.k === "static") {
            const a = left.value;
            const b = right.value;
            if (kind === ts.SyntaxKind.PlusToken && (typeof a === "string" || typeof b === "string")) {
                return { k: "static", value: String(a) + String(b) };
            }
            if (typeof a !== "number" || typeof b !== "number") this.fail(node, "operator over non-numbers");
            switch (kind) {
                case ts.SyntaxKind.PlusToken: return staticNumber(a + b);
                case ts.SyntaxKind.MinusToken: return staticNumber(a - b);
                case ts.SyntaxKind.AsteriskToken: return staticNumber(a * b);
                case ts.SyntaxKind.SlashToken: return staticNumber(a / b);
                case ts.SyntaxKind.PercentToken: return staticNumber(a % b);
                case ts.SyntaxKind.LessThanToken: return staticBoolean(a < b);
                case ts.SyntaxKind.LessThanEqualsToken: return staticBoolean(a <= b);
                case ts.SyntaxKind.GreaterThanToken: return staticBoolean(a > b);
                case ts.SyntaxKind.GreaterThanEqualsToken: return staticBoolean(a >= b);
                case ts.SyntaxKind.BarToken: return staticNumber(a | b);
                default: return this.fail(node, "operator");
            }
        }
        const a = this.graph.numberCpp(left);
        const b = this.graph.numberCpp(right);
        const operator = arithmetic.get(kind);
        if (operator) return { k: "residual", cpp: `(${a} ${operator} ${b})`, shape: "number" };
        const compare = comparison.get(kind);
        if (compare) return { k: "residual", cpp: `(${a} ${compare} ${b})`, shape: "boolean" };
        if (kind === ts.SyntaxKind.PercentToken) {
            return { k: "residual", cpp: `std::fmod(${a}, ${b})`, shape: "number" };
        }
        if (kind === ts.SyntaxKind.BarToken && right.k === "static" && right.value === 0) {
            return {
                k: "residual",
                cpp: `static_cast<double>(static_cast<std::int32_t>(${a}))`,
                shape: "number",
            };
        }
        return this.fail(node, "binary operator");
    }

    private hasMember(owner: Val, name: string, at: ts.Node): boolean {
        if (owner.k === "record") return owner.members.has(name);
        if (owner.k === "static") {
            const raw = owner.value;
            return typeof raw === "object" && raw !== null && name in (raw as object);
        }
        if (owner.k === "residual") {
            if (owner.shape === "vec2" || owner.shape === "vec3" || owner.shape === "vec4") {
                return VECTOR_LANES[owner.shape].includes(name);
            }
            return this.fail(at, "in over a run-time scalar");
        }
        return this.fail(at, "in");
    }

    private assign(
        node: ts.BinaryExpression,
        env: Env,
        file: ts.SourceFile,
        module: string,
        thisValue: Val | undefined,
    ): Val {
        const value = this.expression(node.right, env, file, module, thisValue);
        const target = this.context.unwrapExpression(node.left);
        if (ts.isIdentifier(target)) {
            const bound = env.lookup(target.text);
            if (!bound?.mutable) this.fail(target, "assignment to a non-let binding");
            bound.value = value;
            return value;
        }
        if (ts.isElementAccessExpression(target)) {
            const owner = this.expression(target.expression, env, file, module, thisValue);
            const index = this.expression(target.argumentExpression, env, file, module, thisValue);
            if (owner.k === "opaque" && owner.tag === "user-vars") {
                if (index.k !== "static" || typeof index.value !== "string") {
                    this.fail(target, "variable write by a run-time name");
                }
                this.graph.writeVariable(index.value, value, this.emitter);
                return value;
            }
        }
        return this.fail(target, "assignment target");
    }

    // ── Calls ─────────────────────────────────────────────────────────────

    private call(
        node: ts.CallExpression,
        env: Env,
        file: ts.SourceFile,
        module: string,
        thisValue: Val | undefined,
    ): Val {
        const callee = this.context.unwrapExpression(node.expression);
        const args = () => node.arguments.map((argument) => this.expression(argument, env, file, module, thisValue));
        if (ts.isIdentifier(callee)) {
            const bound = env.lookup(callee.text);
            const target = bound ? bound.value : this.resolveFree(callee.text, file, module, callee);
            return this.invoke(target, args(), node, file, env, module, thisValue, callee.text);
        }
        if (ts.isPropertyAccessExpression(callee)) {
            const owner = this.expression(callee.expression, env, file, module, thisValue);
            if (node.questionDotToken && isNullish(owner)) return STATIC_UNDEFINED;
            const method = callee.name.text;
            if (owner.k === "opaque" && owner.tag === "math") {
                return this.mathCall(method, args(), node);
            }
            if (owner.k === "opaque" && owner.tag === "number-ctor") {
                const [value] = args();
                if (!value) this.fail(node, "Number call");
                if (value.k === "static") {
                    const raw = value.value;
                    if (method === "isNaN") return staticBoolean(Number.isNaN(raw));
                    if (method === "isFinite") return staticBoolean(Number.isFinite(raw));
                    if (method === "isInteger") return staticBoolean(Number.isInteger(raw));
                } else if (value.k === "residual" && value.shape === "number") {
                    if (method === "isNaN") return { k: "residual", cpp: `std::isnan(${value.cpp})`, shape: "boolean" };
                    if (method === "isFinite") return { k: "residual", cpp: `std::isfinite(${value.cpp})`, shape: "boolean" };
                }
                return this.fail(node, `Number.${method}`);
            }
            if (owner.k === "opaque" && owner.tag === "array-ctor") {
                if (method === "isArray") {
                    const [value] = args();
                    return staticBoolean(value !== undefined && (value.k === "array" || (value.k === "static" && Array.isArray(value.value))));
                }
                return this.fail(node, `Array.${method}`);
            }
            if (owner.k === "opaque" && owner.tag === "accessor-get") {
                return (owner.data as NativeAccessor).get();
            }
            if (owner.k === "opaque" && owner.tag === "def") {
                const target = this.propertyRead(owner, method, callee);
                return this.invoke(target, args(), node, file, env, module, thisValue, method);
            }
            if (owner.k === "static" && Array.isArray(owner.value)) {
                return this.arrayMethod(owner.value.map((element): Val => ({ k: "static", value: element })), method, args(), node, file, env, module, thisValue);
            }
            if (owner.k === "array") {
                return this.arrayMethod(owner.elements, method, args(), node, file, env, module, thisValue);
            }
            if (owner.k === "record") {
                const member = owner.members.get(method);
                if (member?.k === "opaque" && member.tag === "accessor-get") return (member.data as NativeAccessor).get();
                if (member?.k === "opaque" && member.tag === "accessor-set") {
                    const [value] = args();
                    (member.data as NativeAccessor).set!(value ?? STATIC_UNDEFINED, (line) => this.emitter.emit(line));
                    return STATIC_UNDEFINED;
                }
            }
            if (owner.k === "opaque" && owner.tag === "accessor") {
                const accessor = owner.data as NativeAccessor;
                if (method === "get") return accessor.get();
                if (method === "set") {
                    if (!accessor.set) this.fail(node, "set on a read-only accessor");
                    const [value] = args();
                    accessor.set(value ?? STATIC_UNDEFINED, (line) => this.emitter.emit(line));
                    return STATIC_UNDEFINED;
                }
            }
            return this.fail(node, `method ${method}`);
        }
        return this.fail(node, "call target");
    }

    private arrayMethod(
        elements: readonly Val[],
        method: string,
        args: Val[],
        node: ts.CallExpression,
        file: ts.SourceFile,
        env: Env,
        module: string,
        thisValue: Val | undefined,
    ): Val {
        const predicate = (element: Val, index: number): boolean => {
            const result = this.invoke(args[0]!, [element, staticNumber(index)], node, file, env, module, thisValue, method);
            const known = this.truthiness(result, node);
            if (known.k !== "static") this.fail(node, `run-time ${method} predicate`);
            return known.value;
        };
        switch (method) {
            case "some":
                return staticBoolean(elements.some(predicate));
            case "every":
                return staticBoolean(elements.every(predicate));
            case "find": {
                const found = elements.find(predicate);
                return found ?? STATIC_UNDEFINED;
            }
            case "includes": {
                const [needle] = args;
                return staticBoolean(elements.some((element) => element.k === "static" && needle?.k === "static" && element.value === needle.value));
            }
            case "map": {
                const mapped = elements.map((element, index) =>
                    this.invoke(args[0]!, [element, staticNumber(index)], node, file, env, module, thisValue, method),
                );
                return mapped.every((element) => element.k === "static")
                    ? { k: "static", value: mapped.map((element) => (element as { value: unknown }).value) }
                    : { k: "array", elements: mapped };
            }
            default:
                return this.fail(node, `array method ${method}`);
        }
    }

    private mathCall(method: string, args: Val[], node: ts.CallExpression): Val {
        if (args.every((argument) => argument.k === "static" && typeof argument.value === "number")) {
            const numbers = args.map((argument) => (argument as { value: number }).value);
            const fn = (Math as unknown as Record<string, (...values: number[]) => number>)[method];
            if (typeof fn !== "function") this.fail(node, `Math.${method}`);
            return staticNumber(fn(...numbers));
        }
        const spell = PINNED_MATH_CALLS.get(`Math.${method}`);
        if (!spell) this.fail(node, `Math.${method} over a run-time value`);
        return {
            k: "residual",
            cpp: spell(args.map((argument) => this.graph.numberCpp(argument))),
            shape: "number",
        };
    }

    private invoke(
        target: Val,
        args: Val[],
        node: ts.CallExpression,
        _file: ts.SourceFile,
        _env: Env,
        _module: string,
        thisValue: Val | undefined,
        name: string,
    ): Val {
        if (target.k === "closure") {
            const scope = new Env(target.env);
            target.node.parameters.forEach((parameter, index) => {
                this.bindPattern(parameter.name, args[index] ?? STATIC_UNDEFINED, scope, target.file, true);
            });
            const body = target.node.body;
            if (!ts.isBlock(body)) {
                return this.expression(body, scope, target.file, target.module, thisValue);
            }
            const completion = this.statements(body.statements, scope, target.file, target.module, thisValue, "inline");
            return completion.kind === "return" ? completion.value : STATIC_UNDEFINED;
        }
        if (target.k === "function") {
            const intercepted = this.intercept(target, args, node);
            if (intercepted) return intercepted;
            const scope = new Env(this.graph.moduleEnv(target.module));
            target.declaration.parameters.forEach((parameter, index) => {
                this.bindPattern(parameter.name, args[index] ?? STATIC_UNDEFINED, scope, target.file, true);
            });
            const completion = this.statements(
                target.declaration.body!.statements,
                scope,
                target.file,
                target.module,
                target.thisValue,
                "inline",
            );
            return completion.kind === "return" ? completion.value : STATIC_UNDEFINED;
        }
        // `unary(a, Math.abs)`: a Math member handed on as the callback.
        if (target.k === "opaque" && target.tag === "math" && typeof target.data === "string") {
            return this.mathCall(target.data, args, node);
        }
        if (target.k === "opaque" && target.tag === "string-ctor") {
            const [value] = args;
            if (value?.k === "static") return { k: "static", value: String(value.value) };
            return this.fail(node, "String over a run-time value");
        }
        if (target.k === "opaque" && target.tag === "number-ctor") {
            const [value] = args;
            if (value?.k === "static") return staticNumber(Number(value.value));
            return this.fail(node, "Number over a run-time value");
        }
        return this.fail(node, `call of ${name}`);
    }

    /**
     * The runtime plumbing, restated over the static graph. Each restated
     * body is asserted once against the pin (`FlowGraphLowerer.assertRuntime`).
     */
    private intercept(target: { declaration: ts.FunctionDeclaration | ts.MethodDeclaration; module: string }, args: Val[], node: ts.CallExpression): Val | undefined {
        const declared = target.declaration.name;
        const name = declared && ts.isIdentifier(declared) ? declared.text : undefined;
        if (target.module === RUNTIME_MODULE) {
            // `getDataValue(ctx, env, block, socket)` and
            // `activateSignal(ctx, env, block, socket)` take the block
            // third; `setDataValue(ctx, block, socket, value)` and
            // `getExecVar(ctx, block, key, def)` take it second.
            const block = this.blockArgument(
                name === "getDataValue" || name === "activateSignal" ? args[2] : args[1],
                node,
            );
            switch (name) {
                case "getDataValue": {
                    const socket = this.stringArgument(args[3], node);
                    return this.graph.pull(block, socket, this, this.emitter);
                }
                case "setDataValue": {
                    const socket = this.stringArgument(args[2], node);
                    this.graph.store(block, socket, args[3] ?? STATIC_UNDEFINED, this.emitter);
                    return STATIC_UNDEFINED;
                }
                case "activateSignal": {
                    const socket = this.stringArgument(args[3], node);
                    this.graph.push(block, socket, this.emitter);
                    return STATIC_UNDEFINED;
                }
                case "getExecVar": {
                    const key = this.stringArgument(args[2], node);
                    const ctx = args[0];
                    if (key !== "lastEvent" || ctx?.k !== "opaque" || ctx.tag !== "ctx") {
                        this.fail(node, `execution variable '${key}'`);
                    }
                    const payload = (ctx.data as { payload?: Val }).payload;
                    return payload ?? args[3] ?? STATIC_UNDEFINED;
                }
                default:
                    return this.fail(node, `runtime call ${name}`);
            }
        }
        if (target.module === POINTER_TEMPLATE_MODULE) {
            if (name === "resolveBlockPointer" || name === "resolveBlockAccessor") {
                const block = this.blockArgument(args[0], node);
                const config = block.config;
                if (typeof config.pointerTemplate === "string") {
                    this.fail(node, "pointer with a data-driven segment");
                }
                if (typeof config.accessor !== "string") return { k: "static", value: null };
                const accessor = this.graph.accessorFor(config.accessor);
                if (!accessor) return { k: "static", value: null };
                const accessorValue: Val = { k: "opaque", tag: "accessor", data: accessor };
                if (name === "resolveBlockAccessor") return accessorValue;
                return {
                    k: "record",
                    members: new Map<string, Val>([
                        ["pointer", { k: "static", value: accessor.pointer }],
                        ["accessor", accessorValue],
                    ]),
                };
            }
        }
        return undefined;
    }

    private blockArgument(value: Val | undefined, node: ts.Node): FlowGraphBlock {
        if (value?.k === "static" && typeof value.value === "object" && value.value !== null && "dataIn" in (value.value as object)) {
            return value.value as FlowGraphBlock;
        }
        return this.fail(node, "block argument");
    }

    private stringArgument(value: Val | undefined, node: ts.Node): string {
        if (value?.k === "static" && typeof value.value === "string") return value.value;
        return this.fail(node, "socket name");
    }

    /** A pinned function called by name, from outside a body. */
    public callPinned(module: string, name: string, args: Val[]): Val {
        const key = `${module}#${name}`;
        let pinned = this.pinnedCalls.get(key);
        if (!pinned) {
            const { file, declaration } = this.context.functionDeclaration(module, name);
            pinned = {
                target: { k: "function", declaration, file, module },
                site: ts.factory.createCallExpression(ts.factory.createIdentifier(name), undefined, []),
            };
            this.pinnedCalls.set(key, pinned);
        }
        return this.invoke(
            pinned.target,
            args,
            pinned.site,
            pinned.target.file,
            this.graph.moduleEnv(module),
            module,
            undefined,
            name,
        );
    }

    // ── Free names ────────────────────────────────────────────────────────

    private resolveFree(name: string, file: ts.SourceFile, module: string, site: ts.Node): Val {
        const env = this.graph.moduleEnv(module);
        const cached = env.lookup(name);
        if (cached) return cached.value;
        switch (name) {
            case "undefined":
                return STATIC_UNDEFINED;
            case "NaN":
                return staticNumber(Number.NaN);
            case "Infinity":
                return staticNumber(Number.POSITIVE_INFINITY);
            case "Math":
                return { k: "opaque", tag: "math" };
            case "String":
                return { k: "opaque", tag: "string-ctor" };
            case "Number":
                return { k: "opaque", tag: "number-ctor" };
            case "Array":
                return { k: "opaque", tag: "array-ctor" };
            default:
                break;
        }
        const constant = this.context.moduleScopeConstant(file, name);
        if (constant) {
            const value = this.expression(constant, env, file, module, undefined);
            env.declare(name, value);
            return value;
        }
        const declaration = file.statements.find(
            (statement): statement is ts.FunctionDeclaration =>
                ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body !== undefined,
        );
        if (declaration) {
            const value: Val = { k: "function", declaration, file, module };
            env.declare(name, value);
            return value;
        }
        const imported = this.context.moduleOfImport(module, name);
        if (imported) {
            const importedFile = this.context.sourceFile(imported);
            const value = this.resolveFree(name, importedFile, imported, site);
            env.declare(name, value);
            return value;
        }
        return this.context.contractError(
            site,
            `The flow-graph lowering cannot resolve '${name}'.`,
        );
    }
}

// ── The subsystem lowerer ────────────────────────────────────────────────────

interface BlockDefinition {
    type: string;
    module: string;
    file: ts.SourceFile;
    updateOutputs?: ts.MethodDeclaration;
    execute?: ts.MethodDeclaration;
}

/**
 * The block types this port lowers: the pin's own `FgBlockType` values the
 * calculator's graph reaches. Every other registered type -- the async
 * delays, animation and interpolation blocks, custom events, tick, the
 * editor-only forms -- refuses by name at `blockDefinition`.
 */
const ADMITTED_BLOCK_TYPES: ReadonlySet<string> = new Set([
    "SceneReadyEvent",
    "OnSelect",
    "Sequence",
    "GetVariable",
    "SetVariable",
    "GetProperty",
    "SetProperty",
    "Add",
    "Subtract",
    "Multiply",
    "Divide",
    "Modulo",
    "Abs",
    "Floor",
    "LessThan",
    "Clamp",
    "CombineVector2",
    "ExtractVector2",
]);

export class FlowGraphLowerer {
    private readonly definitions = new Map<string, BlockDefinition>();
    private registry?: Map<string, { module: string; exportName: string }>;

    public constructor(
        private readonly context: LoweringContext,
        private readonly assets: readonly FlowGraphAssetPrograms[],
    ) {}

    public lower(): LoweredSource {
        this.assertRuntime();
        const graphs: Array<{ asset: string; namespace: string; source: string }> = [];
        this.assets.forEach((asset, assetIndex) => {
            asset.graphs.forEach((program) => {
                const namespace = `flow_graph_${assetIndex}_${program.graphIndex}`;
                const lowering = new GraphLowering(this.context, this, program, namespace);
                graphs.push({ asset: asset.asset, namespace, source: lowering.lower() });
            });
        });
        return {
            modulePath: SCENE_MODULE,
            symbolName: "attachFlowGraph",
            header: this.header(),
            source: this.source(graphs),
        };
    }

    // ── Pinned tables ─────────────────────────────────────────────────────

    /** `getBlockDef`'s switch: block type to the module and export it imports. */
    private registryEntries(): Map<string, { module: string; exportName: string }> {
        if (this.registry) return this.registry;
        const { declaration } = this.context.functionDeclaration(REGISTRY_MODULE, "getBlockDef");
        const typeFile = this.context.sourceFile(BLOCK_TYPE_MODULE);
        const typeInitializer = this.context.moduleScopeConstant(typeFile, "FgBlockType");
        const typeTable = typeInitializer ? this.context.unwrapExpression(typeInitializer) : undefined;
        if (!typeTable || !ts.isObjectLiteralExpression(typeTable)) {
            this.context.contractError(typeFile, "FgBlockType is no longer an object literal.");
        }
        const types = new Map<string, string>();
        for (const property of typeTable.properties) {
            if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
                const value = this.context.unwrapExpression(property.initializer);
                if (ts.isStringLiteral(value)) types.set(property.name.text, value.text);
            }
        }
        const switchStatement = this.context.findNodes(declaration, ts.isSwitchStatement)[0];
        if (!switchStatement) this.context.contractError(declaration, "getBlockDef is no longer a switch.");
        const entries = new Map<string, { module: string; exportName: string }>();
        for (const clause of switchStatement.caseBlock.clauses) {
            if (!ts.isCaseClause(clause)) continue;
            const label = this.context.unwrapExpression(clause.expression);
            if (!ts.isPropertyAccessExpression(label) || !ts.isIdentifier(label.expression) || label.expression.text !== "FgBlockType") {
                this.context.contractError(clause, "A getBlockDef case is not an FgBlockType member.");
            }
            const type = types.get(label.name.text);
            if (!type) this.context.contractError(clause, `FgBlockType.${label.name.text} is not declared.`);
            // `async () => (await import("./x.js")).xDef`: the loader arm
            // wraps the awaited import in an arrow the block registry
            // calls on demand.
            const returned = clause.statements.find(ts.isReturnStatement);
            if (!returned) this.context.contractError(clause, "A getBlockDef arm does not return a loader.");
            entries.set(type, this.context.dynamicImportExport(REGISTRY_MODULE, returned));
        }
        this.registry = entries;
        return entries;
    }

    /** One block type's pinned definition record and its two methods. */
    public blockDefinition(type: string): BlockDefinition {
        const cached = this.definitions.get(type);
        if (cached) return cached;
        if (!ADMITTED_BLOCK_TYPES.has(type)) {
            throw new Error(
                `The flow-graph lowering does not lower the '${type}' block type; ` +
                    "the admitted set is the calculator's own.",
            );
        }
        const entry = this.registryEntries().get(type);
        if (!entry) throw new Error(`getBlockDef has no arm for block type '${type}'.`);
        const file = this.context.sourceFile(entry.module);
        const initializer = this.context.moduleScopeConstant(file, entry.exportName);
        if (!initializer || !ts.isObjectLiteralExpression(initializer)) {
            this.context.contractError(file, `Expected '${entry.exportName}' to be a block definition literal.`);
        }
        const method = (name: string): ts.MethodDeclaration | undefined => {
            const found = initializer.properties.find(
                (property): property is ts.MethodDeclaration =>
                    ts.isMethodDeclaration(property) && ts.isIdentifier(property.name) && property.name.text === name,
            );
            if (found && !found.body) this.context.contractError(found, `${entry.exportName}.${name} has no body.`);
            const assigned = initializer.properties.find(
                (property) => ts.isPropertyAssignment(property) && ts.isIdentifier(property.name) && property.name.text === name,
            );
            if (assigned) this.context.contractError(assigned, `${entry.exportName}.${name} is not a method declaration.`);
            return found;
        };
        const updateOutputs = method("updateOutputs");
        const execute = method("execute");
        const definition: BlockDefinition = {
            type,
            module: entry.module,
            file,
            ...(updateOutputs ? { updateOutputs } : {}),
            ...(execute ? { execute } : {}),
        };
        for (const name of ["onTick", "cancelPending"]) {
            if (initializer.properties.some((property) => property.name && ts.isIdentifier(property.name) && property.name.text === name)) {
                throw new Error(`Block type '${type}' declares ${name}; async blocks are not lowered.`);
            }
        }
        this.definitions.set(type, definition);
        return definition;
    }

    // ── Contracts over the restated runtime ───────────────────────────────

    /**
     * The pinned bodies this module restates rather than evaluates, each
     * asserted at the shapes the restatement depends on.
     */
    private assertRuntime(): void {
        const runtime = (name: string): ts.FunctionDeclaration =>
            this.context.functionDeclaration(RUNTIME_MODULE, name).declaration;
        const shape = (owner: ts.Node, expected: string, label: string, count = 1): void =>
            this.context.expectShapeCount(owner, expected, label, count);
        const pull = runtime("getDataValue");
        shape(pull, "block.dataIn.find((s) => s.name === socket)", "getDataValue socket lookup");
        shape(pull, "def?.updateOutputs?.(producer, ctx, env)", "getDataValue producer recompute");
        // Four default arms: guarded cycle, unwritten slot, missing
        // producer, unwired socket.
        shape(pull, "input.defaultValue ?? defaultForType(input.type)", "getDataValue default", 4);
        shape(pull, "raw *= input.source.scale", "getDataValue connected scale");
        shape(pull, "coerceValue(raw, input.type)", "getDataValue consumer coercion");
        shape(runtime("setDataValue"), "ctx.connectionValues[`${block.id}:${socket}`] = value", "setDataValue slot");
        const push = runtime("activateSignal");
        shape(push, "env.defs[targetBlock.type]?.execute?.(targetBlock, ctx, env, target.socket)", "activateSignal target execute");
        shape(push, "isFgEventTransitivePropagationStopped(env.events)", "activateSignal propagation stop", 2);
        shape(runtime("getExecVar"), "slot in ctx.executionVariables ? (ctx.executionVariables[slot] as T) : def", "getExecVar read");
        const lifecycle = runtime("pumpFlowGraphLifecycle");
        shape(lifecycle, "ctx.executionVariables[`${block.id}:lastEvent`] = eventPayload", "lifecycle payload");
        shape(lifecycle, "env.defs[block.type]?.execute?.(block, ctx, env, event)", "lifecycle execute");
        shape(runtime("fireFlowGraphStart"), `pumpFlowGraphLifecycle(rt, FgEventType.Start, { event: ${JSON.stringify(START_EVENT_REFERENCE)} })`, "start event reference");
        const startAll = runtime("startFlowGraphs");
        shape(startAll, "runtimes.filter(subscribeFlowGraph)", "startFlowGraphs subscribe-first");
        shape(startAll, "pendingStart.filter(isActive).forEach(fireFlowGraphStart)", "startFlowGraphs start-second");
        shape(runtime("pumpFlowGraphEvent"), "rt.started", "pumpFlowGraphEvent started guard");

        const coordinator = this.context.functionDeclaration(SCENE_MODULE, "ensureFlowGraphCoordinator").declaration;
        shape(coordinator, "scene._beforeRender.unshift(tick)", "coordinator tick registration");
        shape(coordinator, "scene._disposables.push(dispose)", "coordinator dispose registration");
        shape(coordinator, "startFlowGraphs(runtimes, isAttached)", "coordinator start");
        // The tick the native coordinator restates: snapshot, flush the
        // event buses, subscribe-then-start, then the tick and task pumps
        // per attached runtime. An arm added here has to be read.
        const tick = this.context.unwrapExpression(this.context.variableInitializer(coordinator, "tick"));
        if (!ts.isArrowFunction(tick) || !ts.isBlock(tick.body)) {
            this.context.contractError(coordinator, "The coordinator's tick is no longer an arrow function with a block body.");
        }
        this.context.assertStatementInventory(
            tick,
            tick.body.statements,
            "ensureFlowGraphCoordinator.tick",
            "the coordinator restates a body",
            [
                "variable statement",
                "variable statement",
                "expression statement",
                "variable statement",
                "expression statement",
                "for-of statement",
                "for-of statement",
            ],
            (statement) => (ts.isForOfStatement(statement) ? "for-of statement" : statementKind(statement)),
        );
        const attach = this.context.functionDeclaration(SCENE_MODULE, "attachFlowGraph").declaration;
        shape(attach, "scene._flowGraphPointerRefresh?.()", "attach pointer refresh");

        const bridge = this.context.functionDeclaration(POINTER_MODULE, "refreshFlowGraphPointerPicking").declaration;
        shape(bridge, "pointer.button === 0", "pointer press button");
        // The release is dropped when it comes from another pointer than
        // the press; native mouse events carry one pointer, so the arm is
        // asserted here and stated beside the bridge, not restated.
        shape(bridge, "start.pointerId !== pointer.pointerId", "pointer identity guard");
        shape(bridge, "Math.hypot(pointer.offsetX - start.x, pointer.offsetY - start.y) > 5", "pointer tap threshold");
        shape(bridge, "pickAsync(picker, pointer.offsetX, pointer.offsetY, { filter: (mesh) => isFlowGraphMeshSelectable(scene, mesh) })", "pointer pick");
        const selectable = this.context.functionDeclaration(POINTER_MODULE, "isFlowGraphMeshSelectable").declaration;
        shape(selectable, "runtimes.length > 0 && !runtimes.some((runtime) => runtime.env.accessors[selectablePointer]?.get() === false)", "mesh selectability");
        const dispatch = this.context.functionDeclaration(POINTER_MODULE, "dispatchFlowGraphPointerPick").declaration;
        shape(dispatch, `pumpFlowGraphEvent(runtime, FgEventType.Pointer, { nodeIndex, controllerIndex: 0, event: ${JSON.stringify(POINTER_EVENT_REFERENCE)} })`, "pointer dispatch payload");
        const forMesh = this.context.functionDeclaration(POINTER_MODULE, "runtimesForMesh").declaration;
        shape(forMesh, "runtime.env._assetScope === mesh._flowGraphAssetScope", "runtimes by asset scope");

        const materialMap = this.context.functionDeclaration(LOADER_MODULE, "buildMaterialMap").declaration;
        shape(materialMap, "mesh._gltfNodeIndex = ni", "mesh node index");
        shape(materialMap, "map[matIdx] = mesh.material", "material map");
        // container.flowGraphRuntimes: assigned by the feature's scene
        // setup per add, from runFlowGraphs' ordered attach-and-push.
        const applyAsset = this.context.methodDeclaration(LOADER_MODULE, "feature.applyAsset").declaration;
        shape(applyAsset, "container.flowGraphRuntimes = runtimes", "container runtimes assignment");
        const run = this.context.functionDeclaration(SCENE_MODULE, "runFlowGraphs").declaration;
        shape(run, "attachFlowGraph(scene, rt)", "run attach");
        shape(run, "runtimes.push(rt)", "run push");

        const uv = this.context.functionDeclaration(PATH_CONVERTER_MODULE, "resolveMaterialUvTransform").declaration;
        shape(uv, "{ x: tex?.uScale ?? 1, y: tex?.vScale ?? 1 }", "material scale read");
        shape(uv, "{ x: tex?.uOffset ?? 0, y: tex?.vOffset ?? 0 }", "material offset read");
        shape(uv, "resolved.writer(Float32Array.of(p.x, p.y), 0)", "material transform write");
        const visibility = this.context.functionDeclaration(PATH_CONVERTER_MODULE, "resolveVisibility").declaration;
        shape(visibility, "node.visible !== false", "visibility read");
        shape(visibility, "resolved.writer(Float32Array.of(v ? 1 : 0), 0)", "visibility write");
        const selectability = this.context.functionDeclaration(PATH_CONVERTER_MODULE, "resolveSelectability").declaration;
        shape(selectability, "selectable = !!v", "selectability write");
        const cascade = this.context.functionDeclaration(VISIBILITY_MODULE, "cascade").declaration;
        shape(cascade, "node.visible !== v", "visibility cascade change");
        shape(this.context.functionDeclaration(VISIBILITY_MODULE, "setSubtreeVisible").declaration, "bumpVisibilityEpoch()", "visibility epoch");
    }

    // ── Emission ──────────────────────────────────────────────────────────

    private header(): string {
        return `// ${this.context.provenance(RUNTIME_MODULE, "FgRuntime")}
#pragma once

#include <bblite/runtime.hpp>

#include <cstddef>
#include <memory>
#include <string>

namespace bbl {

/** The pointer channel payload: the picked glTF node and controller 0. */
struct FlowGraphPointerEvent {
    double node_index = 0.0;
    double controller_index = 0.0;
};

/** What a graph's accessors resolve against: the engine and its asset. */
struct FlowGraphHost {
    Engine& engine;
    AssetHandle asset;
};

/**
 * One attached graph (the pin's FgRuntime): its own state plus the drive
 * the scene coordinator and the pointer bridge call.
 */
struct FlowGraphRuntime {
    virtual ~FlowGraphRuntime() = default;
    /** subscribeFlowGraph ran: receivers are live, onStart fired once. */
    bool started = false;
    /** env._assetScope: the asset whose meshes this graph's picks name. */
    AssetHandle asset_scope{};
    virtual bool uses_pointer_event() const = 0;
    virtual void fire_start() = 0;
    virtual void pointer(const FlowGraphPointerEvent& payload) = 0;
    /** The KHR_node_selectability accessor's value, true where none exists. */
    virtual bool node_selectable(std::size_t node_index) const = 0;
};

} // namespace bbl
`;
    }

    private source(graphs: readonly { asset: string; namespace: string; source: string }[]): string {
        const assets = new Map<string, string[]>();
        for (const graph of graphs) {
            const list = assets.get(graph.asset) ?? [];
            list.push(graph.namespace);
            assets.set(graph.asset, list);
        }
        const table = [...assets].map(
            ([asset, namespaces]) =>
                `    {${JSON.stringify(asset)}, [](Scene& scene, AssetHandle asset) {\n${namespaces
                    .map(
                        (namespace) =>
                            `        attach_flow_graph(scene, std::make_shared<${namespace}::Runtime>(*scene.engine, asset));`,
                    )
                    .join("\n")}\n    }},`,
        );
        return `// ${this.context.provenance(SCENE_MODULE, "attachFlowGraph")}
// ${this.context.provenance(POINTER_MODULE, "enableFlowGraphPointerPicking")}
#include <bblite/upstream/flow_graph.hpp>
#include <bblite/pal.hpp>

#include <bblite/js_data.hpp>

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <memory>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>

namespace bbl {

namespace {

// The accessors a graph resolves against (\`gltf_node_visible\`,
// \`set_gltf_node_visible\`, \`gltf_base_color_transform\`) are the loader
// unit's, beside the node and material tables it fills.

// BBLITE_RUNTIME_TRACE, read the way the PAL reads it: the attach, each
// pick the bridge takes and each node it dispatches print a line, so an
// input replay can assert what a tap selected by name.
bool flow_graph_trace_enabled() {
    static const bool enabled = [] {
        const std::string text = pal::environment_variable("BBLITE_RUNTIME_TRACE");
        return !text.empty() && text != "0" && text != "false" && text != "off";
    }();
    return enabled;
}

${graphs.map((graph) => graph.source).join("\n\n")}

// ── The scene coordinator and the pointer bridge ─────────────────────────────

// runFlowGraphs: \`attachFlowGraph(scene, rt); runtimes.push(rt);\` -- the
// scene's list and the container's, one push each.
void attach_flow_graph(Scene& scene, std::shared_ptr<FlowGraphRuntime> runtime) {
    scene.engine->assets.at(runtime->asset_scope.value).flow_graph_runtimes.push_back(runtime);
    scene.state->flow_graphs.push_back(std::move(runtime));
}

struct FlowGraphAssetGraphs {
    const char* asset;
    void (*attach)(Scene&, AssetHandle);
};

// The graphs generation parsed, by the packaged asset the loader reads.
const FlowGraphAssetGraphs flow_graph_assets[] = {
${table.join("\n")}
};

struct FlowGraphPress {
    double x;
    double y;
};

// mesh._gltfNodeIndex and mesh._flowGraphAssetScope: the asset a mesh was
// loaded from and its node, through the loader's own node-then-primitive
// mesh order.
struct FlowGraphMeshNode {
    AssetHandle asset;
    std::size_t node;
};

std::optional<FlowGraphMeshNode> flow_graph_mesh_node(const Scene& scene, MeshHandle mesh) {
    for (const auto& runtime : scene.state->flow_graphs) {
        const AssetRecord& asset = scene.engine->assets.at(runtime->asset_scope.value);
        for (std::size_t index = 0; index < asset.meshes.size() && index < asset.mesh_nodes.size(); ++index) {
            if (asset.meshes[index] == mesh) {
                return FlowGraphMeshNode{runtime->asset_scope, asset.mesh_nodes[index]};
            }
        }
    }
    return std::nullopt;
}

// runtimesForMesh: the pointer-receiving graphs of the mesh's own asset,
// visited in place.
template <typename Visit>
void for_each_pointer_runtime(const Scene& scene, AssetHandle asset, const Visit& visit) {
    for (const auto& runtime : scene.state->flow_graphs) {
        if (runtime->uses_pointer_event() && runtime->asset_scope == asset) visit(*runtime);
    }
}

// ${this.context.provenance(POINTER_MODULE, "isFlowGraphMeshSelectable")}
bool is_flow_graph_mesh_selectable(const Scene& scene, const FlowGraphMeshNode& owner) {
    bool any = false;
    bool selectable = true;
    for_each_pointer_runtime(scene, owner.asset, [&](const FlowGraphRuntime& runtime) {
        any = true;
        if (!runtime.node_selectable(owner.node)) selectable = false;
    });
    return any && selectable;
}

// ${this.context.provenance(POINTER_MODULE, "dispatchFlowGraphPointerPick")}
void dispatch_flow_graph_pointer_pick(const Scene& scene, const PickingInfo& pick) {
    if (!pick.hit || pick.picked_kind != PickedNodeKind::mesh) return;
    const std::optional<FlowGraphMeshNode> owner = flow_graph_mesh_node(scene, picked_mesh(pick));
    if (!owner || !is_flow_graph_mesh_selectable(scene, *owner)) return;
    if (flow_graph_trace_enabled()) {
        std::fprintf(stderr, "[bblite trace] flow-graph pointer node=%zu\\n", owner->node);
    }
    for_each_pointer_runtime(scene, owner->asset, [&](FlowGraphRuntime& runtime) {
        // pumpFlowGraphEvent: a receiver that has not started yet is not live.
        if (runtime.started) runtime.pointer(FlowGraphPointerEvent{static_cast<double>(owner->node), 0.0});
    });
}

// ${this.context.provenance(POINTER_MODULE, "refreshFlowGraphPointerPicking")}
// The canvas listeners the pin installs once a pointer receiver is attached:
// a primary-button press records the point, a release within five pixels
// picks through the selectability filter and dispatches the hit. The pin's
// readback is a promise; here the pick is a wait on submitted work, so the
// cascade runs inside the release handler. The pin also drops a release
// from a pointer other than the pressing one; native mouse events carry
// one pointer, so the pair is always the same. A graph never detaches
// natively, so an installed bridge stays until the scene disposes and the
// pin's teardown-when-none-remains arm has no state to act on here.
void refresh_flow_graph_pointer_picking(Scene& scene) {
    SceneState& state = *scene.state;
    bool uses_pointer = false;
    for (const auto& runtime : state.flow_graphs) uses_pointer |= runtime->uses_pointer_event();
    if (!uses_pointer || state.flow_graph_pointer_cleanup) return;
    Engine& engine = *scene.engine;
    const GpuPickerHandle picker = create_gpu_picker(scene);
    const auto press = std::make_shared<std::optional<FlowGraphPress>>();
    const std::size_t identity = js::next_callback_identity();
    const std::weak_ptr<SceneState> weak = scene.state;
    on_mouse_down(engine, identity, [press](const PlatformMouseEvent& event) {
        if (event.button == 0.0) *press = FlowGraphPress{event.client_x, event.client_y};
    });
    on_mouse_up(engine, identity, [press, weak, picker](const PlatformMouseEvent& event) {
        const std::optional<FlowGraphPress> start = *press;
        press->reset();
        if (!start || js::hypot_js({event.client_x - start->x, event.client_y - start->y}) > 5.0) return;
        const std::shared_ptr<SceneState> shared = weak.lock();
        if (!shared || shared->disposed || !shared->engine) return;
        Scene picked = Scene::from_state(shared);
        const Engine::PickFilter filter = [&picked](MeshHandle mesh) {
            const std::optional<FlowGraphMeshNode> owner = flow_graph_mesh_node(picked, mesh);
            return owner && is_flow_graph_mesh_selectable(picked, *owner);
        };
        const PickingInfo pick = gpu_pick(*picked.engine, picker, event.client_x, event.client_y, filter);
        if (flow_graph_trace_enabled()) {
            std::fprintf(
                stderr,
                "[bblite trace] flow-graph pick x=%g y=%g hit=%d mesh=%d\\n",
                event.client_x,
                event.client_y,
                pick.hit ? 1 : 0,
                pick.hit && pick.picked_kind == PickedNodeKind::mesh ? 1 : 0);
        }
        dispatch_flow_graph_pointer_pick(picked, pick);
    });
    on_mouse_cancel(engine, identity, [press](const PlatformMouseEvent&) { press->reset(); });
    state.flow_graph_pointer_cleanup = [&engine, identity, picker]() {
        off_mouse_down(engine, identity);
        off_mouse_up(engine, identity);
        off_mouse_cancel(engine, identity);
        dispose_picker(engine, picker);
    };
}

// ${this.context.provenance(SCENE_MODULE, "ensureFlowGraphCoordinator")}
// The per-frame drive, registered ahead of every other before-render
// callback as the pin's unshift places it (\`on_before_render\`): the tick
// subscribes every runtime that has not started, then fires onStart for
// each -- startFlowGraphs's two loops. No admitted block receives the tick
// channel or registers a pending task, so the tick's event flush and its
// two later loops have nothing to run; and a graph never detaches
// natively, so the list is walked in place and the pin's isAttached
// re-check between the loops has nothing to see.
void ensure_flow_graph_coordinator(Scene& scene) {
    SceneState& state = *scene.state;
    if (state.flow_graph_coordinator) return;
    state.flow_graph_coordinator = true;
    const std::weak_ptr<SceneState> weak = scene.state;
    on_before_render(scene, js::Callback<void(float)>{[weak](float) {
        const std::shared_ptr<SceneState> shared = weak.lock();
        if (!shared || shared->disposed) return;
        std::vector<FlowGraphRuntime*> pending_start;
        for (const auto& runtime : shared->flow_graphs) {
            if (runtime->started) continue;
            runtime->started = true;
            pending_start.push_back(runtime.get());
        }
        for (FlowGraphRuntime* runtime : pending_start) runtime->fire_start();
    }});
    on_scene_dispose(scene, js::Callback<void()>{[weak]() {
        const std::shared_ptr<SceneState> shared = weak.lock();
        if (!shared) return;
        shared->flow_graphs.clear();
        if (shared->flow_graph_pointer_cleanup) {
            std::function<void()> cleanup = std::move(shared->flow_graph_pointer_cleanup);
            shared->flow_graph_pointer_cleanup = nullptr;
            cleanup();
        }
        shared->flow_graph_coordinator = false;
    }});
}

} // namespace

// ${this.context.provenance(LOADER_MODULE, "feature")}
// The container's _sceneSetup: runFlowGraphs over the graphs generation
// parsed for this asset, each attached to the scene it was added to.
void attach_flow_graphs(Scene& scene, AssetHandle asset, const std::string& asset_name) {
    if (!scene.engine) {
        throw std::runtime_error("KHR_interactivity graphs attach to a scene bound to an engine.");
    }
    for (const FlowGraphAssetGraphs& entry : flow_graph_assets) {
        if (asset_name != entry.asset) continue;
        // container.flowGraphRuntimes = runtimes: assigned per add.
        scene.engine->assets.at(asset.value).flow_graph_runtimes.clear();
        entry.attach(scene, asset);
        if (flow_graph_trace_enabled()) {
            std::fprintf(
                stderr,
                "[bblite trace] flow-graph attach asset=%s runtimes=%zu\\n",
                entry.asset,
                scene.engine->assets.at(asset.value).flow_graph_runtimes.size());
        }
        ensure_flow_graph_coordinator(scene);
        if (scene.state->flow_graph_pointer_refresh) refresh_flow_graph_pointer_picking(scene);
        return;
    }
    throw std::runtime_error("No flow graphs were generated for the asset " + asset_name + ".");
}

// ${this.context.provenance(POINTER_MODULE, "enableFlowGraphPointerPicking")}
void enable_flow_graph_pointer_picking(Scene& scene) {
    scene.state->flow_graph_pointer_refresh = true;
    refresh_flow_graph_pointer_picking(scene);
}

} // namespace bbl
`;
    }
}
