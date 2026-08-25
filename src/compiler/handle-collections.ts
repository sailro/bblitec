// The handle-collection concept: one value kind for "a collection of
// engine handles known at generation", and every operation the entry
// compiler performs over one.
//
// Before this module the semantics lived as exact-shape arms spread over
// expressions.ts (`scene.lights.push`, `set.systems.push`, the runtime
// `.find` loop), statements.ts (three for-of emitters plus the recursive
// imported-mesh walk proof) and compiler.ts (five iteration/index target
// resolvers). They are folded here: the resolvers, the loop frame, the
// pushes, the find, the walk proof and the new binding shapes all answer
// through one module, so the next collection shape extends the concept
// instead of becoming another sibling.
//
// What the concept adds beyond the fold:
//
// - `container.animationGroups ?? []` as a VALUE. The static-record `??`
//   rule generalizes to asset-derived collections: the materialized asset
//   decides presence, and either arm is the same native container — a
//   file with no animations leaves the loader's vector empty, which is
//   exactly the zero iterations `?? []` produces.
// - The collection travels: bound to a local or passed as a
//   `readonly T[]` parameter into an inlined user function, the binding
//   carries the collection value, and every operation resolves through
//   the same targets the inline property-read shapes already use — so
//   the bound spellings emit the identical loop.
// - `.find((c) => c.name === <static string>)` over an asset-derived
//   collection resolves at generation: the members are the materialized
//   document's own animations, named the way `createAnimationGroups`
//   names them, so a hit is that group's handle as a compile-time value
//   and a miss fails generation with the scene's own message. A find
//   whose name is not static, or over a collection with no
//   generation-known members, keeps the runtime loop.
// - Handle identity: `group === sadPose` lowers — folded when both sides
//   carry generation-known collection slots, compared by native `.value`
//   otherwise. Engine handles are creation-ordered indices, so equal
//   values name the same record.
import ts from "typescript";
import { readAssetBytesSync } from "./asset-bytes-sync.js";
import type { DataType } from "./data-types.js";
import { requireGroupSource } from "./intrinsics/animation.js";
import {
    nativeLocation,
    readHandleCollection,
} from "./properties.js";
import type {
    CompileAsset,
    CompiledNodeParticles,
    Value,
    ValueKind,
} from "./types.js";
import {
    asRecords,
    asString,
    glbJsonText,
    type JsonObject,
} from "../gltf-document.js";

/** One engine handle collection an expression names. */
export interface HandleCollectionTarget {
    property: string;
    temporaryLabel: string;
    containerCpp: string;
    elementKind: ValueKind;
    elementCppType: string;
    engineCpp: string;
}

/** What emitting a loop over one of those collections needs. */
export interface HandleCollectionLoopContext {
    allocateTemporaryCppName(label: string): string;
    allocateBlockPrefix(): string;
    emit(line: string): void;
    increaseIndent(): void;
    decreaseIndent(): void;
    pushScope(cppPrefix: string): void;
    popScope(): void;
    bindLocalValue(
        identifier: ts.Identifier,
        value: Value,
    ): void;
}

/**
 * The emitted range-for over an engine handle collection: the loop, its
 * scope, and the binding the body reads. Both the `for...of` lowering and
 * the `.find` search emit exactly this frame, so it is written once —
 * only the body differs.
 */
export function emitHandleCollectionLoop<
    Context extends HandleCollectionLoopContext,
>(
    context: Context,
    target: HandleCollectionTarget,
    binding: ts.Identifier,
    emitBody: (context: Context) => void,
): void {
    const item = context.allocateTemporaryCppName(
        target.temporaryLabel,
    );
    context.emit(
        `for (const ${target.elementCppType} ${item} : ${target.containerCpp}) {`,
    );
    context.increaseIndent();
    context.pushScope(context.allocateBlockPrefix());
    try {
        context.bindLocalValue(binding, {
            kind: target.elementKind,
            cpp: item,
            engineCpp: target.engineCpp,
        });
        emitBody(context);
    } finally {
        context.popScope();
        context.decreaseIndent();
    }
    context.emit("}");
}

/** What the collection operations need from the entry compiler. */
export interface HandleCollectionsContext
    extends HandleCollectionLoopContext {
    readonly checker: ts.TypeChecker;
    readonly dataTypes: {
        fromTsType(
            type: ts.Type,
            node: ts.Node,
        ): DataType | undefined;
        cppType(type: DataType): string;
    };
    readonly options: { fileName: string };
    readonly assetPayloads: ReadonlyMap<string, string>;
    readonly reachedNodeParticles: CompiledNodeParticles;
    unwrap(expression: ts.Expression): ts.Expression;
    fail(node: ts.Node, message: string): never;
    compileValue(expression: ts.Expression): Value;
    compileCondition(expression: ts.Expression): string;
    compileStringLiteral(expression: ts.Expression): string;
    cppString(value: string): string;
    lookup(identifier: ts.Identifier): Value;
    lookupOptional(
        identifier: ts.Identifier,
    ): Value | undefined;
    resolveStaticExpression(
        expression: ts.Expression,
    ): ts.Expression;
    probeStaticArrayLiteral(
        expression: ts.Expression,
    ): ts.ArrayLiteralExpression | undefined;
    requireEngine(value: Value, node: ts.Node): string;
    expectKind(
        value: Value,
        kind: ValueKind,
        node: ts.Node,
    ): void;
    expectSameEngine(
        left: Value,
        right: Value,
        node: ts.Node,
    ): void;
    expectArgumentCount(
        call: ts.CallExpression,
        minimum: number,
        maximum: number,
    ): void;
}

