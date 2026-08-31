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
    resolveFunctionDeclaration,
    unwrapExpression as unwrapWalkExpression,
} from "./user-functions.js";
import {
    isHandleCollectionProperty,
    nativeLocation,
    readHandleCollection,
} from "./properties.js";
import type {
    CompileAsset,
    HandleCollectionInfo,
    CompiledNodeParticles,
    LightKind,
    Value,
    ValueKind,
} from "./types.js";
import {
    asIndex,
    asRecords,
    asString,
    glbJsonText,
    type JsonObject,
} from "../gltf-document.js";

/**
 * One engine handle collection an expression names.
 *
 * This is the loop's half of `HandleCollectionInfo` — the same seven
 * members, because a bound collection value and a resolved loop target
 * describe the same collection. Naming it separately keeps the loop callers
 * reading as loop callers; restating the members would only let the two
 * drift.
 */
export type HandleCollectionTarget = HandleCollectionInfo;

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
    /**
     * Fields the caller licenses on the bound member, beyond the handle
     * itself. Only a caller that has PROVEN what its loop covers may add
     * one: the flatten walk carries the container it visits in full, and no
     * other collection can say that about its members.
     */
    extraBinding?: Partial<Value>,
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
            ...(extraBinding ?? {}),
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
    nextSceneLightIndex(kind?: LightKind): number;
}

/**
 * The value kinds that stand for an engine handle.
 *
 * A handle is a compile-time ordinal into one of the engine's own arrays, so
 * a list of them grows at generation and emits nothing. That is what makes a
 * compile-time tuple of them a list a consumer can read -- and what a tuple
 * of, say, numbers is not, because those would need native storage.
 */
const handleKinds: readonly ValueKind[] = [
    "animation-group",
    "camera",
    "light",
    "material",
    "mesh",
];

/**
 * The value kinds a compile-time list may hold.
 *
 * A handle is an ordinal, a record is its own lanes and a nested list is
 * this rule again: none of the three needs native storage of its own, so a
 * list of them grows at generation and emits nothing. A list of NUMBERS
 * would need storage, which is why it is not here -- the data model
 * materializes that one.
 */
