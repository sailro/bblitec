/**
 * The @recast-navigation generators' build plan: every number
 * `generateSoloNavMeshData` and `generateTileCache` compute before they hand
 * it to Recast or Detour, lowered from the installed packages into the
 * generated navigation header.
 *
 * The PAL owns the library calls and nothing else. What it is handed is a
 * plan (`bbl::pal::NavSoloBuild` / `NavTileCacheBuild`) built here from the
 * packages' own JavaScript:
 *
 * - the input bounds (`getBoundingBox`);
 * - the `rcConfig` (`createRcConfig`), with the object spreads between the
 *   pinned `_createNavMeshFromMerged`'s `cfg` and it resolved at generation
 *   into one reachable value per field;
 * - each generator's build-config step (region areas squared, detail
 *   sampling in cells, the tile grid and the padded tile extent);
 * - the Detour parameter records (the `NavMeshCreateParams` setters,
 *   `DetourTileCacheParams.create`, and `NavMeshParams.create` after the
 *   package's own `dtIlog2`/`dtNextPow2` tile/poly bit split);
 * - each tile's config (`rasterizeTileLayers`), and the allocator, chunk and
 *   chunk-query sizes the tile arm names.
 *
 * Reads widen to the JavaScript number they are, and every store into a
 * wrapper record narrows through the field's own type, as the wrapper's
 * emscripten setters do. A lowered slice ends where the generator calls the
 * library; `calcGridSize` is the one call the plan needs part-way, so the
 * PAL exports it.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
    contractError,
    findNodes,
    hasNode,
    nullishDefault,
    numericValue,
    sharedPinnedContext,
    unwrapExpression,
    variableInitializer,
} from "./context.js";
import {
    type PinnedBinding,
    PinnedNumericLowerer,
} from "./pinned-numeric-lowerer.js";
import { pinnedMathCall, pinnedNumericMathCalls } from "./pinned-operators.js";
import { doubleLiteral } from "../cpp-literals.js";

export const WRAPPER_CORE = "@recast-navigation/core/dist/index.mjs";
const WRAPPER_GENERATORS = "@recast-navigation/generators/dist/index.mjs";
const NAVIGATION_MODULE = "src/navigation/navigation.ts";

/**
 * `bbl::pal::NavMeshBuildParams`' field for each `NavMeshParameters` key a
 * reached `createNavMesh` may carry. `intrinsics/navigation.ts` fills the
 * fields the scene names; the plan reads them where the pinned `cfg` does.
 */
export const NAV_MESH_BUILD_PARAM_FIELDS: ReadonlyMap<string, string> = new Map(
    [
        ["cs", "cs"],
        ["ch", "ch"],
        ["walkableSlopeAngle", "walkable_slope_angle"],
        ["walkableHeight", "walkable_height"],
        ["walkableClimb", "walkable_climb"],
        ["walkableRadius", "walkable_radius"],
        ["maxEdgeLen", "max_edge_len"],
        ["maxSimplificationError", "max_simplification_error"],
        ["minRegionArea", "min_region_area"],
        ["mergeRegionArea", "merge_region_area"],
        ["maxVertsPerPoly", "max_verts_per_poly"],
        ["detailSampleDist", "detail_sample_dist"],
        ["detailSampleMaxError", "detail_sample_max_error"],
        // The tile-cache arm's three. `maxObstacles > 0` is what selects
        // that arm, and the other two are read only once it has been.
        ["tileSize", "tile_size"],
        ["expectedLayersPerTile", "expected_layers_per_tile"],
        ["maxObstacles", "max_obstacles"],
    ],
);

const wrapperModules = new Map<string, ts.SourceFile>();

/** One installed `@recast-navigation` module's syntax tree, parsed once. */
export function wrapperModule(moduleSpecifier: string): ts.SourceFile {
    const cached = wrapperModules.get(moduleSpecifier);
    if (cached) return cached;
    const require = createRequire(import.meta.url);
    const modulePath = require.resolve(moduleSpecifier);
    const file = ts.createSourceFile(
        modulePath,
        readFileSync(modulePath, "utf8"),
        ts.ScriptTarget.Latest,
        true,
    );
    wrapperModules.set(moduleSpecifier, file);
    return file;
}

/** The installed version of one `@recast-navigation` package. */
export function wrapperPackageVersion(name: string): string {
    const require = createRequire(import.meta.url);
    const manifest: unknown = JSON.parse(
        readFileSync(require.resolve(`${name}/package.json`), "utf8"),
    );
    if (
        typeof manifest !== "object" ||
        manifest === null ||
        !("version" in manifest) ||
        typeof manifest.version !== "string"
    ) {
        throw new Error(`${name}'s package.json names no version.`);
    }
    return manifest.version;
}

/** `a.b.c` as its names, or undefined for anything but a property path. */
function propertyPath(expression: ts.Expression): string[] | undefined {
    const unwrapped = unwrapExpression(expression);
    if (ts.isIdentifier(unwrapped)) return [unwrapped.text];
    if (unwrapped.kind === ts.SyntaxKind.ThisKeyword) return ["this"];
    if (ts.isPropertyAccessExpression(unwrapped)) {
        const owner = propertyPath(unwrapped.expression);
        return owner ? [...owner, unwrapped.name.text] : undefined;
    }
    return undefined;
}

type BlockArrow = ts.ArrowFunction & { body: ts.Block };

function isBlockArrow(node: ts.Node): node is BlockArrow {
    return ts.isArrowFunction(node) && ts.isBlock(node.body);
}

/** A `const name = (...) => { ... }` under `scope`, refusing any other shape. */
function blockArrow(
    scope: ts.Node,
    name: string,
    parameters: readonly string[],
): BlockArrow {
    const arrow = unwrapExpression(variableInitializer(scope, name));
    if (
        !isBlockArrow(arrow) ||
        arrow.parameters.length !== parameters.length ||
        arrow.parameters.some(
            (parameter, index) =>
                parameter.name.getText() !== parameters[index],
        )
    ) {
        return contractError(
            arrow,
            `Expected ${name} to stay an arrow function of ` +
                `(${parameters.join(", ")}) with a body.`,
        );
    }
    return arrow;
}

/** The one statement of `statements` declaring `name`, and its index. */
function declarationOf(
    statements: readonly ts.Statement[],
    name: string,
    at: ts.Node,
): { index: number; declaration: ts.VariableDeclaration } {
    const found = statements.flatMap((statement, index) =>
        ts.isVariableStatement(statement) &&
        statement.declarationList.declarations.length === 1 &&
        ts.isIdentifier(statement.declarationList.declarations[0]!.name) &&
        statement.declarationList.declarations[0]!.name.text === name
            ? [
                  {
                      index,
                      declaration: statement.declarationList.declarations[0]!,
                  },
              ]
            : [],
    );
    if (found.length !== 1 || !found[0]!.declaration.initializer) {
        return contractError(
            at,
            `Expected one declaration of '${name}' with an initializer.`,
        );
    }
    return found[0]!;
}

/** Whether a statement calls anything but a `Math` member or `allowed`. */
function callsOutside(
    statement: ts.Statement,
    allowed: ReadonlySet<string>,
): boolean {
    return hasNode(
        statement,
        (node) =>
            ts.isCallExpression(node) &&
            !pinnedMathCall(node) &&
            !allowed.has(node.expression.getText()),
    );
}

// ---------------------------------------------------------------------
// The config spreads
// ---------------------------------------------------------------------

type ConfigConstant = number | boolean;

/** A config key's value where the plan reads it, as C++. */
interface ConfigValue {
    cpp: string;
    type: "scalar" | "bool";
    /** Whether the spelling reads the scene's `NavMeshBuildParams`. */
    readsParams: boolean;
}

function constantValue(value: ConfigConstant): ConfigValue {
    return typeof value === "boolean"
        ? { cpp: value ? "true" : "false", type: "bool", readsParams: false }
        : { cpp: doubleLiteral(value), type: "scalar", readsParams: false };
}

/** The module an identifier is imported from, when it is imported. */
function importedFrom(file: ts.SourceFile, name: string): string | undefined {
    for (const statement of file.statements) {
        if (
            !ts.isImportDeclaration(statement) ||
            !statement.importClause?.namedBindings ||
            !ts.isNamedImports(statement.importClause.namedBindings) ||
            !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
            continue;
        }
        const imported = statement.importClause.namedBindings.elements.some(
            (element) => element.name.text === name && !element.propertyName,
        );
        if (imported) return statement.moduleSpecifier.text;
    }
    return undefined;
}

