import type { PinnedCallSpelling } from "./pinned-numeric-lowerer.js";
/**
 * The navigation JavaScript that runs over library data, lowered from the
 * installed @recast-navigation packages and the pinned module.
 *
 * Three bodies walk or rewrite Recast/Detour objects, and land in
 * `bblite/upstream/navigation_library.hpp` as function templates the Recast
 * PAL instantiates over its own library objects:
 *
 * - core's `getNavMeshPositionsAndIndices`, the detail-mesh walk;
 * - `generateSoloNavMeshData`'s poly area/flag normalization;
 * - `createDefaultTileCacheMeshProcess`'s per-tile process.
 *
 * A wrapper method is read from its class in the core package and spelled
 * as what it does to the object it wraps -- a field read, an element read
 * or store, a raw method call, or a view of another raw object. The wrapper's
 * raw object IS the library struct, so that spelling is the library's own
 * API; the generated code names no library type, and the PAL supplies them.
 *
 * `createDebugNavMeshGeometry`, the pinned module's rebuild over the walk's
 * arrays, lowers into the navigation unit beside the rest of the module.
 */
import ts from "typescript";
import {
    contractError,
    findNodes,
    sharedPinnedContext,
    unwrapExpression,
    variableInitializer,
    type LoweringContext,
} from "./context.js";
import {
    blockArrow,
    declarationOf,
    WRAPPER_CORE,
    WRAPPER_GENERATORS,
    wrapperModule,
    methodAccess,
    provenance,
    type RawAccess,
    type RawSource,
} from "./navigation-wrappers.js";
import { pinnedHeader } from "./pinned-header.js";
import { isPinnedErrorCall, pinnedErrorMessage } from "./pinned-error.js";
import {
    absentBinding,
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";

import { MATH_MEMBERS } from "../compiler/math-intrinsics.js";
import { stringLiteral } from "../cpp-literals.js";

const NAVIGATION_MODULE = "src/navigation/navigation.ts";

/**
 * The glue's own array helper, whose raw `get(i)`/`set(i, v)` read and store
 * element `i` of the data it wraps: over a pointer the library hands the
 * wrapper, that pointer's own element.
 */
const GLUE_ARRAY_BASE = "BaseArray";

const classAccesses = new Map<string, ReadonlyMap<string, RawAccess>>();

/** Every method of a core wrapper class this lowering can spell, inherited ones first. */
function wrapperClass(className: string): ReadonlyMap<string, RawAccess> {
    const cached = classAccesses.get(className);
    if (cached) return cached;
    const core = wrapperModule(WRAPPER_CORE);
    const declaration = core.statements.find(
        (statement): statement is ts.ClassDeclaration =>
            ts.isClassDeclaration(statement) &&
            statement.name?.text === className,
    );
    if (!declaration) {
        throw new Error(`${WRAPPER_CORE} no longer declares ${className}.`);
    }
    const accesses = new Map<string, RawAccess>();
    const base = declaration.heritageClauses
        ?.flatMap((clause) => [...clause.types])
        .map((type) => type.expression.getText())[0];
    if (base) {
        for (const [name, access] of wrapperClass(base)) {
            accesses.set(name, access);
        }
    }
    const glueArray = className === GLUE_ARRAY_BASE;
    for (const member of declaration.members) {
        if (!ts.isMethodDeclaration(member) || !member.body) continue;
        const access = methodAccess(member);
        if (!access) continue;
        const name = member.name.getText();
        if (
            glueArray &&
            access.kind === "read" &&
            access.source.kind === "call"
        ) {
            // `get(i)`: the element of the wrapped data.
            accesses.set(name, {
                kind: "read",
                source: { kind: "element", field: "" },
            });
        } else {
            accesses.set(name, access);
        }
    }
    if (glueArray) {
        // `set(i, value)`: `this.raw.set(i, value)`, a store into the data.
        const set = declaration.members.find(
            (member): member is ts.MethodDeclaration =>
                ts.isMethodDeclaration(member) &&
                member.name.getText() === "set",
        );
        const [only] = set?.body?.statements ?? [];
        if (
            !only ||
            !ts.isExpressionStatement(only) ||
            only.expression.getText() !== "this.raw.set(i, value)"
        ) {
            throw new Error(
                `${WRAPPER_CORE}'s ${GLUE_ARRAY_BASE}.set no longer stores ` +
                    "through its raw array.",
            );
        }
        accesses.set("set", { kind: "store", field: "", element: true });
    }
    classAccesses.set(className, accesses);
    return accesses;
}

/** An element of `owner`'s `field` (the pointer's own element for the glue array). */
function elementCpp(owner: string, field: string, index: string): string {
    return `${field ? `${owner}->${field}` : owner}[static_cast<std::size_t>(${index})]`;
}

/** A JavaScript number handed to a raw method, converted the way the binding converts it. */
function numberArgument(value: string): string {
    return `bbl::js::NumberArgument{static_cast<double>(${value})}`;
}

function sourceCpp(
    owner: string,
    source: RawSource,
    args: readonly string[],
): string {
    switch (source.kind) {
        case "field":
            return `${owner}->${source.field}`;
        case "element":
            return elementCpp(owner, source.field, args[0]!);
        case "call":
            return `${owner}->${source.method}(${args.map(numberArgument).join(", ")})`;
    }
}

/**
 * The views a lowered body holds over library objects: each is a C++
 * pointer, its wrapper class decides what each method call spells, and a
 * declaration of another view (`const tile = navMesh.getTile(i)`) binds a
 * new one.
 */
class LibraryViews {
    public readonly bindings = new Map<string, PinnedBinding>();
    public readonly calls = new Map<string, PinnedCallSpelling>();
    private readonly classes = new Map<string, string>();

    /** `name` is a pointer to the raw object a `className` wraps. */
    public bind(name: string, className: string, absentCpp?: string): void {
        this.classes.set(name, className);
        this.bindings.set(name, {
            cpp: name,
            type: "opaque",
            ...(absentCpp ? { absentCpp } : {}),
        });
        for (const [method, access] of wrapperClass(className)) {
            const key = `${name}.${method}`;
            if (access.kind === "read") {
                this.calls.set(
                    key,
                    (args) =>
                        `static_cast<double>(${sourceCpp(name, access.source, args)})`,
                );
            } else if (access.kind === "store") {
                this.calls.set(key, (args) => {
                    const target = access.element
                        ? elementCpp(name, access.field, args[0]!)
                        : `${name}->${access.field}`;
                    const value = args[access.element ? 1 : 0]!;
                    return (
                        `${target} = bbl::js::numeric_store_value<` +
                        `std::remove_reference_t<decltype(${target})>>(${value})`
                    );
                });
            }
        }
    }

    /**
     * A declaration binding a view the call returns, or undefined for any
     * other statement. A nullable view reads as absent where the library
     * holds none.
     */
    public declaration(
        statement: ts.Statement,
        lowerer: PinnedNumericLowerer,
        indent: string,
    ): string[] | undefined {
        const declared =
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.length === 1
                ? statement.declarationList.declarations[0]!
                : undefined;
        const call = declared?.initializer
            ? unwrapExpression(declared.initializer)
            : undefined;
        if (
            !declared ||
            !ts.isIdentifier(declared.name) ||
            !call ||
            !ts.isCallExpression(call) ||
            !ts.isPropertyAccessExpression(call.expression) ||
            !ts.isIdentifier(call.expression.expression)
        ) {
            return undefined;
        }
        const owner = call.expression.expression.text;
        const ownerClass = this.classes.get(owner);
        const access = ownerClass
            ? wrapperClass(ownerClass).get(call.expression.name.text)
            : undefined;
        if (access?.kind !== "view" && access?.kind !== "nullableView") {
            return undefined;
        }
        const name = declared.name.text;
        const args = call.arguments.map((argument) =>
            lowerer.expression(argument),
        );
        let pointer: string;
        if (access.kind === "nullableView") {
            pointer = `${owner}->${access.field}`;
            this.bind(name, access.className, `${name} == nullptr`);
        } else {
            pointer =
                access.source.kind === "element"
                    ? `&${sourceCpp(owner, access.source, args)}`
                    : sourceCpp(owner, access.source, args);
            this.bind(name, access.className);
        }
        return [`${indent}const auto* ${name} = ${pointer};`];
    }
}

/** `const name = []` in a wrapper module: a JavaScript array of numbers. */
function emptyNumberList(
    statement: ts.Statement,
    bindings: Map<string, PinnedBinding>,
    indent: string,
): string[] | undefined {
    const declared =
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.length === 1
            ? statement.declarationList.declarations[0]!
            : undefined;
    const initializer = declared?.initializer
        ? unwrapExpression(declared.initializer)
        : undefined;
    if (
        !declared ||
        !ts.isIdentifier(declared.name) ||
        !initializer ||
        !ts.isArrayLiteralExpression(initializer) ||
        initializer.elements.length !== 0
    ) {
        return undefined;
    }
    bindings.set(declared.name.text, {
        cpp: declared.name.text,
        type: "f64-list",
    });
    return [`${indent}std::vector<double> ${declared.name.text};`];
}

/** One template the PAL instantiates. */
interface LibraryTemplate {
    comment: string;
    typenames: readonly string[];
    returns: string;
    name: string;
    parameters: readonly string[];
    body: readonly string[];
}

function templateCpp(template: LibraryTemplate): string {
    return (
        `/** ${template.comment} */\n` +
        `template <${template.typenames.map((name) => `typename ${name}`).join(", ")}>\n` +
        `inline ${template.returns} ${template.name}(\n    ` +
        `${template.parameters.join(",\n    ")}) {\n${template.body.join("\n")}\n}`
    );
}

/** Core's `getNavMeshPositionsAndIndices`, over the PAL's navmesh. */
function navMeshWalkTemplate(): LibraryTemplate {
    const core = wrapperModule(WRAPPER_CORE);
    const walk = blockArrow(core, "getNavMeshPositionsAndIndices", [
        "navMesh",
        "flags",
    ]);
    // The pinned debug geometry asks for every poly: it passes no flags.
    const context = sharedPinnedContext();
    const { declaration } = context.functionDeclaration(
        NAVIGATION_MODULE,
        "createDebugNavMeshGeometry",
    );
    const walks = findNodes(
        declaration,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "getNavMeshPositionsAndIndices",
    );
    if (walks.length !== 1 || walks[0]!.arguments.length !== 1) {
        return context.contractError(
            declaration,
            "Expected createDebugNavMeshGeometry to walk the navmesh once, " +
                "with no poly flags.",
        );
    }
    const views = new LibraryViews();
    views.bind("navMesh", "NavMesh");
    views.bindings.set("flags", absentBinding("undefined"));
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(core, {
        bindings: views.bindings,
        calls: views.calls,
        statement: (statement, active, indent) =>
            emptyNumberList(statement, views.bindings, indent) ??
            views.declaration(statement, active, indent),
        returnValue: (expression) => {
            const returned = expression
                ? unwrapExpression(expression)
                : undefined;
            const lists =
                returned && ts.isArrayLiteralExpression(returned)
                    ? returned.elements.map((element) => element.getText())
                    : [];
            if (
                lists.length !== 2 ||
                lists.some(
                    (list) => views.bindings.get(list)?.type !== "f64-list",
                )
            ) {
                return contractError(
                    walk,
                    "Expected getNavMeshPositionsAndIndices to return " +
                        "[positions, indices].",
                );
            }
            return `bbl::pal::NavMeshPositionsAndIndices{${lists
                .map((list) => `std::move(${list})`)
                .join(", ")}}`;
        },
    });
    return {
        comment: provenance("core", "getNavMeshPositionsAndIndices"),
        typenames: ["NavMesh"],
        returns: "bbl::pal::NavMeshPositionsAndIndices",
        name: "get_nav_mesh_positions_and_indices",
        parameters: ["const NavMesh* navMesh"],
        body: lowerer.statements(walk.body.statements, "    "),
    };
}

/** `generateSoloNavMeshData`'s poly area/flag normalization over its poly mesh. */
function soloPolyFlagsTemplate(): LibraryTemplate {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const generator = blockArrow(file, "generateSoloNavMeshData", [
        "positions",
        "indices",
        "navMeshGeneratorConfig",
        "keepIntermediates",
    ]);
    const context = sharedPinnedContext();
    const polyMesh = declarationOf(
        generator.body.statements,
        "polyMesh",
        generator,
    );
    context.assertExpressionShape(
        polyMesh.declaration.initializer!,
        "allocPolyMesh()",
        "generateSoloNavMeshData's poly mesh",
    );
    const core = wrapperModule(WRAPPER_CORE);
    context.assertExpressionShape(
        variableInitializer(core, "allocPolyMesh"),
        "() => { return new RecastPolyMesh(Raw.Recast.allocPolyMesh()); }",
        "core's allocPolyMesh",
    );
    // `Recast.RC_WALKABLE_AREA` is the glue's own `Recast::WALKABLE_AREA`,
    // which the PAL passes in by the library's name for it.
    const constants = findNodes(
        core,
        (node): node is ts.BinaryExpression =>
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            node.left.getText() === "Recast.RC_WALKABLE_AREA",
    );
    if (
        constants.length !== 1 ||
        constants[0]!.right.getText() !== "Raw.Recast.WALKABLE_AREA"
    ) {
        return context.contractError(
            core,
            "Expected core's Recast.RC_WALKABLE_AREA to be the glue's WALKABLE_AREA.",
        );
    }
    const loops = generator.body.statements.filter(
        (statement): statement is ts.ForStatement =>
            ts.isForStatement(statement) &&
            statement.condition !== undefined &&
            context.expressionMatchesShape(
                statement.condition,
                "i < polyMesh.npolys()",
            ),
    );
    if (loops.length !== 1) {
        return context.contractError(
            generator,
            "Expected generateSoloNavMeshData to normalize its poly mesh in one loop.",
        );
    }
    const views = new LibraryViews();
    views.bind("polyMesh", "RecastPolyMesh");
    views.bindings.set("Recast.RC_WALKABLE_AREA", {
        cpp: "walkableArea",
        type: "scalar",
    });
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: views.bindings,
        calls: views.calls,
    });
    return {
        comment:
            provenance("generators", "generateSoloNavMeshData") +
            " Its poly area and flag normalization.",
        typenames: ["PolyMesh"],
        returns: "void",
        name: "solo_nav_mesh_poly_areas_and_flags",
        parameters: ["PolyMesh* polyMesh", "double walkableArea"],
        body: lowerer.statements(loops, "    "),
    };
}