/** One member of an asset-derived collection, in document order. */
interface HandleCollectionMember {
    name: string;
    index: number;
}

export class HandleCollections {
    /** Members per asset source, decoded once per compile. */
    private readonly membersBySource = new Map<
        string,
        HandleCollectionMember[]
    >();

    public constructor(
        private readonly context: HandleCollectionsContext,
    ) {}

    /**
     * A collection expression past the two shapes that leave it
     * unchanged: `container.animationGroups ?? []` and `?.`.
     *
     * `AssetContainer.animationGroups` is optional upstream, so a scene
     * reading it writes one of those; both resolve to the container's own
     * collection, and an absent one is the empty vector the loader
     * already leaves behind — the same zero iterations `?? []` produces.
     */
    private unwrapCollectionExpression(
        expression: ts.Expression,
    ): ts.Expression {
        const unwrapped = this.context.unwrap(expression);
        if (
            ts.isBinaryExpression(unwrapped) &&
            unwrapped.operatorToken.kind ===
                ts.SyntaxKind.QuestionQuestionToken &&
            ts.isArrayLiteralExpression(unwrapped.right) &&
            unwrapped.right.elements.length === 0
        ) {
            return this.unwrapCollectionExpression(
                unwrapped.left,
            );
        }
        return unwrapped;
    }