/**
 * A module-scope object of number and boolean defaults, its own spreads
 * resolved (last wins), following an import from the core package.
 */
function constantObject(
    moduleSpecifier: string,
    name: string,
): ReadonlyMap<string, ConfigConstant> {
    const file = wrapperModule(moduleSpecifier);
    const source = importedFrom(file, name);
    if (source !== undefined) {
        if (source !== "@recast-navigation/core") {
            throw new Error(
                `${moduleSpecifier} imports ${name} from ${source}, which the ` +
                    "navigation build plan does not read.",
            );
        }
        return constantObject(WRAPPER_CORE, name);
    }
    const literal = unwrapExpression(variableInitializer(file, name));
    if (!ts.isObjectLiteralExpression(literal)) {
        return contractError(
            literal,
            `Expected ${name} to be an object literal.`,
        );
    }
    const values = new Map<string, ConfigConstant>();
    for (const property of literal.properties) {
        if (
            ts.isSpreadAssignment(property) &&
            ts.isIdentifier(property.expression)
        ) {
            for (const [key, value] of constantObject(
                moduleSpecifier,
                property.expression.text,
            )) {
                values.set(key, value);
            }
            continue;
        }
        if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name)
        ) {
            return contractError(
                property,
                `Expected ${name} to hold plain number and boolean defaults.`,
            );
        }
        const value = unwrapExpression(property.initializer);
        values.set(
            property.name.text,
            value.kind === ts.SyntaxKind.TrueKeyword
                ? true
                : value.kind === ts.SyntaxKind.FalseKeyword
                  ? false
                  : numericValue(value, file),
        );
    }
    return values;
}

/** The build arm a reached `createNavMesh` takes. */
export type NavigationBuildArm = "solo" | "tileCache";
type BuildArm = NavigationBuildArm;

/**
 * One `cfg.<key> = ...` the pinned module performs for an arm: a copy made
 * only when the scene gave the key, a store the arm always makes, or one it
 * makes under a further condition, which the plan cannot read.
 */
type CfgAssignment =
    | { key: string; kind: "given" }
    | { key: string; kind: "always"; value: ts.Expression }
    | { key: string; kind: "conditional"; at: ts.Node };

let cfgAssignments: ReadonlyMap<BuildArm, readonly CfgAssignment[]> | undefined;

/**
 * What the pinned `_createNavMeshFromMerged` puts in `cfg` for each arm, in
 * order: the keys it copies when the scene gave them (`if (params.K !==
 * undefined) { cfg.K = params.K; }`), then the tile-cache block's own. The
 * tiled block belongs to an arm the compiler refuses, and any other `cfg`
 * store refuses here.
 */
function pinnedCfgAssignments(arm: BuildArm): readonly CfgAssignment[] {
    if (!cfgAssignments) {
        const context = sharedPinnedContext();
        const { declaration } = context.functionDeclaration(
            NAVIGATION_MODULE,
            "_createNavMeshFromMerged",
        );
        const common: CfgAssignment[] = [];
        const tileCache: CfgAssignment[] = [];
        const accounted = new Set<ts.Node>();
        for (const statement of declaration.body!.statements) {
            if (!ts.isIfStatement(statement)) continue;
            const guard = statement.expression;
            const block = ts.isBlock(statement.thenStatement)
                ? statement.thenStatement.statements
                : [];
            if (ts.isIdentifier(guard) && guard.text === "needsTileCache") {
                for (const store of findNodes(
                    statement.thenStatement,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                        propertyPath(node.left)?.[0] === "cfg",
                )) {
                    const key = propertyPath(store.left)![1]!;
                    const direct = block.some(
                        (inner) =>
                            ts.isExpressionStatement(inner) &&
                            inner.expression === store,
                    );
                    tileCache.push(
                        direct
                            ? { key, kind: "always", value: store.right }
                            : { key, kind: "conditional", at: store },
                    );
                    accounted.add(store);
                }
                continue;
            }
            if (ts.isIdentifier(guard) && guard.text === "needsTiled") {
                for (const store of findNodes(
                    statement,
                    (node): node is ts.BinaryExpression =>
                        ts.isBinaryExpression(node) &&
                        node.operatorToken.kind === ts.SyntaxKind.EqualsToken,
                )) {
                    accounted.add(store);
                }
                continue;
            }
            const [only] = block;
            const store =
                block.length === 1 &&
                only &&
                ts.isExpressionStatement(only) &&
                ts.isBinaryExpression(only.expression)
                    ? only.expression
                    : undefined;
            const path = store ? propertyPath(store.left) : undefined;
            const key = path?.length === 2 ? path[1]! : undefined;
            if (
                store &&
                key &&
                context.expressionMatchesShape(
                    guard,
                    `params.${key} !== undefined`,
                ) &&
                context.expressionMatchesShape(
                    store,
                    `cfg.${key} = params.${key}`,
                )
            ) {
                common.push({ key, kind: "given" });
                accounted.add(store);
            }
        }
        for (const store of findNodes(
            declaration,
            (node): node is ts.BinaryExpression =>
                ts.isBinaryExpression(node) &&
                node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                propertyPath(node.left)?.[0] === "cfg",
        )) {
            // `offMeshConnections` rides in `cfg` only when non-empty, and
            // the PAL reads the list itself; the build plan never does.
            const key = propertyPath(store.left)![1];
            if (!accounted.has(store) && key !== "offMeshConnections") {
                contractError(
                    store,
                    "Expected every cfg store in _createNavMeshFromMerged to " +
                        "be a given-key copy or an arm's own.",
                );
            }
        }
        cfgAssignments = new Map([
            ["solo", common],
            ["tileCache", [...common, ...tileCache]],
        ]);
    }
    return cfgAssignments.get(arm)!;
}

/** The scene's own parameter, as the plan reads it. */
function paramsField(key: string, at: ts.Node): string {
    const field = NAV_MESH_BUILD_PARAM_FIELDS.get(key);
    if (!field) {
        return contractError(
            at,
            `The pinned cfg reads params.${key}, which ` +
                "bbl::pal::NavMeshBuildParams does not carry.",
        );
    }
    return `params.${field}`;
}

/** `cfg.<key>` layered over what the spreads beneath it hold. */
function cfgValue(
    arm: BuildArm,
    key: string,
    below: ConfigValue | undefined,
): ConfigValue | undefined {
    let value = below;
    for (const assignment of pinnedCfgAssignments(arm)) {
        if (assignment.key !== key) continue;
        const at = sharedPinnedContext().functionDeclaration(
            NAVIGATION_MODULE,
            "_createNavMeshFromMerged",
        ).declaration;
        if (assignment.kind === "conditional") {
            return contractError(
                assignment.at,
                `cfg.${key} is stored only under a further condition, which ` +
                    "the build plan does not read.",
            );
        }
        if (assignment.kind === "given") {
            // Present only when the scene gave it; the spread beneath
            // answers otherwise.
            if (!value || value.type !== "scalar") {
                return contractError(
                    at,
                    `cfg.${key} is copied only when given, and no default ` +
                        "beneath it answers when it is not.",
                );
            }
            value = {
                cpp: `${paramsField(key, at)}.value_or(${value.cpp})`,
                type: "scalar",
                readsParams: true,
            };
            continue;
        }
        // Always present: `params.K ?? N`, or `params.K` itself, which a
        // scene that selected this arm has given.
        const nullish = nullishDefault(assignment.value);
        const path = propertyPath(nullish ? nullish.left : assignment.value);
        if (path?.length !== 2 || path[0] !== "params") {
            return contractError(
                assignment.value,
                `Expected cfg.${key} to be read from params.`,
            );
        }
        const field = paramsField(path[1]!, assignment.value);
        value = {
            cpp: nullish
                ? `${field}.value_or(${doubleLiteral(
                      numericValue(
                          nullish.right,
                          assignment.value.getSourceFile(),
                      ),
                  )})`
                : `${field}.value()`,
            type: "scalar",
            readsParams: true,
        };
    }
    return value;
}

/** One generator's config spread and the names it binds. */
interface GeneratorConfig {
    body: ts.Block;
    /** The generator defaults the spread starts from. */
    defaults: string;
    /** Keys destructured out before `createRcConfig` sees the rest. */
    excluded: ReadonlySet<string>;
    /** The `createRcConfig` statement and the local it declares. */
    creation: { index: number; config: string };
}