/**
 * The wrapper class each argument of core's `TileCacheMeshProcess` callback
 * is: `new C(...)` bound to a local, or `C.fromRaw(...)`.
 */
function meshProcessArgumentClasses(): readonly string[] {
    const core = wrapperModule(WRAPPER_CORE);
    const declaration = core.statements.find(
        (statement): statement is ts.ClassDeclaration =>
            ts.isClassDeclaration(statement) &&
            statement.name?.text === "TileCacheMeshProcess",
    );
    const constructor = declaration?.members.find(ts.isConstructorDeclaration);
    const calls = constructor
        ? findNodes(
              constructor,
              (node): node is ts.CallExpression =>
                  ts.isCallExpression(node) &&
                  ts.isIdentifier(node.expression) &&
                  node.expression.text === "process",
          )
        : [];
    const [call] = calls;
    if (!constructor || calls.length !== 1 || !call) {
        throw new Error(
            `${WRAPPER_CORE} no longer wraps its TileCacheMeshProcess ` +
                "callback's arguments in one call.",
        );
    }
    return call.arguments.map((argument) => {
        let node = unwrapExpression(argument);
        if (ts.isIdentifier(node)) {
            node = unwrapExpression(
                variableInitializer(constructor, node.text),
            );
        }
        if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
            return node.expression.text;
        }
        if (
            ts.isCallExpression(node) &&
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === "fromRaw" &&
            ts.isIdentifier(node.expression.expression)
        ) {
            return node.expression.expression.text;
        }
        return contractError(
            argument,
            "Expected a TileCacheMeshProcess argument to be a wrapper of its raw pointer.",
        );
    });
}