    /**
     * The collection value an identifier is bound to, when it is one — a
     * local declared from `container.animationGroups ?? []`, or an inlined
     * user-function parameter the caller passed that local through.
     */
    private boundCollectionValue(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) {
            return undefined;
        }
        const value =
            this.context.lookupOptional(unwrapped);
        return value?.kind === "handle-collection" &&
            value.handleCollection
            ? value
            : undefined;
    }

    /**
     * The loop target of a collection expression, plus the owner it was
     * read from — which is what the `??` binding needs to know whether the
     * members are a materialized asset's.
     */
    private resolveExpressionTarget(
        expression: ts.Expression,
    ):
        | { target: HandleCollectionTarget; owner: Value }
        | undefined {
        const unwrapped =
            this.unwrapCollectionExpression(expression);
        if (!ts.isPropertyAccessExpression(unwrapped)) {
            return undefined;
        }
        const owner = this.context.compileValue(
            unwrapped.expression,
        );
        const collection = readHandleCollection(
            owner,
            unwrapped.name.text,
        );
        if (!collection) {
            return undefined;
        }
        // The declared type carries the element model: the property's own
        // number-index type is what an iteration yields, and the pinned
        // handle registry turns that type into the kind it binds as and the
        // C++ type the range-for declares. Neither is restated in the table.
        // A container's own collections are optional upstream
        // (`animationGroups?: AnimationGroup[]`), and a scene reads one
        // through `?? []` or `?.`; the element model is the same either
        // way, so the nullable half is dropped before the index lookup.
        const elementType = this.context.checker.getIndexTypeOfType(
            this.context.checker.getNonNullableType(
                this.context.checker.getTypeAtLocation(unwrapped),
            ),
            ts.IndexKind.Number,
        );
        if (!elementType) {
            this.context.fail(
                unwrapped,
                `'${unwrapped.name.text}' is not an indexable collection.`,
            );
        }
        const element = this.context.dataTypes.fromTsType(
            elementType,
            unwrapped,
        );
        if (element?.kind !== "handle") {
            this.context.fail(
                unwrapped,
                `Iterating '${unwrapped.name.text}' yields ` +
                    `${element?.kind ?? "an unmapped type"}, which carries ` +
                    "no engine handle to bind.",
            );
        }
        const engineCpp = this.context.requireEngine(
            owner,
            unwrapped,
        );
        return {
            target: {
                property: collection.property,
                temporaryLabel: collection.temporaryLabel,
                containerCpp: nativeLocation(
                    collection,
                    owner.cpp,
                    engineCpp,
                ),
                elementKind: element.handle,
                elementCppType:
                    this.context.dataTypes.cppType(element),
                engineCpp,
            },
            owner,
        };
    }

    /**
     * The loop target an expression names: a bound collection value, or a
     * property read (through `?? []`/`?.`) the collection table claims.
     * Undefined lets the caller fall through to the plain-data and
     * static-literal paths.
     */
    public iterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined {
        const bound = this.boundCollectionValue(expression);
        if (bound?.handleCollection) {
            const info = bound.handleCollection;
            return {
                property: info.property,
                temporaryLabel: info.temporaryLabel,
                containerCpp: info.containerCpp,
                elementKind: info.elementKind,
                elementCppType: info.elementCppType,
                engineCpp: info.engineCpp,
            };
        }
        return this.resolveExpressionTarget(expression)
            ?.target;
    }

    /**
     * `<lhs> ?? []` where the left operand is an engine handle collection:
     * the collection as a compile-time value.
     *
     * The materialized asset decides presence — a file whose loader
     * created groups yields the collection, one with no animations the
     * empty collection — and both are the same native container, so the
     * value is the collection either way and the member list carries the
     * difference. Returns undefined for every other `??`, which keeps the
     * static-record rule the sole owner of those.
     */
    public resolveNullishCollection(
        expression: ts.BinaryExpression,
    ): Value | undefined {
        const fallback = this.context.unwrap(
            expression.right,
        );
        if (
            expression.operatorToken.kind !==
                ts.SyntaxKind.QuestionQuestionToken ||
            !ts.isArrayLiteralExpression(fallback) ||
            fallback.elements.length !== 0
        ) {
            return undefined;
        }
        const resolved = this.resolveExpressionTarget(
            expression.left,
        );
        if (!resolved) {
            return undefined;
        }
        const { target, owner } = resolved;
        const asset =
            owner.kind === "asset" &&
            owner.asset?.kind === "gltf"
                ? owner.asset
                : undefined;
        return {
            kind: "handle-collection",
            cpp: "",
            engineCpp: target.engineCpp,
            handleCollection: {
                ...target,
                ...(asset ? { asset } : {}),
            },
        };
    }

    /**
     * `<container>.entities`, when the container is a glTF asset.
     *
     * The iteration folds to one body emission over the container itself.
     * That is not a claim about how many entities there are — `load-gltf`
     * seeds `[root]` and every loader feature appends its own, so a file
     * with punctual lights carries several — but about what the body can
     * do with one: an entity value is accepted by `addToScene` alone, and
     * adding each entity of a container adds exactly the meshes and lights
     * the loader created for it, which is what the emitted call does in
     * one step. A body reaching an entity any other way fails on the
     * value's kind.
     *
     * A `.babylon` container refuses: nothing reached iterates one, and
     * its entity list carries lights beside the roots, so the fold would
     * need its own proof.
     */
    public assetEntitiesIterationTarget(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (
            !ts.isPropertyAccessExpression(unwrapped) ||
            unwrapped.name.text !== "entities"
        ) {
            return undefined;
        }
        const owner = this.context.compileValue(
            unwrapped.expression,
        );
        if (owner.kind !== "asset") {
            return undefined;
        }
        if (owner.asset?.kind !== "gltf") {
            this.context.fail(
                unwrapped,
                "Iterating entities is lowered for a glTF container, whose entities are one root node; another container's roots are not.",
            );
        }
        return {
            ...owner,
            kind: "asset-entity",
            engineCpp: this.context.requireEngine(
                owner,
                unwrapped,
            ),
        };
    }

    /**
     * `<gltf container>.entities[0]`, the synthetic root transform the pin
     * creates before any loader feature appends further entities.
     *
     * Native loading resolves the root hierarchy into the asset's mesh
     * records rather than allocating a transform-node handle for that
     * synthetic wrapper. The value therefore stays an opaque asset-root
     * identity: later operations must prove how they act on the whole
     * imported hierarchy instead of mistaking the asset handle for a mesh.
     */
    public assetRootElementAccess(
        expression: ts.ElementAccessExpression,
    ): Value | undefined {
        const collection = this.context.unwrap(
            expression.expression,
        );
        if (
            !ts.isPropertyAccessExpression(collection) ||
            collection.name.text !== "entities"
        ) {
            return undefined;
        }
        const owner = this.context.compileValue(
            collection.expression,
        );
        if (owner.kind !== "asset") {
            return undefined;
        }
        if (owner.asset?.kind !== "gltf") {
            this.context.fail(
                collection,
                "Indexing entities is lowered for a glTF container, whose first entity is its synthetic root transform; another container's roots are not.",
            );
        }
        const index = this.context.compileValue(
            expression.argumentExpression,
        );
        if (
            index.kind !== "number" ||
            index.staticNumber !== 0
        ) {
            this.context.fail(
                expression.argumentExpression,
                "A glTF container's entities are indexed only at static index 0, which is its synthetic root transform.",
            );
        }
        return {
            ...owner,
            kind: "asset-root",
            engineCpp: this.context.requireEngine(
                owner,
                collection,
            ),
        };
    }

    /**
     * `<collection>[<index>]` over an engine handle collection —
     * `scene.meshes[0]` as a fallback after a missed find. Upstream
     * indexing past the end yields `undefined`; the value carries that as
     * its found flag (the same shape a loaded search returns), and the
     * emitted read is guarded so the miss never touches the vector.
     */
    public collectionElementAccess(
        expression: ts.ElementAccessExpression,
    ): Value | undefined {
        const target = this.iterationTarget(
            expression.expression,
        );
        if (!target) {
            return undefined;
        }
        const index = this.context.compileValue(
            expression.argumentExpression,
        );
        if (index.kind !== "number") {
            this.context.fail(
                expression.argumentExpression,
                `Indexing ${target.property} takes a number, received ${index.kind}.`,
            );
        }
        const slot = this.context.allocateTemporaryCppName(
            `${target.temporaryLabel}_index`,
        );
        const found = this.context.allocateTemporaryCppName(
            `${target.temporaryLabel}_present`,
        );
        const element = this.context.allocateTemporaryCppName(
            `${target.temporaryLabel}_at`,
        );
        this.context.emit(
            `const std::size_t ${slot} = static_cast<std::size_t>(${index.cpp});`,
        );
        this.context.emit(
            `const bool ${found} = ${slot} < ${target.containerCpp}.size();`,
        );
        this.context.emit(
            `const ${target.elementCppType} ${element} = ${found} ? ${target.containerCpp}[${slot}] : ${target.elementCppType}{};`,
        );
        return {
            kind: target.elementKind,
            cpp: element,
            engineCpp: target.engineCpp,
            optionalFoundCpp: found,
        };
    }

    /**
     * The flattened renderable descendants of an imported glTF root.
     * `StatementLowerer` admits this target only after proving the source is
     * the recursive TransformNode mesh-leaf visitor; arbitrary immediate
     * child iteration is deliberately not exposed as this collection.
     */
    public assetRootChildrenIterationTarget(
        expression: ts.Expression,
    ): HandleCollectionTarget | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (
            !ts.isPropertyAccessExpression(unwrapped) ||
            unwrapped.name.text !== "children"
        ) {
            return undefined;
        }
        const owner = this.context.compileValue(
            unwrapped.expression,
        );
        if (owner.kind !== "asset-root") {
            return undefined;
        }
        const engineCpp = this.context.requireEngine(
            owner,
            unwrapped,
        );
        return {
            property: "children",
            temporaryLabel: "asset_descendant_mesh",
            containerCpp:
                `${engineCpp}.assets[${owner.cpp}.value].meshes`,
            elementKind: "mesh",
            elementCppType: "bbl::MeshHandle",
            engineCpp,
        };
    }

    /**
     * The glTF animation groups a call names: a container's own
     * collection (bound or read inline), or a static array of groups the
     * scene selected — written inline or bound to a local, which the
     * compile-time tuple value carries.
     */
    public compileAnimationGroupList(
        expression: ts.Expression,
    ): { cpp: string; engineCpp: string } {
        const collection = this.iterationTarget(expression);
        if (collection) {
            if (collection.elementKind !== "animation-group") {
                this.context.fail(
                    expression,
                    `Expected animation groups, received ${collection.property}.`,
                );
            }
            return {
                cpp: collection.containerCpp,
                engineCpp: collection.engineCpp,
            };
        }
        const literal = this.context.probeStaticArrayLiteral(
            this.unwrapCollectionExpression(expression),
        );
        const groups = literal
            ? literal.elements.map((element) =>
                  this.context.compileValue(element),
              )
            : this.tupleElements(expression);
        if (!groups) {
            this.context.fail(
                expression,
                "Expected a container's animationGroups or a static array of groups.",
            );
        }
        for (const [index, value] of groups.entries()) {
            const element =
                literal?.elements[index] ?? expression;
            this.context.expectKind(
                value,
                "animation-group",
                element,
            );
            requireGroupSource(
                this.context,
                value,
                element,
                "addAnimationGroups",
                "gltf",
            );
        }
        const engineCpp = groups[0]
            ? this.context.requireEngine(
                  groups[0],
                  expression,
              )
            : this.context.fail(
                  expression,
                  "addAnimationGroups requires at least one group.",
              );
        return {
            cpp:
                `std::vector<bbl::AnimationGroupHandle>{` +
                `${groups.map((group) => group.cpp).join(", ")}}`,
            engineCpp,
        };
    }

    /**
     * The element values of an identifier bound to a compile-time tuple —
     * `const activeGroups = [idle, sadPose]` iterated or passed later. The
     * elements were compiled at the declaration, so what travels here is
     * the values, not the expressions.
     */
    public tupleElements(
        expression: ts.Expression,
    ): readonly Value[] | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) {
            return undefined;
        }
        const value =
            this.context.lookupOptional(unwrapped);
        return value?.kind === "tuple"
            ? value.tupleElements
            : undefined;
    }

    /**
     * `scene.lights.push(light)`, which is what `addToScene` does with one.
     *
     * The pin's own `addToScene` branches on the entity: a light takes
     * `ctx.lights.push(entity)` and then recurses into `entity.children`,
     * which a scene-code light has none of. So the two spellings are the same
     * call here, and a scene that writes the collection directly reaches the
     * lowering the intrinsic already has rather than a second one.
     */
    public compileSceneLightPush(
        call: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (
            callee.name.text !== "push" ||
            !ts.isPropertyAccessExpression(callee.expression) ||
            callee.expression.name.text !== "lights"
        ) {
            return undefined;
        }
        const scene = this.context.compileValue(
            callee.expression.expression,
        );
        if (scene.kind !== "scene") return undefined;
        this.context.expectArgumentCount(call, 1, 1);
        const light = this.context.compileValue(call.arguments[0]!);
        this.context.expectKind(light, "light", call.arguments[0]!);
        this.context.expectSameEngine(scene, light, call);
        return {
            kind: "void",
            cpp: `bbl::add_to_scene(${scene.cpp}, ${light.cpp})`,
        };
    }

    /**
     * `set.systems.push(other)`: one built set's systems composed into
     * another's, so a single registration renders both.
     *
     * `NodeParticleSet.systems` is a mutable array behind a readonly
     * property upstream, and the corpus uses exactly that to render a
     * Multiply system beside a MultiplyAdd one. It records a step rather
     * than emitting: the bake replays the push and reports which systems
     * the registration then walked, because the set's own count is the
     * graph's answer.
     */
    public compileParticleSystemsPush(
        call: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (
            callee.name.text !== "push" ||
            !ts.isPropertyAccessExpression(callee.expression) ||
            callee.expression.name.text !== "systems"
        ) {
            return undefined;
        }
        const set = this.context.compileValue(
            callee.expression.expression,
        );
        if (set.kind !== "node-particle-set") return undefined;
        this.context.expectArgumentCount(call, 1, 1);
        const system = this.context.compileValue(call.arguments[0]!);
        this.context.expectKind(
            system,
            "node-particle-system",
            call.arguments[0]!,
        );
        if (
            set.nodeParticleSetIndex === undefined ||
            system.nodeParticleSetIndex === undefined ||
            system.nodeParticleSystemIndex === undefined
        ) {
            this.context.fail(
                call,
                "A pushed particle system comes from a built set.",
            );
        }
        this.context.reachedNodeParticles.steps.push({
            op: "push-system",
            set: set.nodeParticleSetIndex,
            fromSet: system.nodeParticleSetIndex,
            fromSystem: system.nodeParticleSystemIndex,
        });
        return { kind: "void", cpp: "" };
    }

    /**
     * `<collection>.find(<arrow>)` over a collection of engine handles.
     *
     * Over an asset-derived collection value with a static name test, the
     * search resolves at generation: the members are the materialized
     * document's, a hit is that group's handle, and a miss fails
     * generation carrying the scene's own message. Every other reached
     * shape keeps the loaded search as a real loop: the predicate is the
     * caller's own expression with the element bound, and the result is
     * the handle plus whether one matched — which is what a scene tests
     * before using it, and what upstream's `undefined` return means.
     */
    public compileFind(
        call: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (callee.name.text !== "find") {
            return undefined;
        }
        const bound = this.boundCollectionValue(
            callee.expression,
        );
        const target = bound
            ? this.iterationTarget(callee.expression)
            : this.resolveExpressionTarget(callee.expression)
                  ?.target;
        if (!target) {
            return undefined;
        }
        this.context.expectArgumentCount(call, 1, 1);
        const predicate = this.context.unwrap(
            call.arguments[0]!,
        );
        if (
            !ts.isArrowFunction(predicate) ||
            predicate.parameters.length !== 1 ||
            !ts.isIdentifier(predicate.parameters[0]!.name) ||
            ts.isBlock(predicate.body)
        ) {
            this.context.fail(
                call.arguments[0] ?? call,
                "find takes an arrow whose one parameter is the element and whose body is the test.",
            );
        }
        const resolved =
            bound?.handleCollection?.asset !== undefined
                ? this.staticFind(
                      call,
                      bound.handleCollection.asset,
                      target,
                      predicate,
                  )
                : undefined;
        if (resolved) {
            return resolved;
        }
        return this.runtimeFind(target, predicate);
    }

    /** The emitted search loop — the pre-concept lowering, byte for byte. */
    private runtimeFind(
        target: HandleCollectionTarget,
        predicate: ts.ArrowFunction,
    ): Value {
        const result = this.context.allocateTemporaryCppName(
            `${target.temporaryLabel}_match`,
        );
        const found = this.context.allocateTemporaryCppName(
            `${target.temporaryLabel}_found`,
        );
        this.context.emit(
            `${target.elementCppType} ${result}{};`,
        );
        this.context.emit(`bool ${found} = false;`);
        emitHandleCollectionLoop(
            this.context,
            target,
            predicate.parameters[0]!.name as ts.Identifier,
            (context) => {
                const item = context.lookup(
                    predicate.parameters[0]!.name as ts.Identifier,
                ).cpp;
                const test = context.compileCondition(
                    predicate.body as ts.Expression,
                );
                context.emit(`if (${test}) {`);
                context.increaseIndent();
                context.emit(`${result} = ${item};`);
                context.emit(`${found} = true;`);
                context.emit("break;");
                context.decreaseIndent();
                context.emit("}");
            },
        );
        return {
            kind: target.elementKind,
            cpp: result,
            engineCpp: target.engineCpp,
            optionalFoundCpp: found,
        };
    }

    /**
     * A find resolved against the materialized asset. Serves exactly the
     * `(c) => c.name === <static string>` test; any other predicate keeps
     * the runtime loop by returning undefined.
     */
    private staticFind(
        call: ts.CallExpression,
        asset: CompileAsset,
        target: HandleCollectionTarget,
        predicate: ts.ArrowFunction,
    ): Value | undefined {
        // The members this resolution reads are the materialized
        // document's animations, so only the animationGroups collection
        // resolves here; any other collection (a container's cameras)
        // keeps the loaded search, whose member names the generated
        // loader itself wrote.
        if (target.property !== "animationGroups") {
            return undefined;
        }
        const body = this.context.unwrap(
            predicate.body as ts.Expression,
        );
        const parameter = (
            predicate.parameters[0]!.name as ts.Identifier
        ).text;
        if (
            !ts.isBinaryExpression(body) ||
            body.operatorToken.kind !==
                ts.SyntaxKind.EqualsEqualsEqualsToken
        ) {
            return undefined;
        }
        const left = this.context.unwrap(body.left);
        if (
            !ts.isPropertyAccessExpression(left) ||
            left.name.text !== "name" ||
            !ts.isIdentifier(
                this.context.unwrap(left.expression),
            ) ||
            (
                this.context.unwrap(
                    left.expression,
                ) as ts.Identifier
            ).text !== parameter
        ) {
            return undefined;
        }
        const name = this.staticStringProbe(body.right);
        if (name === undefined) {
            return undefined;
        }
        const members = this.collectionMembers(asset, call);
        const member = members.find(
            (candidate) => candidate.name === name,
        );
        if (!member) {
            this.context.fail(
                call,
                `${this.sceneMissMessage(call) ?? `Animation group '${name}' was not found`}` +
                    ` — the materialized asset '${asset.output}' declares ` +
                    `${
                        members.length === 0
                            ? "no animation groups"
                            : members
                                  .map(
                                      (candidate) =>
                                          `'${candidate.name}'`,
                                  )
                                  .join(", ")
                    }.`,
            );
        }
        return {
            kind: target.elementKind,
            cpp: `${target.containerCpp}[${member.index}]`,
            engineCpp: target.engineCpp,
            // Resolved at generation, so the scene's own not-found guard
            // reads a constant truth and its throw arm erases.
            optionalFoundCpp: "true",
            handleIdentity:
                `${asset.source}#${target.property}[${member.index}]`,
        };
    }

    /** A static string, or undefined — never a failure. */
    private staticStringProbe(
        expression: ts.Expression,
    ): string | undefined {
        const resolved = this.context.unwrap(
            this.context.resolveStaticExpression(expression),
        );
        if (
            ts.isStringLiteral(resolved) ||
            ts.isNoSubstitutionTemplateLiteral(resolved)
        ) {
            return resolved.text;
        }
        if (ts.isIdentifier(resolved)) {
            const value =
                this.context.lookupOptional(resolved);
            return value?.kind === "string"
                ? value.staticString
                : undefined;
        }
        return undefined;
    }

    /**
     * The scene's own message for a missed find: the first thrown
     * `new Error(...)` in the enclosing function whose message resolves
     * statically in the current scope — which is exactly the shape
     * `requireGroup` writes, its template over the bound name parameter.
     */
    private sceneMissMessage(
        call: ts.CallExpression,
    ): string | undefined {
        let owner: ts.Node | undefined = call.parent;
        while (owner && !ts.isFunctionLike(owner)) {
            owner = owner.parent;
        }
        if (!owner) return undefined;
        let message: string | undefined;
        const visit = (node: ts.Node): void => {
            if (message !== undefined) return;
            if (ts.isThrowStatement(node)) {
                const thrown = this.context.unwrap(
                    node.expression,
                );
                const argument =
                    ts.isNewExpression(thrown) &&
                    ts.isIdentifier(thrown.expression) &&
                    thrown.expression.text === "Error"
                        ? thrown.arguments?.[0]
                        : undefined;
                if (argument) {
                    try {
                        message =
                            this.context.compileStringLiteral(
                                argument,
                            );
                    } catch {
                        // Not static in this scope; keep looking.
                    }
                }
                return;
            }
            ts.forEachChild(node, visit);
        };
        visit(owner);
        return message;
    }

    /**
     * The asset's animation groups, named the way the pinned
     * `createAnimationGroups` names them: the document animation's own
     * `name`, or `animation_<index>` when it carries none. The generated
     * loader builds one clip per document animation in the same order, so
     * the index is the clip index on both sides.
     */
    private collectionMembers(
        asset: CompileAsset,
        node: ts.Node,
    ): HandleCollectionMember[] {
        const cached = this.membersBySource.get(asset.source);
        if (cached) return cached;
        const document = this.readAssetDocument(asset, node);
        const members = asRecords(document.animations).map(
            (animation, index): HandleCollectionMember => {
                const name = asString(animation.name);
                if (name === "") {
                    // The pin names an empty-string animation
                    // `animation_<index>` (`clip.name || ...`); the
                    // generated loader's absent-key default would keep
                    // the empty string. Refuse the unrepresented case
                    // instead of resolving names the runtime disagrees
                    // with.
                    this.context.fail(
                        node,
                        `Asset '${asset.output}' names animation ${index} with an empty string, which the pinned group naming and the generated loader resolve differently.`,
                    );
                }
                return {
                    name: name ?? `animation_${index}`,
                    index,
                };
            },
        );
        this.membersBySource.set(asset.source, members);
        return members;
    }

    /** The materialized document's JSON, from GLB or JSON glTF bytes. */
    private readAssetDocument(
        asset: CompileAsset,
        node: ts.Node,
    ): JsonObject {
        const inline = this.context.assetPayloads.get(
            asset.source,
        );
        let bytes: Uint8Array;
        try {
            bytes = readAssetBytesSync(
                inline ?? asset.source,
                this.context.options.fileName,
            );
        } catch (error) {
            this.context.fail(
                node,
                `Resolving this find needs the materialized asset '${asset.output}': ${
                    error instanceof Error
                        ? error.message
                        : String(error)
                }`,
            );
        }
        const buffer = Buffer.from(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
        );
        const text =
            glbJsonText(buffer) ?? buffer.toString("utf8");
        try {
            const parsed: unknown = JSON.parse(text);
            if (
                typeof parsed !== "object" ||
                parsed === null ||
                Array.isArray(parsed)
            ) {
                throw new Error("root is not an object");
            }
            return parsed as JsonObject;
        } catch (error) {
            this.context.fail(
                node,
                `Asset '${asset.output}' did not parse as a glTF document: ${
                    error instanceof Error
                        ? error.message
                        : String(error)
                }`,
            );
        }
    }

    /**
     * `a === b` / `a !== b` over two engine handles — upstream object
     * identity, which native handles carry as their creation-ordered
     * `.value`. Folded when both sides carry generation-known collection
     * slots; a native comparison otherwise. Undefined when either side is
     * not a bound handle, so numeric and data comparisons keep their own
     * lowerings.
     */
    public compileHandleEquality(
        expression: ts.BinaryExpression,
    ): string | undefined {
        const operator = expression.operatorToken.kind;
        if (
            operator !==
                ts.SyntaxKind.EqualsEqualsEqualsToken &&
            operator !==
                ts.SyntaxKind.ExclamationEqualsEqualsToken
        ) {
            return undefined;
        }
        const left = this.lookupHandleOperand(
            expression.left,
        );
        const right = this.lookupHandleOperand(
            expression.right,
        );
        if (!left || !right || left.kind !== right.kind) {
            return undefined;
        }
        this.context.expectSameEngine(
            left,
            right,
            expression,
        );
        const equals =
            operator === ts.SyntaxKind.EqualsEqualsEqualsToken;
        if (left.handleIdentity && right.handleIdentity) {
            const same =
                left.handleIdentity === right.handleIdentity;
            return same === equals ? "true" : "false";
        }
        return `(${left.cpp}.value ${equals ? "==" : "!="} ${right.cpp}.value)`;
    }

    /** An identifier bound to an engine handle, without emission. */
    private lookupHandleOperand(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (!ts.isIdentifier(unwrapped)) {
            return undefined;
        }
        const value =
            this.context.lookupOptional(unwrapped);
        if (!value) return undefined;
        const handleKinds: readonly ValueKind[] = [
            "animation-group",
            "camera",
            "light",
            "mesh",
        ];
        return handleKinds.includes(value.kind) &&
            value.animationGroupSource !== "property"
            ? value
            : undefined;
    }
}