const compileTimeListKinds: readonly ValueKind[] = [
    ...handleKinds,
    "record",
    "tuple",
];


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
        // Do not compile an arbitrary property's owner merely to discover
        // that the collection table never names the property. Besides being
        // needless work, that can claim an unrelated nested access before
        // its own lowering surface sees the complete path.
        if (!isHandleCollectionProperty(unwrapped.name.text)) {
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
            return bound.handleCollection;
        }
        return this.resolveExpressionTarget(expression)
            ?.target;
    }

    /**
     * `<walk>(container)` where `<walk>` flattens a container to its
     * renderables, as the asset's mesh collection — with the container it
     * flattened, which is what tells a caller the loop covers all of it.
     *
     * The pin exports the same flatten as `getContainerMeshes`, and a scene
     * that writes its own copy is asking for the same list. Answering with
     * the asset's materialized meshes is what keeps the entity hierarchy —
     * which native loading resolves away rather than allocating handles for
     * — out of the lowering. Without this the call inlines, and its body
     * refuses at `container.entities`, naming a tree that does not exist.
     */
    public assetFlattenedMeshesIterationTarget(
        expression: ts.Expression,
    ):
        | { target: HandleCollectionTarget; asset: CompileAsset }
        | undefined {
        const call = this.context.unwrap(expression);
        if (
            !ts.isCallExpression(call) ||
            call.arguments.length !== 1 ||
            !ts.isIdentifier(call.expression)
        ) {
            return undefined;
        }
        const declaration = resolveFunctionDeclaration(
            this.context.checker,
            call.expression,
            (node, message) => this.context.fail(node, message),
        );
        if (
            !declaration ||
            !ts.isFunctionDeclaration(declaration) ||
            !isImportedMeshFlattenWalk(declaration)
        ) {
            return undefined;
        }
        const owner = this.context.compileValue(
            call.arguments[0]!,
        );
        if (owner.kind !== "asset") {
            return undefined;
        }
        const collection = this.assetMeshCollection(owner, call)
            .handleCollection;
        if (!collection || !owner.asset) {
            return undefined;
        }
        return { target: collection, asset: owner.asset };
    }

    /** `getContainerMeshes(container)` as the asset's flattened mesh list. */
    public assetMeshCollection(
        owner: Value,
        expression: ts.Expression,
    ): Value {
        this.context.expectKind(owner, "asset", expression);
        const collection = readHandleCollection(owner, "meshes");
        if (!collection) {
            this.context.fail(
                expression,
                "The asset handle table does not expose its mesh collection.",
            );
        }
        const elementType = this.context.checker.getIndexTypeOfType(
            this.context.checker.getNonNullableType(
                this.context.checker.getTypeAtLocation(expression),
            ),
            ts.IndexKind.Number,
        );
        const element = elementType
            ? this.context.dataTypes.fromTsType(elementType, expression)
            : undefined;
        if (element?.kind !== "handle" || element.handle !== "mesh") {
            this.context.fail(
                expression,
                "getContainerMeshes must retain the pinned Mesh[] result type.",
            );
        }
        const engineCpp = this.context.requireEngine(owner, expression);
        return {
            kind: "handle-collection",
            cpp: "",
            engineCpp,
            handleCollection: {
                property: "meshes",
                temporaryLabel: collection.temporaryLabel,
                containerCpp: nativeLocation(
                    collection,
                    owner.cpp,
                    engineCpp,
                ),
                elementKind: element.handle,
                elementCppType: this.context.dataTypes.cppType(element),
                engineCpp,
                ...(owner.asset ? { asset: owner.asset } : {}),
            },
        };
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
        const value = ts.isIdentifier(unwrapped)
            ? this.context.lookupOptional(unwrapped)
            : ts.isCallExpression(unwrapped) ||
                ts.isPropertyAccessExpression(unwrapped) ||
                ts.isElementAccessExpression(unwrapped)
              ? this.context.compileValue(unwrapped)
              : undefined;
        return value?.kind === "tuple"
            ? value.tupleElements
            : value?.staticHandleElements;
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
        light.sceneLightIndex = this.context.nextSceneLightIndex(
            light.lightKind,
        );
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
     * `<local>.push(<handle>)` onto a compile-time tuple of engine handles.
     *
     * A scene builds its shadow-caster list that way — `const casters =
     * [sphere]`, then one push per box inside a loop generation unrolls —
     * so the final contents ARE a compile-time value, and the consumer
     * (`setShadowTaskCasterMeshes`) reads them as one. The push therefore
     * MOVES the tuple rather than emitting anything: the scope holds the
     * same Value object, so appending to its elements is what a later read
     * of the name sees.
     *
     * Only a tuple of engine handles takes this, and only one that already
     * holds at least one — a tuple's kind is what its elements are, and an
     * empty one names nothing. A list of plain data is the data model's own
     * array instead, which grows through `compileDataMethodCall` and emits
     * a real `push_back`; a mixed push fails naming both kinds, because a
     * consumer reading the tuple back would find two shapes in it.
     */
    public compileHandleTuplePush(
        call: ts.CallExpression,
        callee: ts.PropertyAccessExpression,
    ): Value | undefined {
        if (callee.name.text !== "push") return undefined;
        const owner = this.context.unwrap(callee.expression);
        if (!ts.isIdentifier(owner)) return undefined;
        const tuple = this.context.lookupOptional(owner);
        if (tuple?.kind !== "tuple" || !tuple.tupleElements) {
            return undefined;
        }
        // An EMPTY list has no element to take its shape from, so the first
        // push decides it. That is the shape a scene writes when it builds
        // a list in a loop -- `const paths: Vec3[][] = []` grown per path --
        // and the loop unrolls, so the list is complete at generation.
        const kind = tuple.tupleElements[0]?.kind;
        // A list that already holds something answers before compiling
        // anything: a data-model list of numbers is not this rule, and
        // compiling its argument here would compile it twice.
        if (kind !== undefined && !compileTimeListKinds.includes(kind)) {
            return undefined;
        }
        this.context.expectArgumentCount(call, 1, 1);
        const pushed = this.context.compileValue(call.arguments[0]!);
        if (!compileTimeListKinds.includes(pushed.kind)) return undefined;
        if (kind !== undefined && pushed.kind !== kind) {
            this.context.fail(
                call.arguments[0]!,
                `'${owner.text}' holds ${kind} values; pushing a ` +
                    `${pushed.kind} would leave two shapes in one list.`,
            );
        }
        tuple.tupleElements.push(pushed);
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
        const mapped = this.mappedMaterialFindSource(
            callee.expression,
        );
        const bound = this.boundCollectionValue(
            callee.expression,
        );
        const target = mapped?.target ?? (bound
            ? this.iterationTarget(callee.expression)
            : this.resolveExpressionTarget(callee.expression)
                  ?.target);
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
        if (mapped) {
            return this.runtimeMappedMaterialFind(
                target,
                mapped.selector,
                predicate,
            );
        }
        return this.runtimeFind(target, predicate);
    }

    /**
     * `scene.meshes.map((mesh) => mesh.material).find(...)` keeps one loaded
     * loop rather than materializing a second native array. The pin's `map`
     * produces references to the same material objects the meshes hold, so
     * binding the selector result directly into the `find` predicate is the
     * identical object-identity path with no intermediate storage.
     */
    private mappedMaterialFindSource(
        expression: ts.Expression,
    ):
        | {
              target: HandleCollectionTarget;
              selector: ts.ArrowFunction;
          }
        | undefined {
        const mapCall = this.context.unwrap(expression);
        if (
            !ts.isCallExpression(mapCall) ||
            !ts.isPropertyAccessExpression(mapCall.expression) ||
            mapCall.expression.name.text !== "map"
        ) {
            return undefined;
        }
        const target = this.iterationTarget(
            mapCall.expression.expression,
        );
        if (!target) return undefined;
        this.context.expectArgumentCount(mapCall, 1, 1);
        const selector = this.context.unwrap(
            mapCall.arguments[0]!,
        );
        if (
            !ts.isArrowFunction(selector) ||
            selector.parameters.length !== 1 ||
            !ts.isIdentifier(selector.parameters[0]!.name) ||
            ts.isBlock(selector.body)
        ) {
            this.context.fail(
                mapCall.arguments[0]!,
                "Mapped handle searches take an expression-bodied arrow with one element parameter.",
            );
        }
        return { target, selector };
    }

    /** The fused mesh-material projection and loaded material search. */
    private runtimeMappedMaterialFind(
        target: HandleCollectionTarget,
        selector: ts.ArrowFunction,
        predicate: ts.ArrowFunction,
    ): Value {
        const result = this.context.allocateTemporaryCppName(
            "material_match",
        );
        const found = this.context.allocateTemporaryCppName(
            "material_found",
        );
        this.context.emit(`bbl::MaterialHandle ${result}{};`);
        this.context.emit(`[[maybe_unused]] bool ${found} = false;`);
        let assetPbrMaterial = false;
        emitHandleCollectionLoop(
            this.context,
            target,
            selector.parameters[0]!.name as ts.Identifier,
            (context) => {
                const selected = context.compileValue(
                    selector.body as ts.Expression,
                );
                context.expectKind(
                    selected,
                    "material",
                    selector.body,
                );
                assetPbrMaterial = selected.assetPbrMaterial === true;
                if (selected.optionalFoundCpp) {
                    context.emit(`if (${selected.optionalFoundCpp}) {`);
                    context.increaseIndent();
                }
                context.bindLocalValue(
                    predicate.parameters[0]!.name as ts.Identifier,
                    selected,
                );
                const test = context.compileCondition(
                    predicate.body as ts.Expression,
                );
                context.emit(`if (${test}) {`);
                context.increaseIndent();
                context.emit(`${result} = ${selected.cpp};`);
                context.emit(`${found} = true;`);
                context.emit("break;");
                context.decreaseIndent();
                context.emit("}");
                if (selected.optionalFoundCpp) {
                    context.decreaseIndent();
                    context.emit("}");
                }
            },
        );
        return {
            kind: "material",
            cpp: result,
            engineCpp: target.engineCpp,
            optionalFoundCpp: found,
            ...(assetPbrMaterial
                ? { assetPbrMaterial: true as const }
                : {}),
        };
    }

    /**
     * The reached recursive `findNode(root, name)` walk over an imported
     * synthetic root. Native glTF loading has already flattened that root's
     * renderable descendants into AssetRecord::meshes, in traversal order,
     * so the DFS result is the first record whose flattened node wrapper or
     * renderable child has the requested name.
     */
    public compileAssetDescendantNameSearch(
        call: ts.CallExpression,
        callee: ts.Identifier,
    ): Value | undefined {
        if (callee.text !== "findNode" || call.arguments.length !== 2) {
            return undefined;
        }
        const root = this.context.compileValue(call.arguments[0]!);
        if (root.kind !== "asset-root") return undefined;
        const declaration = resolveFunctionDeclaration(
            this.context.checker,
            callee,
            (node, message) => this.context.fail(node, message),
        );
        if (
            !declaration ||
            !ts.isFunctionDeclaration(declaration) ||
            !isAssetDescendantNameSearch(declaration)
        ) {
            this.context.fail(
                callee,
                "findNode over a glTF root is lowered only for the exact depth-first helper that tests root.name, recurses through root.children, returns the first hit, and otherwise returns undefined.",
            );
        }
        const name = this.context.compileStringLiteral(call.arguments[1]!);
        if (!root.asset || root.asset.kind !== "gltf") {
            this.context.fail(
                call.arguments[0]!,
                "Asset descendant name search requires a materialized glTF root.",
            );
        }
        this.requireUniqueAssetDescendantMatch(root.asset, name, call);
        const engine = this.context.requireEngine(root, call);
        const result = this.context.allocateTemporaryCppName(
            "asset_descendant_match",
        );
        const found = this.context.allocateTemporaryCppName(
            "asset_descendant_found",
        );
        const item = this.context.allocateTemporaryCppName(
            "asset_descendant_mesh",
        );
        this.context.emit(`bbl::MeshHandle ${result}{};`);
        this.context.emit(`[[maybe_unused]] bool ${found} = false;`);
        this.context.emit(
            `for (const bbl::MeshHandle ${item} : ` +
                `${engine}.assets[${root.cpp}.value].meshes) {`,
        );
        this.context.increaseIndent();
        this.context.emit(
            `if (` +
                `${engine}.meshes[${item}.value].scene_node_name == ` +
                `${this.context.cppString(name)} || ` +
                `${engine}.meshes[${item}.value].name == ` +
                `${this.context.cppString(name)}) {`,
        );
        this.context.increaseIndent();
        this.context.emit(`${result} = ${item};`);
        this.context.emit(`${found} = true;`);
        this.context.emit("break;");
        this.context.decreaseIndent();
        this.context.emit("}");
        this.context.decreaseIndent();
        this.context.emit("}");
        return {
            kind: "mesh",
            cpp: result,
            engineCpp: engine,
            optionalFoundCpp: found,
        };
    }

    /**
     * Proves that the flattened native mesh table can stand for the DFS hit.
     * A transform-only node has no mesh handle, a multi-primitive node has
     * several, and two matching records do not prove which hierarchy branch
     * the source walk reaches first. All three therefore refuse before the
     * runtime loop is emitted.
     */
    private requireUniqueAssetDescendantMatch(
        asset: CompileAsset,
        name: string,
        node: ts.Node,
    ): void {
        const document = this.readAssetDocument(asset, node);
        const nodes = asRecords(document.nodes);
        const meshes = asRecords(document.meshes);
        let primitiveOrdinal = 0;
        let matches = 0;

        for (const [nodeIndex, gltfNode] of nodes.entries()) {
            const authoredNodeName = asString(gltfNode.name);
            const nodeName = authoredNodeName || `gltf_node_${nodeIndex}`;
            const meshIndex = asIndex(gltfNode.mesh);
            if (meshIndex === undefined) {
                if (nodeName === name) {
                    this.context.fail(
                        node,
                        `Asset '${asset.output}' has a geometry-less node named '${name}'; the flattened native mesh search cannot represent that DFS result.`,
                    );
                }
                continue;
            }

            const mesh = meshes[meshIndex];
            if (!mesh) {
                if (nodeName === name) {
                    this.context.fail(
                        node,
                        `Asset '${asset.output}' names '${name}' on node ${nodeIndex}, whose glTF mesh index ${meshIndex} is invalid.`,
                    );
                }
                continue;
            }
            const primitives = asRecords(mesh.primitives);
            const authoredMeshName = asString(mesh.name);
            const nodeMatches = nodeName === name;
            let thisNodeMatches = 0;
            for (let primitive = 0; primitive < primitives.length; primitive++) {
                const meshName =
                    authoredMeshName || `gltf_mesh_${primitiveOrdinal}`;
                if (nodeMatches || meshName === name) {
                    thisNodeMatches++;
                }
                primitiveOrdinal++;
            }
            if (
                (nodeMatches || authoredMeshName === name) &&
                primitives.length === 0
            ) {
                this.context.fail(
                    node,
                    `Asset '${asset.output}' names '${name}' on a node or mesh with no primitives; the flattened native mesh search cannot represent that DFS result.`,
                );
            }
            if (thisNodeMatches > 1) {
                this.context.fail(
                    node,
                    `Asset '${asset.output}' names '${name}' on a glTF node or mesh with ${thisNodeMatches} primitives; one SceneNode DFS result cannot be represented by several native mesh handles.`,
                );
            }
            matches += thisNodeMatches;
        }

        if (matches > 1) {
            this.context.fail(
                node,
                `Asset '${asset.output}' resolves '${name}' to ${matches} flattened mesh records; the source DFS's first hierarchy hit is not proven by the flat native table.`,
            );
        }
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
        // A caller may use the selected handle without testing the optional
        // result (for example, a scene whose asset contract guarantees the
        // named camera). The search still needs the flag for callers that do
        // test it and for optional composition, so keep it and make that
        // deliberate unused case warning-clean.
        this.context.emit(`[[maybe_unused]] bool ${found} = false;`);
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

    /**
     * A compile-time list of handles, however the scene spelled it.
     *
     * Two shapes, one meaning: an array literal at the call site, or a local
     * the scene grew with `push` inside a loop generation unrolls. Both
     * arrive as the same list; what differs is only where each element was
     * compiled, and therefore which node a refusal should blame. Undefined
     * when the expression is neither, so the caller keeps its own message.
     */
    public staticHandleList(
        expression: ts.Expression,
    ): readonly { value: Value; node: ts.Node }[] | undefined {
        const literal =
            this.context.probeStaticArrayLiteral(expression);
        if (literal) {
            const entries: { value: Value; node: ts.Node }[] = [];
            for (const element of literal.elements) {
                if (ts.isSpreadElement(element)) {
                    const spread = this.tupleElements(element.expression);
                    if (!spread) return undefined;
                    entries.push(
                        ...spread.map((value) => ({ value, node: element })),
                    );
                } else {
                    entries.push({
                        value: this.context.compileValue(element),
                        node: element,
                    });
                }
            }
            return entries;
        }
        const tuple = this.tupleElements(expression);
        return tuple?.map((value) => ({ value, node: expression }));
    }

    /** An identifier bound to an engine handle, without emission. */
    private lookupHandleOperand(
        expression: ts.Expression,
    ): Value | undefined {
        const unwrapped = this.context.unwrap(expression);
        if (ts.isIdentifier(unwrapped)) {
            const value =
                this.context.lookupOptional(unwrapped);
            if (value) {
                return handleKinds.includes(value.kind) &&
                    value.animationGroupSource !== "property"
                    ? value
                    : undefined;
            }
        }
        const type = this.context.dataTypes.fromTsType(
            this.context.checker.getTypeAtLocation(unwrapped),
            unwrapped,
        );
        if (
            type?.kind !== "handle" ||
            !handleKinds.includes(type.handle)
        ) {
            return undefined;
        }
        const value = this.context.compileValue(unwrapped);
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

/** A block-wrapped or bare `return <expression>` arm. */
function singleReturnExpression(
    statement: ts.Statement,
): ts.Expression | undefined {
    const statements = ts.isBlock(statement)
        ? statement.statements
        : [statement];
    return statements.length === 1 &&
        ts.isReturnStatement(statements[0]!)
        ? statements[0]!.expression
        : undefined;
}

/**
 * Proves Scene 269's recursive first-hit DFS exactly:
 *
 *     if (root.name === name) return root;
 *     for (const child of root.children) {
 *         const hit = findNode(child, name);
 *         if (hit) return hit;
 *     }
 *     return undefined;
 *
 * The native representation has no hierarchy node for imported transforms,
 * so only this closed walk may be replaced by a search of the materialized
 * flat mesh table. Any extra predicate, side effect, traversal order, or
 * fallback remains an ordinary user function and is deliberately refused at
 * the asset-root call site.
 */
function isAssetDescendantNameSearch(
    declaration: ts.FunctionDeclaration,
): boolean {
    if (
        !declaration.name ||
        !declaration.body ||
        declaration.asteriskToken ||
        declaration.modifiers?.some(
            (modifier) =>
                modifier.kind === ts.SyntaxKind.AsyncKeyword,
        ) ||
        declaration.typeParameters?.length ||
        declaration.parameters.length !== 2 ||
        declaration.parameters.some(
            (parameter) =>
                !ts.isIdentifier(parameter.name) ||
                !!parameter.dotDotDotToken ||
                !!parameter.initializer ||
                !!parameter.questionToken,
        ) ||
        declaration.body.statements.length !== 3
    ) {
        return false;
    }
    const root = declaration.parameters[0]!.name as ts.Identifier;
    const name = declaration.parameters[1]!.name as ts.Identifier;
    if (
        new Set([
            declaration.name.text,
            root.text,
            name.text,
            "undefined",
        ]).size !== 4
    ) {
        return false;
    }
    const [selfArm, walk, miss] = declaration.body.statements;

    if (
        !ts.isIfStatement(selfArm!) ||
        !!selfArm.elseStatement
    ) {
        return false;
    }
    const selfTest = unwrapWalkExpression(selfArm.expression);
    if (
        !ts.isBinaryExpression(selfTest) ||
        selfTest.operatorToken.kind !==
            ts.SyntaxKind.EqualsEqualsEqualsToken ||
        !isPropertyReadOf(selfTest.left, root, "name") ||
        !isIdentifierRead(selfTest.right, name) ||
        !isIdentifierRead(
            singleReturnExpression(selfArm.thenStatement),
            root,
        )
    ) {
        return false;
    }

    if (
        !ts.isForOfStatement(walk!) ||
        !ts.isVariableDeclarationList(walk.initializer) ||
        (walk.initializer.flags & ts.NodeFlags.Const) === 0 ||
        walk.initializer.declarations.length !== 1 ||
        !isPropertyReadOf(walk.expression, root, "children")
    ) {
        return false;
    }
    const childDeclaration = walk.initializer.declarations[0]!;
    if (
        !ts.isIdentifier(childDeclaration.name) ||
        childDeclaration.initializer
    ) {
        return false;
    }
    const child = childDeclaration.name;
    if (
        [declaration.name, root, name].some(
            (identifier) => identifier.text === child.text,
        ) ||
        child.text === "undefined"
    ) {
        return false;
    }
    const loopStatements = walkBodyStatements(walk);
    if (loopStatements.length !== 2) return false;

    const hit = singleConstDeclaration(loopStatements[0]!);
    if (
        !hit ||
        !ts.isVariableStatement(loopStatements[0]!) ||
        (loopStatements[0]!.declarationList.flags &
            ts.NodeFlags.Const) ===
            0
    ) {
        return false;
    }
    if (
        [declaration.name, root, name, child].some(
            (identifier) => identifier.text === hit.name.text,
        ) ||
        hit.name.text === "undefined"
    ) {
        return false;
    }
    const recursive = unwrapWalkExpression(hit.initializer);
    if (
        !ts.isCallExpression(recursive) ||
        recursive.arguments.length !== 2 ||
        !isIdentifierRead(recursive.expression, declaration.name) ||
        !isIdentifierRead(recursive.arguments[0], child) ||
        !isIdentifierRead(recursive.arguments[1], name)
    ) {
        return false;
    }

    const hitArm = loopStatements[1];
    if (
        !hitArm ||
        !ts.isIfStatement(hitArm) ||
        !!hitArm.elseStatement ||
        !isIdentifierRead(hitArm.expression, hit.name) ||
        !isIdentifierRead(
            singleReturnExpression(hitArm.thenStatement),
            hit.name,
        )
    ) {
        return false;
    }

    if (!ts.isReturnStatement(miss!) || !miss.expression) {
        return false;
    }
    const missValue = unwrapWalkExpression(miss.expression);
    return (
        missValue.kind === ts.SyntaxKind.NullKeyword ||
        (ts.isIdentifier(missValue) && missValue.text === "undefined")
    );
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
    if (
        !isPropertyReadOf(
            statement.expression,
            nodeParameter,
            "children",
        )
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
    if (
        !isPropertyReadOf(assignment.left, binding, "material") ||
        !isIdentifierRead(assignment.right, materialParameter)
    ) {
        return undefined;
    }
    return assignment;
}

/** Whether an expression reads the binding `name`, through any wrapper. */
function isIdentifierRead(
    expression: ts.Expression | undefined,
    name: ts.Identifier,
): boolean {
    const current = expression && unwrapWalkExpression(expression);
    return (
        !!current &&
        ts.isIdentifier(current) &&
        current.text === name.text
    );
}

/** Whether an expression is the read `<name>.<property>`. */
function isPropertyReadOf(
    expression: ts.Expression,
    name: ts.Identifier,
    property: string,
): boolean {
    const current = unwrapWalkExpression(expression);
    return (
        ts.isPropertyAccessExpression(current) &&
        current.name.text === property &&
        isIdentifierRead(current.expression, name)
    );
}

/** A `const <name> = <initializer>;` statement, as its two halves. */
function singleConstDeclaration(
    statement: ts.Statement,
):
    | { name: ts.Identifier; initializer: ts.Expression }
    | undefined {
    if (
        !ts.isVariableStatement(statement) ||
        statement.declarationList.declarations.length !== 1
    ) {
        return undefined;
    }
    const declaration =
        statement.declarationList.declarations[0]!;
    return ts.isIdentifier(declaration.name) &&
        declaration.initializer
        ? {
              name: declaration.name,
              initializer: declaration.initializer,
          }
        : undefined;
}

/**
 * The single argument of `<collection>.push(...)`, when the call spreads
 * or does not spread it as asked.
 */
function pushedArgument(
    expression: ts.Expression | undefined,
    collection: ts.Identifier,
    spread: boolean,
): ts.Expression | undefined {
    const current =
        expression && unwrapWalkExpression(expression);
    if (
        !current ||
        !ts.isCallExpression(current) ||
        current.arguments.length !== 1 ||
        !isPropertyReadOf(current.expression, collection, "push")
    ) {
        return undefined;
    }
    const argument = current.arguments[0]!;
    if (ts.isSpreadElement(argument) !== spread) {
        return undefined;
    }
    return unwrapWalkExpression(
        ts.isSpreadElement(argument)
            ? argument.expression
            : argument,
    );
}

/** The `if (<test>) <body>` one walk arm is, with no `else`. */
function guardedArm(
    statement: ts.Statement,
): { test: ts.Expression; body: ts.Statement } | undefined {
    return ts.isIfStatement(statement) && !statement.elseStatement
        ? {
              test: statement.expression,
              body: statement.thenStatement,
          }
        : undefined;
}

/** Whether a statement is `continue;`, block-wrapped or bare. */
function isContinueArm(statement: ts.Statement): boolean {
    return ts.isBlock(statement)
        ? statement.statements.length === 1 &&
              ts.isContinueStatement(statement.statements[0]!)
        : ts.isContinueStatement(statement);
}

/**
 * `<node>.children?.length`, the descent guard the walk tests. The `?.`
 * binds to the `length` read, not to `children`, so the optional token
 * sits on the outer access and the inner one is a plain read.
 */
function isOptionalChildrenLength(
    expression: ts.Expression,
    node: ts.Identifier,
): boolean {
    const current = unwrapWalkExpression(expression);
    if (
        !ts.isPropertyAccessExpression(current) ||
        current.name.text !== "length" ||
        !current.questionDotToken
    ) {
        return false;
    }
    return isPropertyReadOf(current.expression, node, "children");
}

/**
 * Proves the worklist spelling of a container flatten: a stack seeded from
 * the container's entities, an arm collecting the nodes carrying renderable
 * fields, and an arm pushing their children.
 *
 * The pin ships the same flatten as `getContainerMeshes`, and the generated
 * loader has already performed it into `AssetRecord::meshes`. What is proven
 * here is not that this walk IS the pin's — it is not, quite: the pin tests
 * `_gpu` for truth where this tests both renderable fields for presence, and
 * keeps a `seen` set this has no need of. What is proven is that the walk
 * reaches every node under the container's entities and collects exactly the
 * ones the loader made mesh records for.
 *
 * Nor is the walk's ORDER proven: a worklist pops from the end, so it reaches
 * siblings in the reverse of the loader's document order. As for the
 * recursive visitor above, that is left unclaimed, and the caller refuses the
 * constructs that would observe it.
 */
function isImportedMeshFlattenWalk(
    declaration: ts.FunctionDeclaration,
): boolean {
    if (
        !declaration.body ||
        declaration.parameters.length !== 1 ||
        !ts.isIdentifier(declaration.parameters[0]!.name) ||
        declaration.body.statements.length !== 4
    ) {
        return false;
    }
    const container = declaration.parameters[0]!.name as ts.Identifier;
    const [collected, worklist, loop, returned] =
        declaration.body.statements;

    // `const meshes: Mesh[] = []` — the result, empty before the walk.
    const result = singleConstDeclaration(collected!);
    if (!result) return false;
    const empty = unwrapWalkExpression(result.initializer);
    if (
        !ts.isArrayLiteralExpression(empty) ||
        empty.elements.length !== 0
    ) {
        return false;
    }

    // `const stack = [...container.entities]` — seeded from every root, so
    // the walk covers the whole container and not one entity's subtree.
    const stack = singleConstDeclaration(worklist!);
    if (!stack) return false;
    const seed = unwrapWalkExpression(stack.initializer);
    if (
        !ts.isArrayLiteralExpression(seed) ||
        seed.elements.length !== 1 ||
        !ts.isSpreadElement(seed.elements[0]!) ||
        !isPropertyReadOf(
            seed.elements[0]!.expression,
            container,
            "entities",
        )
    ) {
        return false;
    }

    // `while (stack.length > 0)` — drained, so no reachable node is left.
    if (!ts.isWhileStatement(loop!)) return false;
    const test = unwrapWalkExpression(loop.expression);
    if (
        !ts.isBinaryExpression(test) ||
        test.operatorToken.kind !== ts.SyntaxKind.GreaterThanToken ||
        !isPropertyReadOf(test.left, stack.name, "length")
    ) {
        return false;
    }
    const bound = unwrapWalkExpression(test.right);
    if (!ts.isNumericLiteral(bound) || bound.text !== "0") {
        return false;
    }

    // `return meshes` — the collected list, unfiltered and unsorted.
    if (
        !ts.isReturnStatement(returned!) ||
        !isIdentifierRead(returned.expression, result.name)
    ) {
        return false;
    }

    const body = walkBodyStatements(loop);
    if (body.length !== 4) return false;

    // `const node = stack.pop()` — the worklist is consumed, never re-read.
    const popped = singleConstDeclaration(body[0]!);
    if (!popped) return false;
    const pop = unwrapWalkExpression(popped.initializer);
    if (
        !ts.isCallExpression(pop) ||
        pop.arguments.length !== 0 ||
        !isPropertyReadOf(pop.expression, stack.name, "pop")
    ) {
        return false;
    }
    const node = popped.name;

    // `if (!node) { continue; }` — the hole a `pop()` past the end would
    // yield, skipped rather than collected.
    const emptyArm = guardedArm(body[1]!);
    if (!emptyArm || !isContinueArm(emptyArm.body)) return false;
    const emptyTest = unwrapWalkExpression(emptyArm.test);
    if (
        !ts.isPrefixUnaryExpression(emptyTest) ||
        emptyTest.operator !== ts.SyntaxKind.ExclamationToken ||
        !isIdentifierRead(emptyTest.operand, node)
    ) {
        return false;
    }

    // `if ("_gpu" in node && "material" in node) meshes.push(node)` — the
    // renderable test. A loaded mesh carries both fields and a transform
    // node carries neither, so this selects the loader's mesh records.
    const collectArm = guardedArm(body[2]!);
    if (!collectArm) return false;
    const probes = logicalAndOperands(collectArm.test);
    if (
        probes.length !== 2 ||
        !probes.some((probe) =>
            isPropertyPresenceProbe(probe, node, "_gpu"),
        ) ||
        !probes.some((probe) =>
            isPropertyPresenceProbe(probe, node, "material"),
        ) ||
        !isIdentifierRead(
            pushedArgument(
                singleExpressionStatement(collectArm.body),
                result.name,
                false,
            ),
            node,
        )
    ) {
        return false;
    }

    // `if (node.children?.length) stack.push(...node.children)` — the
    // descent, through the same property the pin's visitor recurses.
    const descendArm = guardedArm(body[3]!);
    if (!descendArm || !isOptionalChildrenLength(descendArm.test, node)) {
        return false;
    }
    const descend = pushedArgument(
        singleExpressionStatement(descendArm.body),
        stack.name,
        true,
    );
    return !!descend && isPropertyReadOf(descend, node, "children");
}