/** `createDefaultTileCacheMeshProcess`'s process, the default every reached tile cache installs. */
function tileCacheMeshProcessTemplate(): LibraryTemplate {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const context = sharedPinnedContext();
    const tileCache = blockArrow(file, "generateTileCache", [
        "positions",
        "indices",
        "navMeshGeneratorConfig",
        "keepIntermediates",
    ]);
    // The pinned module installs its own process only beside off-mesh
    // connections, which the compiler refuses on a tile cache.
    context.assertExpressionShape(
        declarationOf(
            tileCache.body.statements,
            "tileCacheMeshProcess",
            tileCache,
        ).declaration.initializer!,
        "navMeshGeneratorConfig.tileCacheMeshProcess ?? createDefaultTileCacheMeshProcess()",
        "generateTileCache's mesh process",
    );
    const factory = unwrapExpression(
        variableInitializer(file, "createDefaultTileCacheMeshProcess"),
    );
    const made =
        ts.isArrowFunction(factory) && !ts.isBlock(factory.body)
            ? unwrapExpression(factory.body)
            : undefined;
    const callback =
        made &&
        ts.isNewExpression(made) &&
        made.expression.getText() === "TileCacheMeshProcess" &&
        made.arguments?.length === 1
            ? unwrapExpression(made.arguments[0]!)
            : undefined;
    if (
        !callback ||
        !ts.isArrowFunction(callback) ||
        !ts.isBlock(callback.body)
    ) {
        return contractError(
            factory,
            "Expected createDefaultTileCacheMeshProcess to make a " +
                "TileCacheMeshProcess over one arrow function.",
        );
    }
    const names = callback.parameters.map((parameter) =>
        parameter.name.getText(),
    );
    const classes = meshProcessArgumentClasses();
    if (names.length !== classes.length) {
        return contractError(
            callback,
            "Expected the mesh process to take the arguments core hands it.",
        );
    }
    const views = new LibraryViews();
    names.forEach((name, index) => views.bind(name, classes[index]!));
    const lowerer = new PinnedNumericLowerer(file, {
        bindings: views.bindings,
        calls: views.calls,
    });
    const typenames = ["CreateParams", "PolyAreas", "PolyFlags"];
    return {
        comment: provenance("generators", "createDefaultTileCacheMeshProcess"),
        typenames,
        returns: "void",
        name: "default_tile_cache_mesh_process",
        parameters: names.map((name, index) => `${typenames[index]}* ${name}`),
        body: lowerer.statements(callback.body.statements, "    "),
    };
}