const GENERATORS: Readonly<Record<BuildArm, string>> = {
    solo: "generateSoloNavMeshData",
    tileCache: "generateTileCache",
};

function generatorConfig(arm: BuildArm): GeneratorConfig {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const parameters = [
        "positions",
        "indices",
        "navMeshGeneratorConfig",
        "keepIntermediates",
    ];
    const generator = blockArrow(file, GENERATORS[arm], parameters);
    const body = generator.body;
    if (arm === "solo") {
        // The pin calls generateSoloNavMesh, which hands its config on.
        const solo = blockArrow(file, "generateSoloNavMesh", parameters);
        sharedPinnedContext().assertExpressionShape(
            variableInitializer(solo.body, "createNavMeshDataResult"),
            "generateSoloNavMeshData(positions, indices, navMeshGeneratorConfig, keepIntermediates)",
            "generateSoloNavMesh's data build",
        );
    }
    const created = body.statements.flatMap((statement, index) => {
        const declaration =
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.length === 1
                ? statement.declarationList.declarations[0]!
                : undefined;
        const call = declaration?.initializer
            ? unwrapExpression(declaration.initializer)
            : undefined;
        return declaration &&
            ts.isIdentifier(declaration.name) &&
            call &&
            ts.isCallExpression(call) &&
            call.expression.getText() === "createRcConfig" &&
            call.arguments.length === 1 &&
            ts.isIdentifier(call.arguments[0]!)
            ? [
                  {
                      index,
                      config: declaration.name.text,
                      argument: call.arguments[0].text,
                  },
              ]
            : [];
    });
    const [creation] = created;
    if (created.length !== 1 || !creation) {
        return contractError(
            generator,
            `Expected ${GENERATORS[arm]} to call createRcConfig once, on a local.`,
        );
    }
    // The argument is the spread itself, or its rest after the keys the
    // generator keeps for itself.
    const sources = findNodes(
        body,
        (node): node is ts.VariableDeclaration =>
            ts.isVariableDeclaration(node) &&
            (ts.isIdentifier(node.name)
                ? node.name.text === creation.argument
                : ts.isObjectBindingPattern(node.name) &&
                  node.name.elements.some(
                      (element) =>
                          element.dotDotDotToken !== undefined &&
                          element.name.getText() === creation.argument,
                  )),
    );
    const [source] = sources;
    if (sources.length !== 1 || !source?.initializer) {
        return contractError(
            generator,
            `Expected ${GENERATORS[arm]}'s createRcConfig argument to be one ` +
                "local built from the config spread.",
        );
    }
    const spread = unwrapExpression(source.initializer);
    const [base, given] = ts.isObjectLiteralExpression(spread)
        ? spread.properties
        : [];
    if (
        !ts.isObjectLiteralExpression(spread) ||
        spread.properties.length !== 2 ||
        !base ||
        !given ||
        !ts.isSpreadAssignment(base) ||
        !ts.isIdentifier(base.expression) ||
        !ts.isSpreadAssignment(given) ||
        given.expression.getText() !== "navMeshGeneratorConfig"
    ) {
        return contractError(
            spread,
            `Expected ${GENERATORS[arm]}'s config to be ` +
                "{ ...<defaults>, ...navMeshGeneratorConfig }.",
        );
    }
    const excluded = new Set<string>();
    if (ts.isObjectBindingPattern(source.name)) {
        for (const element of source.name.elements) {
            if (element.dotDotDotToken) continue;
            if (element.propertyName || !ts.isIdentifier(element.name)) {
                return contractError(
                    element,
                    "Expected the config's destructured keys by their own names.",
                );
            }
            excluded.add(element.name.text);
        }
    }
    // Both generators take their bounds from getBoundingBox unless the
    // config names its own, which no layer of the spread does.
    const context = sharedPinnedContext();
    const boundsChoice = body.statements.find(
        (statement): statement is ts.IfStatement =>
            ts.isIfStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "navMeshGeneratorConfig.bounds",
            ),
    );
    const measured =
        boundsChoice?.elseStatement && ts.isBlock(boundsChoice.elseStatement)
            ? boundsChoice.elseStatement.statements
            : [];
    const [box, low, high] = measured;
    if (
        measured.length !== 3 ||
        !box ||
        !low ||
        !high ||
        !ts.isVariableStatement(box) ||
        !context.expressionMatchesShape(
            variableInitializer(box, "boundingBox"),
            "getBoundingBox(positions, indices)",
        ) ||
        !ts.isExpressionStatement(low) ||
        !context.expressionMatchesShape(
            low.expression,
            "bbMin = boundingBox.bbMin",
        ) ||
        !ts.isExpressionStatement(high) ||
        !context.expressionMatchesShape(
            high.expression,
            "bbMax = boundingBox.bbMax",
        ) ||
        generatorValue(arm, "bounds", base.expression.text) !== undefined
    ) {
        return contractError(
            spread,
            `Expected ${GENERATORS[arm]} to take its bounds from ` +
                "getBoundingBox, with no config layer naming its own.",
        );
    }
    return {
        body,
        defaults: base.expression.text,
        excluded,
        creation: { index: creation.index, config: creation.config },
    };
}

/** A key of the generator's own spread: its defaults, then `cfg`. */
function generatorValue(
    arm: BuildArm,
    key: string,
    defaults: string,
): ConfigValue | undefined {
    const constant = constantObject(WRAPPER_GENERATORS, defaults).get(key);
    return cfgValue(
        arm,
        key,
        constant === undefined ? undefined : constantValue(constant),
    );
}

/**
 * A key `createRcConfig` reads: `{ ...recastConfigDefaults, ...partialConfig }`
 * over the generator's spread less the keys the generator destructured out.
 */
function rcConfigValue(
    arm: BuildArm,
    key: string,
    generator: GeneratorConfig,
): ConfigValue | undefined {
    const recast = constantObject(WRAPPER_CORE, "recastConfigDefaults").get(
        key,
    );
    const below = recast === undefined ? undefined : constantValue(recast);
    if (generator.excluded.has(key)) return below;
    const constant = constantObject(WRAPPER_GENERATORS, generator.defaults).get(
        key,
    );
    return cfgValue(
        arm,
        key,
        constant === undefined ? below : constantValue(constant),
    );
}

// ---------------------------------------------------------------------
// Wrapper records
// ---------------------------------------------------------------------

/** One store into a WebIDL-bound record: `r.f = v`, `r.set_f(v)`, `r.set_f(i, v)`. */
interface RawStore {
    owner: string;
    field: string;
    index: number | undefined;
    value: ts.Expression;
}

function rawStore(statement: ts.Statement): RawStore | undefined {
    if (!ts.isExpressionStatement(statement)) return undefined;
    const expression = unwrapExpression(statement.expression);
    if (
        ts.isBinaryExpression(expression) &&
        expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
        const path = propertyPath(expression.left);
        return path?.length === 2
            ? {
                  owner: path[0]!,
                  field: path[1]!,
                  index: undefined,
                  value: expression.right,
              }
            : undefined;
    }
    const path = ts.isCallExpression(expression)
        ? propertyPath(expression.expression)
        : undefined;
    if (
        !ts.isCallExpression(expression) ||
        path?.length !== 2 ||
        !path[1]!.startsWith("set_")
    ) {
        return undefined;
    }
    const [first, second] = expression.arguments;
    const field = path[1]!.slice("set_".length);
    if (expression.arguments.length === 1 && first) {
        return { owner: path[0]!, field, index: undefined, value: first };
    }
    if (
        expression.arguments.length === 2 &&
        first &&
        second &&
        ts.isNumericLiteral(first)
    ) {
        return {
            owner: path[0]!,
            field,
            index: Number(first.text),
            value: second,
        };
    }
    return undefined;
}

/** The `rcConfig` fields core's own `cloneRcConfig` copies. */
interface RcConfigFields {
    scalars: ReadonlySet<string>;
    arrays: ReadonlyMap<string, number>;
}

let rcConfigFields: RcConfigFields | undefined;