/** A loop body's statements, whether or not it was written as a block. */
function walkBodyStatements(
    statement: ts.IterationStatement,
): readonly ts.Statement[] {
    return ts.isBlock(statement.statement)
        ? statement.statement.statements
        : [statement.statement];
}

/** Type-only wrappers do not change the object a hierarchy walk tests. */
function unwrapWalkExpression(
    expression: ts.Expression,
): ts.Expression {
    let current = expression;
    while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isTypeAssertionExpression(current) ||
        ts.isNonNullExpression(current) ||
        ts.isSatisfiesExpression(current)
    ) {
        current = current.expression;
    }
    return current;
}

function logicalAndOperands(
    expression: ts.Expression,
): ts.Expression[] {
    const current = unwrapWalkExpression(expression);
    if (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind ===
            ts.SyntaxKind.AmpersandAmpersandToken
    ) {
        return [
            ...logicalAndOperands(current.left),
            ...logicalAndOperands(current.right),
        ];
    }
    return [current];
}

function isPropertyPresenceProbe(
    expression: ts.Expression,
    binding: ts.Identifier,
    property: string,
): boolean {
    const current = unwrapWalkExpression(expression);
    const right = ts.isBinaryExpression(current)
        ? unwrapWalkExpression(current.right)
        : undefined;
    return (
        ts.isBinaryExpression(current) &&
        current.operatorToken.kind === ts.SyntaxKind.InKeyword &&
        ts.isStringLiteral(current.left) &&
        current.left.text === property &&
        !!right &&
        ts.isIdentifier(right) &&
        right.text === binding.text
    );
}