/**
 * `bblite/upstream/navigation_library.hpp`: the templates the Recast PAL
 * instantiates over its library objects. The tile-cache process is emitted
 * where a scene builds a tile cache.
 */
export function navigationLibraryHeader(tileCache: boolean): string {
    const templates = [
        navMeshWalkTemplate(),
        soloPolyFlagsTemplate(),
        ...(tileCache ? [tileCacheMeshProcessTemplate()] : []),
    ];
    return pinnedHeader(
        [
            "<bblite/js_data.hpp>",
            "<bblite/pal_navigation.hpp>",
            "",
            "<cstddef>",
            "<cstdint>",
            "<type_traits>",
            "<utility>",
            "<vector>",
        ],
        templates.map(templateCpp).join("\n"),
    );
}

/**
 * The pinned `createDebugNavMeshGeometry`, lowered whole over the PAL's walk:
 * the detached triangles in double as JavaScript computes them, each stored
 * into its typed array at that array's width, and the positions hash.
 */
export function navigationDebugGeometryDefinition(
    context: LoweringContext,
): string {
    const { file, declaration } = context.functionDeclaration(
        NAVIGATION_MODULE,
        "createDebugNavMeshGeometry",
    );
    const [guard, walk] = declaration.body!.statements;
    const walkDeclaration =
        walk &&
        ts.isVariableStatement(walk) &&
        walk.declarationList.declarations.length === 1
            ? walk.declarationList.declarations[0]!
            : undefined;
    const lists =
        walkDeclaration && ts.isArrayBindingPattern(walkDeclaration.name)
            ? walkDeclaration.name.elements.map((element) =>
                  element.getText(file),
              )
            : [];
    if (
        !guard ||
        !walkDeclaration?.initializer ||
        lists.length !== 2 ||
        !context.expressionMatchesShape(
            walkDeclaration.initializer,
            "plugin._recast.getNavMeshPositionsAndIndices(plugin._navMesh)",
        )
    ) {
        return context.contractError(
            declaration,
            "Expected createDebugNavMeshGeometry to guard the navmesh and " +
                "then destructure its positions and indices.",
        );
    }
    // `if (!plugin._navMesh) { ThrowLiteError(n); }`
    const thrown =
        ts.isIfStatement(guard) &&
        !guard.elseStatement &&
        context.expressionMatchesShape(guard.expression, "!plugin._navMesh") &&
        ts.isBlock(guard.thenStatement) &&
        guard.thenStatement.statements.length === 1 &&
        ts.isExpressionStatement(guard.thenStatement.statements[0]!)
            ? unwrapExpression(guard.thenStatement.statements[0].expression)
            : undefined;
    const code =
        thrown &&
        ts.isCallExpression(thrown) &&
        isPinnedErrorCall(file, thrown) &&
        thrown.arguments.length === 1 &&
        ts.isNumericLiteral(thrown.arguments[0]!)
            ? Number(thrown.arguments[0].text)
            : undefined;
    if (code === undefined) {
        return context.contractError(
            guard,
            "Expected createDebugNavMeshGeometry to refuse a plugin without " +
                "a navmesh through the pinned error table.",
        );
    }
    const bindings = new Map<string, PinnedBinding>([
        [lists[0]!, { cpp: "walk.positions", type: "f64-list" }],
        [lists[1]!, { cpp: "walk.indices", type: "f64-list" }],
    ]);
    const calls = new Map<string, PinnedCallSpelling>();
    for (const name of ["hypot", "round", "imul"]) {
        const member = MATH_MEMBERS.get(name);
        if (!member) throw new Error(`Math.${name} has no shared spelling.`);
        calls.set(`Math.${name}`, (args) => member.cpp(args));
    }
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls,
        statement: (statement, _active, indent) => {
            if (statement === guard) {
                return [
                    `${indent}if (!bbl::pal::navigation_has_nav_mesh(plugin)) {`,
                    `${indent}    throw std::runtime_error(${stringLiteral(
                        pinnedErrorMessage(context, code),
                    )});`,
                    `${indent}}`,
                ];
            }
            if (statement === walk) {
                return [
                    `${indent}const bbl::pal::NavMeshPositionsAndIndices walk =`,
                    `${indent}    bbl::pal::navigation_positions_and_indices(plugin);`,
                ];
            }
            return undefined;
        },
        returnValue: (expression) => {
            if (!expression) {
                return context.contractError(
                    declaration,
                    "Expected createDebugNavMeshGeometry to return its geometry.",
                );
            }
            context.assertExpressionShape(
                expression,
                "{ positions, normals, indices, positionsHash: hash }",
                "createDebugNavMeshGeometry's result",
            );
            const local = (name: string): string => {
                const binding = bindings.get(name);
                if (!binding) {
                    return context.contractError(
                        expression,
                        `Expected createDebugNavMeshGeometry to declare ${name}.`,
                    );
                }
                return binding.cpp;
            };
            return (
                `bbl::pal::NavDebugGeometry{std::move(${local("positions")}), ` +
                `std::move(${local("normals")}), std::move(${local("indices")}), ` +
                `${local("hash")}}`
            );
        },
    });
    return (
        `// ${context.provenance(NAVIGATION_MODULE, "createDebugNavMeshGeometry")}\n` +
        "bbl::pal::NavDebugGeometry create_debug_nav_mesh_geometry(\n" +
        "    bbl::pal::NavigationHandle plugin) {\n" +
        `${lowerer.statements(declaration.body!.statements, "    ").join("\n")}\n}`
    );
}