function wrapperRcConfigFields(): RcConfigFields {
    if (rcConfigFields) return rcConfigFields;
    const clone = blockArrow(wrapperModule(WRAPPER_CORE), "cloneRcConfig", [
        "rcConfig",
    ]);
    const statements = clone.body.statements;
    const scalars = new Set<string>();
    const arrays = new Map<string, number>();
    const context = sharedPinnedContext();
    context.assertExpressionShape(
        declarationOf(statements, "clone", clone).declaration.initializer!,
        "new Raw.Module.rcConfig()",
        "cloneRcConfig's record",
    );
    for (const statement of statements.slice(1, -1)) {
        const store = rawStore(statement);
        if (store?.owner !== "clone") {
            return contractError(
                statement,
                "Expected cloneRcConfig to store into its clone only.",
            );
        }
        if (store.index === undefined) {
            context.assertExpressionShape(
                store.value,
                `rcConfig.${store.field}`,
                "cloneRcConfig's field copy",
            );
            scalars.add(store.field);
        } else {
            context.assertExpressionShape(
                store.value,
                `rcConfig.get_${store.field}(${store.index})`,
                "cloneRcConfig's element copy",
            );
            arrays.set(
                store.field,
                Math.max(arrays.get(store.field) ?? 0, store.index + 1),
            );
        }
    }
    const last = statements.at(-1);
    if (
        !last ||
        !ts.isReturnStatement(last) ||
        last.expression?.getText() !== "clone"
    ) {
        return contractError(
            clone,
            "Expected cloneRcConfig to return its clone.",
        );
    }
    rcConfigFields = { scalars, arrays };
    return rcConfigFields;
}

/** Reads of an `rcConfig` local's scalar fields, widened as JavaScript does. */
function rcConfigReads(owner: string, cpp: string): [string, PinnedBinding][] {
    return [...wrapperRcConfigFields().scalars].map((field) => [
        `${owner}.${field}`,
        { cpp: `static_cast<double>(${cpp}.${field})`, type: "scalar" },
    ]);
}

/**
 * A store into a wrapper record's field at the field's own width: a number
 * narrows the way the emscripten setter does (ToInt32 for an `int`, the
 * nearest float for a `float`), a boolean stores as itself.
 */
function storeCpp(
    target: string,
    value: string,
    type: "scalar" | "bool",
): string {
    return type === "bool"
        ? `${target} = ${value};`
        : `${target} = bbl::js::numeric_store_value<` +
              `std::remove_reference_t<decltype(${target})>>(${value});`;
}

/** Whether an expression is a boolean the scope already knows. */
function booleanValue(
    expression: ts.Expression,
    bindings: ReadonlyMap<string, PinnedBinding>,
): boolean {
    const unwrapped = unwrapExpression(expression);
    return (
        unwrapped.kind === ts.SyntaxKind.TrueKeyword ||
        unwrapped.kind === ts.SyntaxKind.FalseKeyword ||
        bindings.get(unwrapped.getText())?.type === "bool"
    );
}

/** One field a wrapper `create` stores, and where in its argument it reads. */
interface CreateField {
    field: string;
    index: number | undefined;
    key: string;
    /** An element index (`config.orig[0]`) or member (`params.orig.x`). */
    component: number | string | undefined;
}

/** What a core class's `static create(config)` copies into its raw record. */
function wrapperCreateFields(className: string): readonly CreateField[] {
    const core = wrapperModule(WRAPPER_CORE);
    const declaration = core.statements.find(
        (statement): statement is ts.ClassDeclaration =>
            ts.isClassDeclaration(statement) &&
            statement.name?.text === className,
    );
    const create = declaration?.members.find(
        (member): member is ts.MethodDeclaration =>
            ts.isMethodDeclaration(member) &&
            member.name.getText() === "create" &&
            member.modifiers?.some(
                (modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword,
            ) === true,
    );
    const parameter = create?.parameters[0]?.name.getText();
    const statements = create?.body?.statements;
    if (
        !create ||
        !parameter ||
        !statements ||
        create.parameters.length !== 1
    ) {
        throw new Error(
            `${WRAPPER_CORE} no longer declares ${className}.create(config).`,
        );
    }
    const [first] = statements;
    const record =
        first && ts.isVariableStatement(first)
            ? first.declarationList.declarations[0]?.name.getText()
            : undefined;
    const fields: CreateField[] = [];
    for (const statement of statements.slice(1, -1)) {
        const store = rawStore(statement);
        const value = store ? unwrapExpression(store.value) : undefined;
        let path: string[] | undefined;
        let component: number | string | undefined;
        if (
            value &&
            ts.isElementAccessExpression(value) &&
            ts.isNumericLiteral(value.argumentExpression)
        ) {
            path = propertyPath(value.expression);
            component = Number(value.argumentExpression.text);
        } else if (value) {
            path = propertyPath(value);
            if (path?.length === 3) component = path[2];
        }
        if (
            !store ||
            store.owner !== record ||
            !path ||
            path[0] !== parameter ||
            (path.length !== 2 &&
                !(path.length === 3 && component !== undefined))
        ) {
            return contractError(
                statement,
                `Expected ${className}.create to copy its argument's fields ` +
                    "into its raw record.",
            );
        }
        fields.push({
            field: store.field,
            index: store.index,
            key: path[1]!,
            component,
        });
    }
    return fields;
}

/** The raw field each one-assignment setter of a core class writes. */
function wrapperSetterFields(className: string): ReadonlyMap<string, string> {
    const core = wrapperModule(WRAPPER_CORE);
    const declaration = core.statements.find(
        (statement): statement is ts.ClassDeclaration =>
            ts.isClassDeclaration(statement) &&
            statement.name?.text === className,
    );
    if (!declaration) {
        throw new Error(`${WRAPPER_CORE} no longer declares ${className}.`);
    }
    const setters = new Map<string, string>();
    for (const member of declaration.members) {
        if (
            !ts.isMethodDeclaration(member) ||
            member.parameters.length !== 1 ||
            member.body?.statements.length !== 1
        ) {
            continue;
        }
        const parameter = member.parameters[0]!.name.getText();
        const [only] = member.body.statements;
        const store =
            only &&
            ts.isExpressionStatement(only) &&
            ts.isBinaryExpression(only.expression) &&
            only.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
                ? only.expression
                : undefined;
        const path = store ? propertyPath(store.left) : undefined;
        if (
            store &&
            path?.length === 3 &&
            path[0] === "this" &&
            path[1] === "raw" &&
            store.right.getText() === parameter
        ) {
            setters.set(member.name.getText(), path[2]!);
        }
    }
    return setters;
}

/**
 * The stores a `<Class>.create({ ... })` call performs into `target`, each
 * property of the literal lowered and read at the component `create`
 * takes from it.
 */
function lowerCreate(
    call: ts.CallExpression,
    className: string,
    target: string,
    lowerer: PinnedNumericLowerer,
    bindings: ReadonlyMap<string, PinnedBinding>,
    indent: string,
): string[] {
    const literal = call.arguments[0]
        ? unwrapExpression(call.arguments[0])
        : undefined;
    if (
        call.expression.getText() !== `${className}.create` ||
        call.arguments.length !== 1 ||
        !literal ||
        !ts.isObjectLiteralExpression(literal)
    ) {
        return contractError(
            call,
            `Expected ${className}.create over one object literal.`,
        );
    }
    const properties = new Map<string, ts.Expression>();
    for (const property of literal.properties) {
        if (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name)
        ) {
            properties.set(property.name.text, property.initializer);
        } else if (ts.isShorthandPropertyAssignment(property)) {
            properties.set(property.name.text, property.name);
        } else {
            return contractError(
                property,
                `Unsupported ${className} property.`,
            );
        }
    }
    return wrapperCreateFields(className).map((field) => {
        const value = properties.get(field.key);
        if (!value) {
            return contractError(
                literal,
                `${className}.create reads '${field.key}', which the ` +
                    "generator does not pass.",
            );
        }
        let cpp: string;
        if (field.component === undefined) {
            cpp = lowerer.expression(value);
        } else {
            const binding = bindings.get(unwrapExpression(value).getText());
            if (
                typeof field.component === "number" &&
                binding?.type === "f64-buffer"
            ) {
                cpp = `${binding.cpp}[${field.component}]`;
            } else if (
                typeof field.component === "string" &&
                binding?.type === "vec3"
            ) {
                cpp = `${binding.cpp}.${field.component}`;
            } else {
                return contractError(
                    value,
                    `Expected ${className}'s '${field.key}' to be a bound ` +
                        "array or vector.",
                );
            }
        }
        const member = `${target}.${field.field}${
            field.index === undefined ? "" : `[${field.index}]`
        }`;
        return `${indent}${storeCpp(
            member,
            cpp,
            booleanValue(value, bindings) ? "bool" : "scalar",
        )}`;
    });
}