function singleExpressionStatement(
    statement: ts.Statement,
): ts.Expression | undefined {
    const statements = ts.isBlock(statement)
        ? statement.statements
        : [statement];
    return statements.length === 1 &&
        ts.isExpressionStatement(statements[0]!)
        ? statements[0]!.expression
        : undefined;
}

/**
 * Proves the exact Scene 12 hierarchy visitor that flattening preserves:
 * the function contains only this loop, the transform arm only recurses into
 * that function with the material parameter unchanged, and the mesh arm only
 * assigns that material. The assignment is order-independent, so the native
 * loader's flat mesh order need not claim to be the hierarchy's DFS order.
 */
export function isRecursiveImportedMeshWalk(
    statement: ts.ForOfStatement,
    binding: ts.Identifier,
): ts.BinaryExpression | undefined {
    const statements = walkBodyStatements(statement);
    if (
        statements.length !== 1 ||
        !ts.isIfStatement(statements[0]!) ||
        !statements[0]!.elseStatement
    ) {
        return undefined;
    }
    const branch = statements[0]!;
    const operands = logicalAndOperands(branch.expression);
    if (operands.length !== 3) {
        return undefined;
    }
    let children = false;
    let rotationQuaternion = false;
    let gpuNegated = false;
    for (const operand of operands) {
        if (isPropertyPresenceProbe(operand, binding, "children")) {
            children = true;
            continue;
        }
        if (
            isPropertyPresenceProbe(
                operand,
                binding,
                "rotationQuaternion",
            )
        ) {
            rotationQuaternion = true;
            continue;
        }
        const current = unwrapWalkExpression(operand);
        if (
            ts.isPrefixUnaryExpression(current) &&
            current.operator === ts.SyntaxKind.ExclamationToken &&
            isPropertyPresenceProbe(
                current.operand,
                binding,
                "_gpu",
            )
        ) {
            gpuNegated = true;
            continue;
        }
        return undefined;
    }
    if (!children || !rotationQuaternion || !gpuNegated) {
        return undefined;
    }

    let owner: ts.Node | undefined = statement.parent;
    while (owner && !ts.isFunctionLike(owner)) {
        owner = owner.parent;
    }
    if (
        !owner ||
        !ts.isFunctionDeclaration(owner) ||
        !owner.name ||
        !owner.body ||
        owner.body.statements.length !== 1 ||
        owner.body.statements[0] !== statement ||
        owner.parameters.length !== 2 ||
        owner.parameters.some(
            (parameter) => !ts.isIdentifier(parameter.name),
        )
    ) {
        return undefined;
    }
    const nodeParameter = owner.parameters[0]!.name as ts.Identifier;
    const materialParameter = owner.parameters[1]!.name as ts.Identifier;
    if (
        [binding, nodeParameter, materialParameter].some(
            (identifier) => identifier.text === owner.name!.text,
        )
    ) {
        return undefined;
    }
    const walked = unwrapWalkExpression(statement.expression);
    if (
        !ts.isPropertyAccessExpression(walked) ||
        walked.name.text !== "children" ||
        !ts.isIdentifier(unwrapWalkExpression(walked.expression)) ||
        (unwrapWalkExpression(walked.expression) as ts.Identifier).text !==
            nodeParameter.text
    ) {
        return undefined;
    }
    const recursive = singleExpressionStatement(
        branch.thenStatement,
    );
    if (
        !recursive ||
        !ts.isCallExpression(recursive) ||
        !ts.isIdentifier(recursive.expression) ||
        recursive.expression.text !== owner.name.text ||
        recursive.arguments.length !== owner.parameters.length
    ) {
        return undefined;
    }
    const first = unwrapWalkExpression(recursive.arguments[0]!);
    if (!ts.isIdentifier(first) || first.text !== binding.text) {
        return undefined;
    }
    const recursiveMaterial = unwrapWalkExpression(
        recursive.arguments[1]!,
    );
    if (
        !ts.isIdentifier(recursiveMaterial) ||
        recursiveMaterial.text !== materialParameter.text
    ) {
        return undefined;
    }
    const leaf = singleExpressionStatement(branch.elseStatement!);
    const assignment = leaf && unwrapWalkExpression(leaf);
    if (
        !assignment ||
        !ts.isBinaryExpression(assignment) ||
        assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken
    ) {
        return undefined;
    }
    const target = unwrapWalkExpression(assignment.left);
    const targetOwner = ts.isPropertyAccessExpression(target)
        ? unwrapWalkExpression(target.expression)
        : undefined;
    const material = unwrapWalkExpression(assignment.right);
    if (
        !ts.isPropertyAccessExpression(target) ||
        target.name.text !== "material" ||
        !targetOwner ||
        !ts.isIdentifier(targetOwner) ||
        targetOwner.text !== binding.text ||
        !ts.isIdentifier(material) ||
        material.text !== materialParameter.text
    ) {
        return undefined;
    }
    return assignment;
}