// ---------------------------------------------------------------------
// The lowered plan
// ---------------------------------------------------------------------

/** One generated function of the plan. */
interface PlanFunction {
    comment: string;
    returns: string;
    name: string;
    parameters: readonly string[];
    body: readonly string[];
}

function planFunctionCpp(plan: PlanFunction): string {
    return (
        `/** ${plan.comment} */\n` +
        `inline ${plan.returns} ${plan.name}(\n    ${plan.parameters.join(",\n    ")}) {\n` +
        `${plan.body.join("\n")}\n}`
    );
}

function generatorsProvenance(symbol: string): string {
    return (
        `\`${symbol}\` from @recast-navigation/generators@` +
        `${wrapperPackageVersion("@recast-navigation/generators")}, lowered from ` +
        "the installed package."
    );
}

function coreProvenance(symbol: string): string {
    return (
        `\`${symbol}\` from @recast-navigation/core@` +
        `${wrapperPackageVersion("@recast-navigation/core")}, lowered from ` +
        "the installed package."
    );
}

/** The `{ x, y, z }` record core's `vec3.fromArray`/`toArray` move. */
function assertVec3Conversions(): void {
    const core = wrapperModule(WRAPPER_CORE);
    const vec3 = unwrapExpression(variableInitializer(core, "vec3"));
    if (!ts.isObjectLiteralExpression(vec3)) {
        contractError(vec3, "Expected core's vec3 to be an object literal.");
    }
    const context = sharedPinnedContext();
    for (const [name, shape] of [
        ["fromArray", "([x, y, z]) => { return { x, y, z }; }"],
        ["toArray", "({ x, y, z }) => { return [x, y, z]; }"],
    ] as const) {
        context.assertExpressionShape(
            context.propertyInitializer(vec3, name),
            shape,
            `vec3.${name}`,
        );
    }
}

/** `getBoundingBox`: the bounds of the INDEXED positions, at double width. */
function boundingBoxFunction(): PlanFunction {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const arrow = blockArrow(file, "getBoundingBox", ["positions", "indices"]);
    assertVec3Conversions();
    const bindings = new Map<string, PinnedBinding>([
        ["positions", { cpp: "positions", type: "f32" }],
        ["indices", { cpp: "indices", type: "u32" }],
    ]);
    const lanes = (name: string, at: ts.Node): string => {
        const binding = bindings.get(name);
        if (binding?.type !== "vec3") {
            return contractError(
                at,
                `Expected getBoundingBox's ${name} record.`,
            );
        }
        return `{${["x", "y", "z"].map((axis) => `${binding.cpp}.${axis}`).join(", ")}}`;
    };
    const lowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: pinnedNumericMathCalls(),
        vec3Literal: (x, y, z) => `bbl::Vec3d{${x}, ${y}, ${z}}`,
        returnValue: (expression) => {
            if (!expression) {
                return contractError(
                    arrow,
                    "Expected getBoundingBox to return its bounds.",
                );
            }
            sharedPinnedContext().assertExpressionShape(
                expression,
                "{ bbMin: vec3.toArray(bbMin), bbMax: vec3.toArray(bbMax) }",
                "getBoundingBox's result",
            );
            return `bbl::pal::NavBounds{${lanes("bbMin", expression)}, ${lanes("bbMax", expression)}}`;
        },
    });
    return {
        comment: generatorsProvenance("getBoundingBox"),
        returns: "bbl::pal::NavBounds",
        name: "get_bounding_box",
        parameters: [
            "const std::vector<float>& positions",
            "const std::vector<std::uint32_t>& indices",
        ],
        body: lowerer.statements(arrow.body.statements, "    "),
    };
}

const PLAN_NAMES: Readonly<Record<BuildArm, string>> = {
    solo: "solo_nav_mesh",
    tileCache: "tile_cache_nav_mesh",
};

const PARAMS_PARAMETER = "const bbl::pal::NavMeshBuildParams& params";

/** `createRcConfig` over the arm's resolved spread. */
function rcConfigFunction(
    arm: BuildArm,
    generator: GeneratorConfig,
): PlanFunction {
    const core = wrapperModule(WRAPPER_CORE);
    const arrow = blockArrow(core, "createRcConfig", ["partialConfig"]);
    const statements = arrow.body.statements;
    const context = sharedPinnedContext();
    context.assertExpressionShape(
        declarationOf(statements, "config", arrow).declaration.initializer!,
        "{ ...recastConfigDefaults, ...partialConfig }",
        "createRcConfig's spread",
    );
    const creation = declarationOf(statements, "rcConfig", arrow);
    context.assertExpressionShape(
        creation.declaration.initializer!,
        "new Raw.Module.rcConfig()",
        "createRcConfig's record",
    );
    const fields = wrapperRcConfigFields();
    const bindings = new Map<string, PinnedBinding>([
        ["config", { cpp: "config", type: "opaque" }],
    ]);
    let readsParams = false;
    for (const read of findNodes(
        arrow.body,
        (node): node is ts.PropertyAccessExpression =>
            ts.isPropertyAccessExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === "config",
    )) {
        const key = read.name.text;
        const value = rcConfigValue(arm, key, generator);
        if (!value) {
            return contractError(
                read,
                `createRcConfig reads ${key}, which no layer of the ` +
                    `${GENERATORS[arm]} config holds.`,
            );
        }
        readsParams ||= value.readsParams;
        bindings.set(`config.${key}`, {
            cpp: value.cpp,
            type: value.type === "bool" ? "bool" : "scalar",
        });
    }
    const lowerer = new PinnedNumericLowerer(core, {
        bindings,
        calls: new Map(),
        statement: (statement, active, indent) => {
            if (statement === statements[creation.index]) {
                return [`${indent}bbl::pal::NavRcConfig rcConfig{};`];
            }
            const store = rawStore(statement);
            if (store?.owner !== "rcConfig") return undefined;
            if (!fields.scalars.has(store.field) || store.index !== undefined) {
                return contractError(
                    statement,
                    `createRcConfig stores rcConfig.${store.field}, which ` +
                        "cloneRcConfig does not copy.",
                );
            }
            return [
                `${indent}${storeCpp(
                    `rcConfig.${store.field}`,
                    active.expression(store.value),
                    booleanValue(store.value, bindings) ? "bool" : "scalar",
                )}`,
            ];
        },
        returnValue: (expression) => {
            if (expression?.getText() !== "rcConfig") {
                return contractError(
                    arrow,
                    "Expected createRcConfig to return rcConfig.",
                );
            }
            return "rcConfig";
        },
    });
    return {
        comment:
            `${coreProvenance("createRcConfig")} Its config is ` +
            `\`${GENERATORS[arm]}\`'s spread over the pinned cfg, resolved at generation.`,
        returns: "bbl::pal::NavRcConfig",
        name: `${PLAN_NAMES[arm]}_rc_config`,
        parameters: readsParams ? [PARAMS_PARAMETER] : [],
        body: lowerer.statements(statements, "    "),
    };
}

/** What a tile-cache build-config step hands the rest of the generator. */
const TILE_GRID = { width: "tileWidth", height: "tileHeight" } as const;

/**
 * One generator's build-config step: every statement between its
 * `createRcConfig` and the first library call after it. `calcGridSize` is a
 * library call too, and the one the step reads, so the PAL measures it and
 * passes it in -- the pin's order while no statement before it writes `cs`.
 */
function configStepFunction(
    arm: BuildArm,
    generator: GeneratorConfig,
): PlanFunction {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const context = sharedPinnedContext();
    const body: ts.Statement[] = [];
    for (const statement of generator.body.statements.slice(
        generator.creation.index + 1,
    )) {
        if (callsOutside(statement, new Set(["calcGridSize"]))) break;
        body.push(statement);
    }
    const config = generator.creation.config;
    const measures = body.flatMap((statement, index) => {
        const declaration =
            ts.isVariableStatement(statement) &&
            statement.declarationList.declarations.length === 1
                ? statement.declarationList.declarations[0]!
                : undefined;
        return declaration?.initializer &&
            ts.isIdentifier(declaration.name) &&
            context.expressionMatchesShape(
                declaration.initializer,
                `calcGridSize(bbMin, bbMax, ${config}.cs)`,
            )
            ? [{ index, statement, grid: declaration.name.text }]
            : [];
    });
    const [measure] = measures;
    if (measures.length !== 1 || !measure) {
        return contractError(
            generator.body,
            `Expected ${GENERATORS[arm]}'s build-config step to measure ` +
                `calcGridSize(bbMin, bbMax, ${config}.cs) once.`,
        );
    }
    const fields = wrapperRcConfigFields();
    for (const [index, statement] of body.entries()) {
        const store = rawStore(statement);
        if (store?.owner === config) {
            if (!fields.scalars.has(store.field) || store.index !== undefined) {
                contractError(
                    statement,
                    `rcConfig carries no scalar '${store.field}' field.`,
                );
            }
            if (store.field === "cs" && index < measure.index) {
                contractError(
                    statement,
                    `${GENERATORS[arm]} writes cs before calcGridSize reads ` +
                        "it; the PAL measures the grid from createRcConfig's cs.",
                );
            }
        } else if (
            hasNode(statement, (node) => {
                const target =
                    ts.isBinaryExpression(node) &&
                    node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
                    node.operatorToken.kind <= ts.SyntaxKind.LastAssignment
                        ? node.left
                        : (ts.isPrefixUnaryExpression(node) ||
                                ts.isPostfixUnaryExpression(node)) &&
                            (node.operator === ts.SyntaxKind.PlusPlusToken ||
                                node.operator === ts.SyntaxKind.MinusMinusToken)
                          ? node.operand
                          : undefined;
                return (
                    target !== undefined && propertyPath(target)?.[0] === config
                );
            })
        ) {
            contractError(
                statement,
                "Expected every rcConfig write in the build-config step to be " +
                    "a plain assignment statement.",
            );
        }
    }
    const bindings = new Map<string, PinnedBinding>([
        ...rcConfigReads(config, config),
        ...(["width", "height"] as const).map(
            (lane): [string, PinnedBinding] => [
                `${measure.grid}.${lane}`,
                {
                    cpp: `static_cast<double>(${measure.grid}.${lane})`,
                    type: "scalar",
                },
            ],
        ),
    ]);
    const lowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: pinnedNumericMathCalls(),
        statement: (statement, active, indent) => {
            if (statement === measure.statement) return [];
            const store = rawStore(statement);
            if (store?.owner !== config) return undefined;
            return [
                `${indent}${storeCpp(
                    `${config}.${store.field}`,
                    active.expression(store.value),
                    "scalar",
                )}`,
            ];
        },
    });
    const lines = lowerer.statements(body, "    ");
    let returns = "void";
    if (arm === "tileCache") {
        const [width, height] = [TILE_GRID.width, TILE_GRID.height].map(
            (local) => {
                const binding = bindings.get(local);
                if (!binding) {
                    return contractError(
                        generator.body,
                        `Expected ${GENERATORS[arm]}'s build-config step to ` +
                            `declare '${local}'.`,
                    );
                }
                return binding.cpp;
            },
        );
        returns = "bbl::pal::NavTileGrid";
        lines.push(`    return bbl::pal::NavTileGrid{${width}, ${height}};`);
    }
    return {
        comment:
            generatorsProvenance(`${GENERATORS[arm]}`) +
            " Its build-config step.",
        returns,
        name: `${PLAN_NAMES[arm]}_config`,
        parameters: [
            `bbl::pal::NavRcConfig& ${config}`,
            `const bbl::pal::NavGridSize& ${measure.grid}`,
        ],
        body: lines,
    };
}

/**
 * The `NavMeshCreateParams` setters PAL code performs itself: the poly-mesh
 * and detail-mesh copies are library data, and the off-mesh connections
 * are packed from the scene's own list.
 */
const PAL_CREATE_SETTERS: ReadonlySet<string> = new Set([
    "setPolyMeshCreateParams",
    "setPolyMeshDetailCreateParams",
    "setOffMeshConnections",
]);

/** `generateSoloNavMeshData`'s `NavMeshCreateParams` scalars. */
function soloCreateParamsFunction(generator: GeneratorConfig): PlanFunction {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const statements = generator.body.statements;
    const context = sharedPinnedContext();
    const start = declarationOf(
        statements,
        "navMeshCreateParams",
        generator.body,
    );
    context.assertExpressionShape(
        start.declaration.initializer!,
        "new NavMeshCreateParams()",
        "generateSoloNavMeshData's create params",
    );
    const end = declarationOf(
        statements,
        "createNavMeshDataResult",
        generator.body,
    );
    context.assertExpressionShape(
        end.declaration.initializer!,
        "createNavMeshData(navMeshCreateParams)",
        "generateSoloNavMeshData's navmesh data",
    );
    const setters = wrapperSetterFields("NavMeshCreateParams");
    const rcConfig = generator.creation.config;
    const bindings = new Map<string, PinnedBinding>(
        rcConfigReads(rcConfig, rcConfig),
    );
    let readsParams = false;
    for (const statement of statements.slice(start.index + 1, end.index)) {
        for (const read of findNodes(
            statement,
            (node): node is ts.PropertyAccessExpression =>
                ts.isPropertyAccessExpression(node) &&
                ts.isIdentifier(node.expression) &&
                node.expression.text === "config",
        )) {
            const value = generatorValue(
                "solo",
                read.name.text,
                generator.defaults,
            );
            if (!value) {
                return contractError(
                    read,
                    `No layer of the solo config holds ${read.name.text}.`,
                );
            }
            readsParams ||= value.readsParams;
            bindings.set(`config.${read.name.text}`, {
                cpp: value.cpp,
                type: value.type === "bool" ? "bool" : "scalar",
            });
        }
    }
    const lowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map(),
    });
    const lines = ["    bbl::pal::NavMeshCreateScalars navMeshCreateParams{};"];
    for (const statement of statements.slice(start.index + 1, end.index)) {
        const call =
            ts.isExpressionStatement(statement) &&
            ts.isCallExpression(statement.expression)
                ? statement.expression
                : undefined;
        const path = call ? propertyPath(call.expression) : undefined;
        if (call && path?.length === 2 && path[0] === "navMeshCreateParams") {
            const setter = path[1]!;
            const field = setters.get(setter);
            if (field && call.arguments.length === 1) {
                const value = call.arguments[0]!;
                lines.push(
                    `    ${storeCpp(
                        `navMeshCreateParams.${field}`,
                        lowerer.expression(value),
                        booleanValue(value, bindings) ? "bool" : "scalar",
                    )}`,
                );
                continue;
            }
            if (PAL_CREATE_SETTERS.has(setter)) continue;
        }
        if (
            ts.isIfStatement(statement) &&
            context.expressionMatchesShape(
                statement.expression,
                "navMeshGeneratorConfig.offMeshConnections",
            )
        ) {
            continue;
        }
        return contractError(
            statement,
            "Expected generateSoloNavMeshData's create params to be set " +
                "through NavMeshCreateParams' own setters.",
        );
    }
    lines.push("    return navMeshCreateParams;");
    return {
        comment:
            generatorsProvenance("generateSoloNavMeshData") +
            " Its NavMeshCreateParams scalars.",
        returns: "bbl::pal::NavMeshCreateScalars",
        name: "solo_nav_mesh_create_params",
        parameters: [
            `const bbl::pal::NavRcConfig& ${rcConfig}`,
            ...(readsParams ? [PARAMS_PARAMETER] : []),
        ],
        body: lines,
    };
}

/**
 * The tile-cache generator's own locals the Detour records read: the input
 * bounds, the tile grid and the two keys destructured out of the config.
 */
function tileCacheBindings(generator: GeneratorConfig): {
    bindings: Map<string, PinnedBinding>;
    readsParams: boolean;
} {
    const config = generator.creation.config;
    const bindings = new Map<string, PinnedBinding>([
        ...rcConfigReads(config, config),
        ["bbMin", { cpp: "bounds.min", type: "f64-buffer" }],
        ["bbMax", { cpp: "bounds.max", type: "f64-buffer" }],
        [TILE_GRID.width, { cpp: "tiles.width", type: "scalar" }],
        [TILE_GRID.height, { cpp: "tiles.height", type: "scalar" }],
    ]);
    let readsParams = false;
    for (const key of generator.excluded) {
        const value = generatorValue("tileCache", key, generator.defaults);
        if (!value) {
            return contractError(
                generator.body,
                `No layer of the tile-cache config holds ${key}.`,
            );
        }
        readsParams ||= value.readsParams;
        bindings.set(key, { cpp: value.cpp, type: "scalar" });
    }
    return { bindings, readsParams };
}

function tileCacheParameters(
    generator: GeneratorConfig,
    readsParams: boolean,
): string[] {
    return [
        `const bbl::pal::NavRcConfig& ${generator.creation.config}`,
        "const bbl::pal::NavBounds& bounds",
        "const bbl::pal::NavTileGrid& tiles",
        ...(readsParams ? [PARAMS_PARAMETER] : []),
    ];
}

/** `DetourTileCacheParams.create({ ... })` in `generateTileCache`. */
function tileCacheParamsFunction(generator: GeneratorConfig): PlanFunction {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const { declaration } = declarationOf(
        generator.body.statements,
        "tileCacheParams",
        generator.body,
    );
    const call = unwrapExpression(declaration.initializer!);
    if (!ts.isCallExpression(call)) {
        return contractError(call, "Expected tileCacheParams to be created.");
    }
    const { bindings, readsParams } = tileCacheBindings(generator);
    const lowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: new Map(),
    });
    return {
        comment:
            generatorsProvenance("generateTileCache") +
            " Its DetourTileCacheParams.",
        returns: "bbl::pal::NavTileCacheParams",
        name: "tile_cache_params",
        parameters: tileCacheParameters(generator, readsParams),
        body: [
            "    bbl::pal::NavTileCacheParams tileCacheParams{};",
            ...lowerCreate(
                call,
                "DetourTileCacheParams",
                "tileCacheParams",
                lowerer,
                bindings,
                "    ",
            ),
            "    return tileCacheParams;",
        ],
    };
}

/** The generators' own `dtIlog2`/`dtNextPow2`, which the tile bit split calls. */
const DETOUR_BIT_HELPERS = [
    ["dtIlog2", "dt_ilog2"],
    ["dtNextPow2", "dt_next_pow2"],
] as const;

function bitHelperFunction(name: string, cppName: string): PlanFunction {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const arrow = blockArrow(file, name, ["v"]);
    const calls = new Map([
        [
            "Number",
            (args: readonly string[]): string => {
                if (args.length !== 1) {
                    return contractError(
                        arrow,
                        `Expected ${name}'s Number(...) to take one value.`,
                    );
                }
                return `static_cast<double>(${args[0]})`;
            },
        ],
    ]);
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        bindings: new Map([["v", { cpp: "v", type: "scalar" }]]),
        calls,
        returnValue: (expression) => {
            if (!expression) {
                return contractError(
                    arrow,
                    `Expected ${name} to return a number.`,
                );
            }
            return lowerer.expression(expression);
        },
    });
    return {
        comment: generatorsProvenance(name),
        returns: "double",
        name: cppName,
        parameters: ["double v"],
        body: lowerer.statements(arrow.body.statements, "    "),
    };
}

/**
 * `generateTileCache`'s tile/poly bit split and its `NavMeshParams.create`:
 * the statements from `vec3.fromArray(bbMin)` to the params it creates.
 */
function tileNavMeshParamsFunction(generator: GeneratorConfig): PlanFunction {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const statements = generator.body.statements;
    const context = sharedPinnedContext();
    const origin = declarationOf(statements, "orig", generator.body);
    context.assertExpressionShape(
        origin.declaration.initializer!,
        "vec3.fromArray(bbMin)",
        "generateTileCache's navmesh origin",
    );
    const params = declarationOf(statements, "navMeshParams", generator.body);
    const slice = statements.slice(origin.index, params.index + 1);
    const helpers = new Set<string>(DETOUR_BIT_HELPERS.map(([name]) => name));
    for (const statement of slice.slice(1, -1)) {
        if (callsOutside(statement, helpers)) {
            return contractError(
                statement,
                "Expected generateTileCache's tile bit split to call no library.",
            );
        }
    }
    const { bindings, readsParams } = tileCacheBindings(generator);
    const calls = pinnedNumericMathCalls();
    for (const [name, cppName] of DETOUR_BIT_HELPERS) {
        calls.set(name, (args) => {
            if (args.length !== 1) {
                return contractError(
                    origin.declaration,
                    `Expected ${name} to take one value.`,
                );
            }
            return `${cppName}(${args[0]})`;
        });
    }
    const lowerer: PinnedNumericLowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls,
        statement: (statement, active, indent) => {
            if (statement === slice[0]) {
                bindings.set("orig", { cpp: "orig", type: "vec3" });
                return [
                    `${indent}const bbl::Vec3d orig{bounds.min[0], bounds.min[1], bounds.min[2]};`,
                ];
            }
            if (statement === slice.at(-1)) {
                const call = unwrapExpression(params.declaration.initializer!);
                if (!ts.isCallExpression(call)) {
                    return contractError(
                        call,
                        "Expected navMeshParams to be created.",
                    );
                }
                return [
                    `${indent}bbl::pal::NavTiledMeshParams navMeshParams{};`,
                    ...lowerCreate(
                        call,
                        "NavMeshParams",
                        "navMeshParams",
                        active,
                        bindings,
                        indent,
                    ),
                ];
            }
            return undefined;
        },
    });
    return {
        comment:
            generatorsProvenance("generateTileCache") +
            " Its tile/poly bit split and NavMeshParams.",
        returns: "bbl::pal::NavTiledMeshParams",
        name: "tile_cache_nav_mesh_params",
        parameters: tileCacheParameters(generator, readsParams),
        body: [
            ...lowerer.statements(slice, "    "),
            "    return navMeshParams;",
        ],
    };
}

/** Core's `cloneRcConfig`, which each tile's config starts from. */
function cloneRcConfigFunction(): PlanFunction {
    const core = wrapperModule(WRAPPER_CORE);
    const arrow = blockArrow(core, "cloneRcConfig", ["rcConfig"]);
    const statements = arrow.body.statements;
    const fields = wrapperRcConfigFields();
    const bindings = new Map<string, PinnedBinding>(
        rcConfigReads("rcConfig", "rcConfig"),
    );
    const calls = new Map<string, (args: readonly string[]) => string>();
    for (const [field] of fields.arrays) {
        calls.set(`rcConfig.get_${field}`, (args) => {
            if (args.length !== 1) {
                return contractError(
                    arrow,
                    `Expected rcConfig.get_${field} to take one index.`,
                );
            }
            return `static_cast<double>(rcConfig.${field}[static_cast<std::size_t>(${args[0]})])`;
        });
    }
    const lowerer = new PinnedNumericLowerer(core, {
        bindings,
        calls,
        statement: (statement, active, indent) => {
            if (statement === statements[0]) {
                return [`${indent}bbl::pal::NavRcConfig clone{};`];
            }
            const store = rawStore(statement);
            if (store?.owner !== "clone") return undefined;
            const member = `clone.${store.field}${
                store.index === undefined ? "" : `[${store.index}]`
            }`;
            return [
                `${indent}${storeCpp(member, active.expression(store.value), "scalar")}`,
            ];
        },
        returnValue: () => "clone",
    });
    return {
        comment: coreProvenance("cloneRcConfig"),
        returns: "bbl::pal::NavRcConfig",
        name: "clone_rc_config",
        parameters: ["const bbl::pal::NavRcConfig& rcConfig"],
        body: lowerer.statements(statements, "    "),
    };
}

/** `generateTileCache`'s per-tile rasterizer, the arrow each tile runs. */
function rasterizeTileLayers(generator: GeneratorConfig): BlockArrow {
    return blockArrow(generator.body, "rasterizeTileLayers", [
        "tileX",
        "tileY",
    ]);
}

/**
 * One tile's config: `rasterizeTileLayers` up to its first library call --
 * the clone and the tile's bounds, padded by the border and stored as the
 * clone's `bmin`/`bmax`. The float bounds Recast rasterizes the tile into
 * and the rect it queries chunks with are those same stores.
 */
function tileConfigFunction(generator: GeneratorConfig): PlanFunction {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const arrow = rasterizeTileLayers(generator);
    const statements = arrow.body.statements;
    const context = sharedPinnedContext();
    const [bookkeeping] = statements;
    const intermediates = declarationOf(statements, "tileIntermediates", arrow);
    if (bookkeeping !== statements[intermediates.index]) {
        return contractError(
            arrow,
            "Expected rasterizeTileLayers to open with its intermediates.",
        );
    }
    context.assertExpressionShape(
        intermediates.declaration.initializer!,
        "{ tileX, tileY }",
        "rasterizeTileLayers' intermediates",
    );
    const config = generator.creation.config;
    const clone = declarationOf(statements, "tileConfig", arrow);
    context.assertExpressionShape(
        clone.declaration.initializer!,
        `cloneRcConfig(${config})`,
        "rasterizeTileLayers' tile config",
    );
    const slice: ts.Statement[] = [];
    for (const statement of statements.slice(1)) {
        if (
            callsOutside(statement, new Set(["cloneRcConfig"])) &&
            rawStore(statement)?.owner !== "tileConfig"
        ) {
            break;
        }
        slice.push(statement);
    }
    const bindings = new Map<string, PinnedBinding>([
        ...rcConfigReads(config, config),
        ["bbMin", { cpp: "bounds.min", type: "f64-buffer" }],
        ["bbMax", { cpp: "bounds.max", type: "f64-buffer" }],
        ["tileX", { cpp: "tileX", type: "scalar" }],
        ["tileY", { cpp: "tileY", type: "scalar" }],
    ]);
    const fields = wrapperRcConfigFields();
    const lowerer = new PinnedNumericLowerer(file, {
        bindings,
        calls: pinnedNumericMathCalls(),
        statement: (statement, active, indent) => {
            if (statement === statements[clone.index]) {
                for (const [text, binding] of rcConfigReads(
                    "tileConfig",
                    "tileConfig",
                )) {
                    bindings.set(text, binding);
                }
                return [
                    `${indent}bbl::pal::NavRcConfig tileConfig = clone_rc_config(${config});`,
                ];
            }
            const store = rawStore(statement);
            if (store?.owner !== "tileConfig") return undefined;
            const known =
                store.index === undefined
                    ? fields.scalars.has(store.field)
                    : store.index < (fields.arrays.get(store.field) ?? 0);
            if (!known) {
                return contractError(
                    statement,
                    `rcConfig carries no '${store.field}' to store.`,
                );
            }
            const member = `tileConfig.${store.field}${
                store.index === undefined ? "" : `[${store.index}]`
            }`;
            return [
                `${indent}${storeCpp(member, active.expression(store.value), "scalar")}`,
            ];
        },
    });
    return {
        comment:
            generatorsProvenance("generateTileCache") +
            " rasterizeTileLayers' tile config and bounds.",
        returns: "bbl::pal::NavRcConfig",
        name: "tile_cache_tile_config",
        parameters: [
            `const bbl::pal::NavRcConfig& ${config}`,
            "const bbl::pal::NavBounds& bounds",
            "double tileX",
            "double tileY",
        ],
        body: [...lowerer.statements(slice, "    "), "    return tileConfig;"],
    };
}

/**
 * The three sizes the tile arm names inline: the linear allocator's
 * capacity, the chunky mesh's triangles per chunk and the chunk ids a tile
 * rect query holds.
 */
function tileCacheSizes(generator: GeneratorConfig): {
    linearAllocatorCapacity: number;
    trisPerChunk: number;
    maxChunkIds: number;
} {
    const file = wrapperModule(WRAPPER_GENERATORS);
    const allocators = findNodes(
        generator.body,
        (node): node is ts.NewExpression =>
            ts.isNewExpression(node) &&
            node.expression.getText() === "Raw.RecastLinearAllocator",
    );
    const chunks = findNodes(
        generator.body,
        (node): node is ts.CallExpression =>
            ts.isCallExpression(node) &&
            node.expression.getText() === "chunkyTriMesh.init",
    );
    const [allocator] = allocators;
    const [chunk] = chunks;
    const capacity = allocator?.arguments?.[0];
    if (
        allocators.length !== 1 ||
        allocator?.arguments?.length !== 1 ||
        !capacity ||
        chunks.length !== 1 ||
        !chunk ||
        chunk.arguments.length !== 4 ||
        chunk.arguments
            .slice(0, 3)
            .map((argument) => argument.getText())
            .join(", ") !== "verticesArray, trianglesArray, numTriangles"
    ) {
        return contractError(
            generator.body,
            "Expected generateTileCache to size one linear allocator and one " +
                "chunky mesh over its own vertex and triangle arrays.",
        );
    }
    const maxChunkIds = variableInitializer(
        rasterizeTileLayers(generator).body,
        "maxChunkIds",
    );
    return {
        linearAllocatorCapacity: numericValue(capacity, file),
        trisPerChunk: numericValue(chunk.arguments[3]!, file),
        maxChunkIds: numericValue(maxChunkIds, file),
    };
}

/**
 * The generated build plan for the given arms: the shared bounds, then each
 * arm's functions and the builder that composes them in the generator's
 * own order. `navigation.hpp` carries the arm a scene reached; a fixture
 * that drives both carries both.
 */
export function navigationBuildPlanDeclarations(
    arms: readonly BuildArm[],
): string {
    const functions: PlanFunction[] = [boundingBoxFunction()];
    const builders: string[] = [];
    for (const arm of arms) {
        const generator = generatorConfig(arm);
        const rcConfig = rcConfigFunction(arm, generator);
        const step = configStepFunction(arm, generator);
        functions.push(rcConfig, step);
        const call = (plan: PlanFunction, args: readonly string[]): string =>
            `${plan.name}(${args.slice(0, plan.parameters.length).join(", ")})`;
        const grid =
            "bbl::pal::navigation_grid_size(build.bounds, build.config.cs)";
        if (arm === "solo") {
            const create = soloCreateParamsFunction(generator);
            functions.push(create);
            builders.push(
                planFunctionCpp({
                    comment:
                        "`generateSoloNavMeshData`'s plan, in its own order, for the PAL build.",
                    returns: "bbl::pal::NavSoloBuild",
                    name: "solo_nav_mesh_build",
                    parameters: [
                        "const bbl::pal::NavMeshGeometry& merged",
                        PARAMS_PARAMETER,
                    ],
                    body: [
                        "    bbl::pal::NavSoloBuild build{};",
                        "    build.bounds = get_bounding_box(merged.positions, merged.indices);",
                        `    build.config = ${call(rcConfig, ["params"])};`,
                        `    ${step.name}(build.config, ${grid});`,
                        `    build.create = ${call(create, ["build.config", "params"])};`,
                        "    return build;",
                    ],
                }),
            );
            continue;
        }
        const helpers = DETOUR_BIT_HELPERS.map(([name, cppName]) =>
            bitHelperFunction(name, cppName),
        );
        const cache = tileCacheParamsFunction(generator);
        const mesh = tileNavMeshParamsFunction(generator);
        const tile = tileConfigFunction(generator);
        const sizes = tileCacheSizes(generator);
        functions.push(...helpers, cache, mesh, cloneRcConfigFunction(), tile);
        const tileArgs = [
            "build.config",
            "build.bounds",
            "build.tiles",
            "params",
        ];
        builders.push(
            planFunctionCpp({
                comment:
                    "`generateTileCache`'s plan, in its own order, for the PAL build.",
                returns: "bbl::pal::NavTileCacheBuild",
                name: "tile_cache_nav_mesh_build",
                parameters: [
                    "const bbl::pal::NavMeshGeometry& merged",
                    PARAMS_PARAMETER,
                ],
                body: [
                    "    bbl::pal::NavTileCacheBuild build{};",
                    "    build.bounds = get_bounding_box(merged.positions, merged.indices);",
                    `    build.config = ${call(rcConfig, ["params"])};`,
                    `    build.tiles = ${step.name}(build.config, ${grid});`,
                    `    build.cache = ${call(cache, tileArgs)};`,
                    `    build.mesh = ${call(mesh, tileArgs)};`,
                    `    build.tile_config = ${tile.name};`,
                    `    build.linear_allocator_capacity = ${doubleLiteral(sizes.linearAllocatorCapacity)};`,
                    `    build.tris_per_chunk = ${doubleLiteral(sizes.trisPerChunk)};`,
                    `    build.max_chunk_ids = ${doubleLiteral(sizes.maxChunkIds)};`,
                    "    return build;",
                ],
            }),
        );
    }
    return [...functions.map(planFunctionCpp), ...builders].join("\n");
}
