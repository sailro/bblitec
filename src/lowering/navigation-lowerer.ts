/**
 * The navigation family, lowered from `src/navigation/navigation.ts`.
 *
 * The pin draws the same line physics does: everything in the pinned
 * module is Babylon behaviour written against the `@recast-navigation`
 * wrapper surface, and that surface is the PAL's
 * (`bblite/pal_navigation.hpp`), implemented against the very
 * recastnavigation commit the wrapper's wasm compiles. Unlike physics,
 * nothing is substituted: the two sides run the same library, so the
 * navmesh and its queries are expected to agree with the browser up to
 * float rounding.
 *
 * What this lowerer emits is the pinned module's own logic:
 *
 * - `_mergeMeshes`: each mesh's CPU positions through its worldMatrix,
 *   merged with a running vertex base, and index winding reversed
 *   (i, i+2, i+1). The native loader bakes the pin's own mirrored
 *   world into its vertices (measured: the baked stream equals the
 *   pin's merged stream on the nav asset), so the emitted merge passes
 *   the baked positions through, asserted against the pin's own
 *   multiply rows.
 * - `_createNavMeshFromMerged`'s dispatch: the tile-cache and tiled
 *   arms refuse by name (their record plumbing does not exist yet); the
 *   solo arm hands the merged geometry and the present-key config to
 *   the PAL, whose build replays `generateSoloNavMesh` — and the
 *   wrapper's config defaults the build fills absent keys from are read
 *   from the installed packages and emitted into the header it takes
 *   them from, under the package versions they came from.
 * - `createDebugNavMeshGeometry` and `raycast` pass through to the PAL
 *   arms that carry their pinned arithmetic; the shapes here assert the
 *   pin still spells them the way those arms do.
 * - `getClosestPoint`, `createNavCrowd`, `addAgent` and
 *   `getAgentPosition` are the same shape one level up: the wrapper
 *   surface is the PAL's, and what the pinned module adds on top — the
 *   three `?? N` agent-parameter defaults, the `{0,0,0}` an absent agent
 *   reads as — is emitted here. The query every build arm ends with is the
 *   wrapper's `NavMeshQuery`: its node pool and default search box are
 *   read from the installed package with the build defaults, and the
 *   pinned module's own explicit search box is proved to be that box.
 */
import ts from "typescript";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
    LoweredSource,
    LoweringContext,
    numericValue,
    propertyName,
    sharedPinnedContext,
    unwrapExpression,
    variableInitializer,
} from "./context.js";
import { pinnedHeader } from "./pinned-header.js";
import { pinnedOptionFallback } from "./pinned-option-defaults.js";
import { doubleLiteral } from "../cpp-literals.js";
import { recordAt } from "../compiler/record-access.js";

const NAVIGATION_MODULE = "src/navigation/navigation.ts";
const WRAPPER_CORE = "@recast-navigation/core/dist/index.mjs";

/**
 * `recastConfigDefaults` from the installed `@recast-navigation/core`,
 * pinned exact in package.json.
 */
function pinnedRecastConfigDefaults(): ReadonlyMap<string, number> {
    return wrapperNumericDefaults("recastConfigDefaults", WRAPPER_CORE);
}

/**
 * `NavMeshQuery`'s own two defaults, from the installed core package: the
 * `params?.maxNodes ?? <n>` its constructor initializes the Detour query
 * with, and its `defaultQueryHalfExtents` field, the box every query that
 * names none searches (`computePath`'s endpoints, a crowd agent's move
 * target).
 */
function pinnedNavMeshQueryDefaults(): {
    maxNodes: number;
    halfExtents: readonly [number, number, number];
} {
    const file = wrapperModule(WRAPPER_CORE);
    const query = file.statements.find(
        (statement): statement is ts.ClassDeclaration =>
            ts.isClassDeclaration(statement) &&
            statement.name?.text === "NavMeshQuery",
    );
    const extents = query?.members.find(
        (member): member is ts.PropertyDeclaration =>
            ts.isPropertyDeclaration(member) &&
            propertyName(member.name) === "defaultQueryHalfExtents",
    )?.initializer;
    const constructor = query?.members.find(ts.isConstructorDeclaration);
    if (!extents || !constructor) {
        throw new Error(
            `${WRAPPER_CORE} no longer declares NavMeshQuery with a ` +
                "defaultQueryHalfExtents field and a constructor.",
        );
    }
    const maxNodes = numericValue(
        pinnedOptionFallback(sharedPinnedContext(), constructor, {
            member: "maxNodes",
        }),
        file,
    );
    const label = "NavMeshQuery.defaultQueryHalfExtents";
    return {
        maxNodes,
        halfExtents: vectorLanes(numericObject(extents, file, label), label),
    };
}

/** An `{ x, y, z }` record's three numbers, refusing any other key set. */
function vectorLanes(
    lanes: ReadonlyMap<string, number>,
    label: string,
): readonly [number, number, number] {
    const [x, y, z] = (["x", "y", "z"] as const).map((axis) => lanes.get(axis));
    if (
        lanes.size !== 3 ||
        x === undefined ||
        y === undefined ||
        z === undefined
    ) {
        throw new Error(`${label} is no longer an { x, y, z } of numbers.`);
    }
    return [x, y, z];
}

/**
 * `tileCacheGeneratorConfigDefaults`' own three, which live in the
 * generators package rather than core.
 *
 * It spreads `recastConfigDefaults` and then adds `tileSize`,
 * `expectedLayersPerTile` and `maxObstacles`; a spread carries no property
 * assignment, so what this reads is exactly the arm's own.
 */
function pinnedTileCacheDefaults(): ReadonlyMap<string, number> {
    return wrapperNumericDefaults(
        "tileCacheGeneratorConfigDefaults",
        "@recast-navigation/generators/dist/index.mjs",
    );
}

/**
 * `bbl::pal::NavBuildDefaults` (bblite/pal_navigation.hpp) field by field
 * in declaration order, by the `recastConfigDefaults` key each carries.
 * A key the package grows or drops refuses: the build would miss it, or
 * read one the package no longer states.
 */
const RECAST_CONFIG_FIELDS: readonly (readonly [string, string])[] = [
    ["borderSize", "border_size"],
    ["tileSize", "tile_size"],
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
];

/** The installed version of one `@recast-navigation` package. */
function wrapperPackageVersion(name: string): string {
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

/**
 * The wrapper's build defaults as the PAL build takes them
 * (`bbl::pal::NavBuildDefaults`), read from the installed packages and
 * stamped with the versions they came from.
 *
 * Only one of `tileCacheGeneratorConfigDefaults`' own three reaches the
 * build: `tileSize` and `maxObstacles` are what generation proves before
 * the tile-cache arm is chosen at all, so a default for either would
 * answer a question already asked.
 */
export function navigationBuildDefaultsDeclaration(): string {
    const config = pinnedRecastConfigDefaults();
    if (
        config.size !== RECAST_CONFIG_FIELDS.length ||
        RECAST_CONFIG_FIELDS.some(([key]) => !config.has(key))
    ) {
        throw new Error(
            "@recast-navigation/core's recastConfigDefaults names " +
                `[${[...config.keys()].join(", ")}], but ` +
                "bbl::pal::NavBuildDefaults carries " +
                `[${RECAST_CONFIG_FIELDS.map(([key]) => key).join(", ")}].`,
        );
    }
    const expectedLayers = pinnedTileCacheDefaults().get(
        "expectedLayersPerTile",
    );
    if (expectedLayers === undefined) {
        throw new Error(
            "@recast-navigation/generators' tileCacheGeneratorConfigDefaults " +
                "no longer defaults expectedLayersPerTile.",
        );
    }
    const query = pinnedNavMeshQueryDefaults();
    const fields = [
        ...RECAST_CONFIG_FIELDS.map(
            ([key, field]) =>
                `    .${field} = ${doubleLiteral(config.get(key)!)},`,
        ),
        `    .expected_layers_per_tile = ${doubleLiteral(expectedLayers)},`,
        `    .query_max_nodes = ${doubleLiteral(query.maxNodes)},`,
        `    .query_half_extents = {${query.halfExtents.map(doubleLiteral).join(", ")}},`,
    ];
    return `/**
 * \`recastConfigDefaults\` and \`NavMeshQuery\`'s \`maxNodes\` and
 * \`defaultQueryHalfExtents\` from @recast-navigation/core@${wrapperPackageVersion("@recast-navigation/core")}, and
 * \`tileCacheGeneratorConfigDefaults.expectedLayersPerTile\` from
 * @recast-navigation/generators@${wrapperPackageVersion("@recast-navigation/generators")}, read from the installed packages.
 */
inline constexpr bbl::pal::NavBuildDefaults navigation_build_defaults{
${fields.join("\n")}
};`;
}

/**
 * The PAL `NavAgentParams` byte field each `AgentParameters` flag lands
 * in. Which of them the pinned `addAgent` defaults, and to what, is its
 * own: `pinnedAgentParamDefaults` reads them.
 */
const AGENT_BYTE_FIELDS: ReadonlyMap<string, string> = new Map([
    ["updateFlags", "update_flags"],
    ["obstacleAvoidanceType", "obstacle_avoidance_type"],
    ["queryFilterType", "query_filter_type"],
]);

let agentDefaults: readonly (readonly [string, string, number])[] | undefined;

/**
 * The `AgentParameters` fields the pinned `addAgent` resolves with a
 * `?? <default>` before the wrapper's spread ever sees them: the pinned
 * name, the PAL field it lands in, and the pin's number, read from each
 * `<name>: params.<name> ?? <N>` property of its `agentParams` record.
 * `intrinsics/navigation.ts` emits these numbers where a scene leaves
 * the field out.
 */
export function pinnedAgentParamDefaults(): readonly (readonly [
    string,
    string,
    number,
])[] {
    if (agentDefaults) return agentDefaults;
    const context: LoweringContext = sharedPinnedContext();
    const { file, declaration } = context.functionDeclaration(
        NAVIGATION_MODULE,
        "addAgent",
    );
    const agentParams = context.objectInitializer(declaration, "agentParams");
    const defaults: (readonly [string, string, number])[] = [];
    for (const property of agentParams.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const nullish = context.nullishDefault(property.initializer);
        if (!nullish) continue;
        const name = context.propertyName(property.name);
        const path = context.propertyPath(nullish.left);
        const field = name ? AGENT_BYTE_FIELDS.get(name) : undefined;
        if (!name || path?.join(".") !== `params.${name}` || !field) {
            context.contractError(
                property,
                "Expected addAgent to default only the agent parameter " +
                    `bytes [${[...AGENT_BYTE_FIELDS.keys()].join(", ")}], ` +
                    "each from its own params field.",
            );
        }
        defaults.push([name, field, context.numericValue(nullish.right, file)]);
    }
    if (defaults.length !== AGENT_BYTE_FIELDS.size) {
        context.contractError(
            agentParams,
            "Expected addAgent to default every agent parameter byte " +
                `[${[...AGENT_BYTE_FIELDS.keys()].join(", ")}].`,
        );
    }
    agentDefaults = defaults;
    return defaults;
}

const wrapperModules = new Map<string, ts.SourceFile>();

/** One installed `@recast-navigation` module's syntax tree, parsed once. */
function wrapperModule(moduleSpecifier: string): ts.SourceFile {
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

function wrapperNumericDefaults(
    variableName: string,
    moduleSpecifier: string,
): ReadonlyMap<string, number> {
    const file = wrapperModule(moduleSpecifier);
    return numericObject(
        variableInitializer(file, variableName),
        file,
        `${moduleSpecifier}'s ${variableName}`,
    );
}

/** An object literal of plain numeric properties, by key. */
function numericObject(
    initializer: ts.Expression,
    file: ts.SourceFile,
    label: string,
): ReadonlyMap<string, number> {
    const literal = unwrapExpression(initializer);
    if (!ts.isObjectLiteralExpression(literal)) {
        throw new Error(`${label} is no longer an object literal.`);
    }
    const defaults = new Map<string, number>();
    for (const property of literal.properties) {
        // A table built by spreading another one contributes its OWN keys
        // here and nothing else, which is what makes the tile-cache arm's
        // three readable apart from the solo defaults they extend.
        if (ts.isSpreadAssignment(property)) {
            continue;
        }
        if (
            !ts.isPropertyAssignment(property) ||
            !ts.isIdentifier(property.name)
        ) {
            throw new Error(`${label} no longer holds plain numeric defaults.`);
        }
        defaults.set(
            property.name.text,
            numericValue(property.initializer, file),
        );
    }
    return defaults;
}

export class NavigationLowerer {
    public constructor(private readonly context: LoweringContext) {}

    /**
     * @param tileCache Whether a reached `createNavMesh` asked for
     * obstacles. Generation decided the build arm; this is that decision
     * arriving, so the emitted source carries one call and one surface
     * rather than a run-time test of a fact already settled.
     */
    public lowerNavigation(tileCache: boolean): LoweredSource {
        const modulePath = NAVIGATION_MODULE;
        const symbolName = "createNavMesh";

        // _mergeMeshes: the world multiply rows and the winding reversal
        // the emitted merge folds. The pin's worldMatrix is applied as
        // three dot-product rows; the emitted pass-through stands on
        // those rows being exactly the mirrored product the native bake
        // already performed, so the rows are the anchor.
        const { declaration: merge } = this.context.functionDeclaration(
            modulePath,
            "_mergeMeshes",
        );
        for (const [lane, row] of [
            ["x", "x * wm[0] + y * wm[4] + z * wm[8] + wm[12]"],
            ["y", "x * wm[1] + y * wm[5] + z * wm[9] + wm[13]"],
            ["z", "x * wm[2] + y * wm[6] + z * wm[10] + wm[14]"],
        ] as const) {
            this.context.expectShapeCount(
                merge,
                row,
                `the merge world-matrix ${lane} row`,
            );
        }
        // The reversed triple: indices (i, i+2, i+1) plus the vertex
        // base. The lead shape counts twice because the pin's
        // `doNotReverseIndices` arm is a straight per-index copy of the
        // same expression; the intrinsic refuses that option, which is
        // what makes the reversed triple the arm this emission mirrors.
        for (const [shape, count] of [
            ["meshIdx[i] + vertBase", 2],
            ["meshIdx[i + 2] + vertBase", 1],
            ["meshIdx[i + 1] + vertBase", 1],
        ] as const) {
            this.context.expectShapeCount(
                merge,
                shape,
                "the merge winding arms over a running vertex base",
                count,
            );
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(merge, "vertBase"),
            "0",
            "Merge vertex base start",
        );

        // The other arm of `mesh.worldMatrix`: a scene-code mesh carries
        // no parent, so `getWorldMatrix` returns its local TRS
        // unmultiplied and the merge's rows read that matrix directly.
        // The identity short-circuit is bit-equal to composing an
        // identity transform, so the emitted composition covers both.
        const { declaration: composeLocal } = this.context.functionDeclaration(
            "src/scene/world-matrix-state.ts",
            "composeTrsLocalMatrixIntoBuffer",
        );
        this.context.expectShapeCount(
            composeLocal,
            "composeMat4IntoBuffer(local, 0, position.x, position.y, position.z, rotation.x, rotation.y, rotation.z, rotation.w, scaling.x, scaling.y, scaling.z)",
            "the unparented local world matrix",
        );

        // _createNavMeshFromMerged: the dispatch this emission mirrors.
        const { declaration: fromMerged } = this.context.functionDeclaration(
            modulePath,
            "_createNavMeshFromMerged",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(fromMerged, "needsTileCache"),
            "(params.maxObstacles ?? 0) > 0",
            "Tile-cache dispatch",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(fromMerged, "needsTiled"),
            "(params.tileSize ?? 0) > 0",
            "Tiled dispatch",
        );
        if (
            !this.context.hasCall(fromMerged, "generateSoloNavMesh") &&
            !this.context.hasNode(
                fromMerged,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "generateSoloNavMesh",
            )
        ) {
            this.context.contractError(
                fromMerged,
                "Expected the solo arm to build through generateSoloNavMesh.",
            );
        }

        // raycast: nearest poly then 0 < t < 1, the PAL arm's contract.
        const { declaration: raycast } = this.context.functionDeclaration(
            modulePath,
            "raycast",
        );
        if (
            !this.context.hasNode(
                raycast,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "findNearestPoly",
            )
        ) {
            this.context.contractError(
                raycast,
                "Expected raycast to resolve the start polygon first.",
            );
        }
        this.context.assertExpressionShape(
            this.context.variableInitializer(raycast, "t"),
            "r?.t ?? 0",
            "Raycast parameter read",
        );
        if (
            !this.context.hasNode(raycast, (node) =>
                this.context.expressionMatchesShape(
                    node as ts.Expression,
                    "!(t > 0 && t < 1)",
                ),
            )
        ) {
            this.context.contractError(
                raycast,
                "Expected the hit window to stay 0 < t < 1.",
            );
        }
        for (const lane of ["x", "y", "z"] as const) {
            if (
                !this.context.hasNode(raycast, (node) =>
                    this.context.expressionMatchesShape(
                        node as ts.Expression,
                        `start.${lane} + (end.${lane} - start.${lane}) * t`,
                    ),
                )
            ) {
                this.context.contractError(
                    raycast,
                    `Expected the hit point to lerp ${lane}.`,
                );
            }
        }

        // getClosestPoint: the pinned half-extents and the point read
        // straight off the result. The pin inspects no status here —
        // `findClosestPointWithin` is the arm that does — so the
        // emitted wrapper passes the PAL's point through the same way.
        const { declaration: closestPoint } = this.context.functionDeclaration(
            modulePath,
            "getClosestPoint",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(closestPoint, "res"),
            "plugin._navMeshQuery.findClosestPoint(position, { halfExtents: _tmpHalfExtents })",
            "Closest-point query",
        );
        // The pinned module names its own box, `_tmpHalfExtents`, at every
        // query it makes; the PAL searches the one box the wrapper's query
        // defaults to, which is only the pin's while the two agree.
        const navigationFile = this.context.sourceFile(modulePath);
        const pinnedBox = this.context.variableInitializer(
            navigationFile,
            "_tmpHalfExtents",
        );
        const pinnedExtents = vectorLanes(
            numericObject(pinnedBox, navigationFile, "_tmpHalfExtents"),
            "_tmpHalfExtents",
        );
        const wrapperExtents = pinnedNavMeshQueryDefaults().halfExtents;
        if (
            pinnedExtents.some((lane, index) => lane !== wrapperExtents[index])
        ) {
            this.context.contractError(
                pinnedBox,
                `The pinned navigation queries search [${pinnedExtents.join(", ")}] ` +
                    "but NavMeshQuery.defaultQueryHalfExtents is " +
                    `[${wrapperExtents.join(", ")}], the one box the PAL ` +
                    "searches.",
            );
        }
        for (const lane of ["x", "y", "z"] as const) {
            this.context.expectShapeCount(
                closestPoint,
                `res.point.${lane}`,
                `the closest-point ${lane} read`,
            );
        }

        // createNavCrowd: the wrapper's constructor over the plugin's
        // own navmesh, with the two numbers the scene named.
        const { declaration: createCrowd } = this.context.functionDeclaration(
            modulePath,
            "createNavCrowd",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(createCrowd, "crowd"),
            "new Crowd(plugin._navMesh, { maxAgents, maxAgentRadius })",
            "Crowd construction",
        );

        // addAgent: the three `?? N` defaults the pinned module resolves
        // before the wrapper sees them -- read off these same sites by
        // `pinnedAgentParamDefaults`, which refuses a shape it does not
        // know -- and the index it hands back.
        const { declaration: addAgent } = this.context.functionDeclaration(
            modulePath,
            "addAgent",
        );
        const agentParams = this.context.objectInitializer(
            addAgent,
            "agentParams",
        );
        pinnedAgentParamDefaults();
        this.context.assertExpressionShape(
            this.context.propertyInitializer(agentParams, "userData"),
            "0",
            "Agent parameter 'userData'",
        );
        // Every key the wrapper defaults is supplied above, so its own
        // `{...crowdAgentParamsDefaults, ...params}` spread is fully
        // overridden and the PAL owes those numbers nothing. A wrapper
        // that grows a twelfth default would start reaching the agent,
        // which is what this check refuses.
        const suppliedAgentKeys = new Set(
            agentParams.properties.flatMap((property) =>
                ts.isPropertyAssignment(property) &&
                ts.isIdentifier(property.name)
                    ? [property.name.text]
                    : [],
            ),
        );
        for (const key of wrapperNumericDefaults(
            "crowdAgentParamsDefaults",
            WRAPPER_CORE,
        ).keys()) {
            if (!suppliedAgentKeys.has(key)) {
                throw new Error(
                    `@recast-navigation/core defaults crowd agent ` +
                        `parameter '${key}', which the pinned addAgent ` +
                        `does not supply — so the wrapper's default now ` +
                        `reaches the agent and pal_navigation_recast.cpp ` +
                        `has to carry it.`,
                );
            }
        }
        this.context.expectShapeCount(
            addAgent,
            "agent.agentIndex",
            "the agent index addAgent returns",
        );

        // getAgentPosition: the optional read and its zero fallback.
        const { declaration: agentPosition } = this.context.functionDeclaration(
            modulePath,
            "getAgentPosition",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(agentPosition, "p"),
            "crowd._crowd.getAgent(index)?.position()",
            "Agent position read",
        );
        this.context.expectShapeCount(
            agentPosition,
            "{ x: 0, y: 0, z: 0 }",
            "the absent-agent position fallback",
        );

        // createDebugNavMeshGeometry: the PAL arm carries the detached
        // rebuild; the pinned reversed storage (a, c, b) is the shape a
        // drift would silently break, so it is pinned here through the
        // store order.
        const { declaration: debugGeometry } = this.context.functionDeclaration(
            modulePath,
            "createDebugNavMeshGeometry",
        );
        if (
            !this.context.hasNode(
                debugGeometry,
                (node) =>
                    ts.isPropertyAccessExpression(node) &&
                    node.name.text === "getNavMeshPositionsAndIndices",
            )
        ) {
            this.context.contractError(
                debugGeometry,
                "Expected the debug walk to read getNavMeshPositionsAndIndices.",
            );
        }

        // The obstacle surface belongs to the tile cache: a solo
        // build has no cache for it to act on, so a scene that did
        // not ask for one carries neither the entry points nor the
        // PAL half behind them.
        const obstacleDeclarations = tileCache
            ? `bbl::pal::NavObstacleHandle add_box_obstacle(
    bbl::pal::NavigationHandle plugin,
    Vec3d position,
    Vec3d half_extents,
    double angle);
bbl::pal::NavObstacleHandle add_cylinder_obstacle(
    bbl::pal::NavigationHandle plugin,
    Vec3d position,
    double radius,
    double height);
void remove_obstacle(
    bbl::pal::NavigationHandle plugin,
    bbl::pal::NavObstacleHandle obstacle);
void update_nav_mesh_obstacles(bbl::pal::NavigationHandle plugin);`
            : "";
        const obstacleDefinitions = tileCache
            ? `bbl::pal::NavObstacleHandle add_box_obstacle(
    bbl::pal::NavigationHandle plugin,
    Vec3d position,
    Vec3d half_extents,
    double angle) {
    // A refused add is null upstream, and every reached use of the handle
    // is a later removeObstacle, so the refusal surfaces here rather than
    // as a remove that silently names nothing.
    const std::optional<bbl::pal::NavObstacleHandle> added =
        bbl::pal::navigation_add_box_obstacle(
            plugin,
            nav_vec3(position),
            nav_vec3(half_extents),
            static_cast<float>(angle));
    if (!added) {
        throw std::runtime_error(
            "addBoxObstacle failed: the tile cache holds no room for "
            "another obstacle.");
    }
    return *added;
}

bbl::pal::NavObstacleHandle add_cylinder_obstacle(
    bbl::pal::NavigationHandle plugin,
    Vec3d position,
    double radius,
    double height) {
    const std::optional<bbl::pal::NavObstacleHandle> added =
        bbl::pal::navigation_add_cylinder_obstacle(
            plugin,
            nav_vec3(position),
            static_cast<float>(radius),
            static_cast<float>(height));
    if (!added) {
        throw std::runtime_error(
            "addCylinderObstacle failed: the tile cache holds no room for "
            "another obstacle.");
    }
    return *added;
}

void remove_obstacle(
    bbl::pal::NavigationHandle plugin,
    bbl::pal::NavObstacleHandle obstacle) {
    bbl::pal::navigation_remove_obstacle(plugin, obstacle);
}

void update_nav_mesh_obstacles(bbl::pal::NavigationHandle plugin) {
    bbl::pal::navigation_update_obstacles(plugin);
}
`
            : "";

        return {
            modulePath,
            symbolName,
            header: pinnedHeader(
                [
                    "<bblite/pal_navigation.hpp>",
                    "<bblite/runtime.hpp>",
                    "",
                    "<vector>",
                ],
                `
bbl::pal::NavigationHandle create_navigation_plugin();
void create_nav_mesh(
    Engine& engine,
    bbl::pal::NavigationHandle plugin,
    const std::vector<MeshHandle>& meshes,
    const bbl::pal::NavMeshBuildParams& params);
${obstacleDeclarations}
${navigationBuildDefaultsDeclaration()}
bbl::pal::NavDebugGeometry create_debug_nav_mesh_geometry(
    bbl::pal::NavigationHandle plugin);
struct NavRaycastResult {
    bool hit = false;
    Vec3d hit_point{};
};
NavRaycastResult nav_raycast(
    bbl::pal::NavigationHandle plugin,
    Vec3d start,
    Vec3d end);
Vec3d nav_closest_point(
    bbl::pal::NavigationHandle plugin,
    Vec3d position);
std::vector<Vec3d> nav_compute_path(
    bbl::pal::NavigationHandle plugin,
    Vec3d start,
    Vec3d end);
void agent_goto(
    bbl::pal::NavCrowdHandle crowd,
    double index,
    Vec3d destination);
void update_nav_crowd(
    bbl::pal::NavCrowdHandle crowd,
    double delta_seconds);
bbl::pal::NavCrowdHandle create_nav_crowd(
    bbl::pal::NavigationHandle plugin,
    double max_agents,
    double max_agent_radius);
double add_agent(
    bbl::pal::NavCrowdHandle crowd,
    Vec3d position,
    const bbl::pal::NavAgentParams& params);
Vec3d get_agent_position(
    bbl::pal::NavCrowdHandle crowd,
    double index);
`,
            ),
            source: `// ${this.context.provenance(modulePath, symbolName, "createNavigationPluginAsync, createDebugNavMeshGeometry, raycast")}
#include <bblite/upstream/navigation.hpp>
// The merge composes each caster's own world through the one emitted
// composition every consumer reads, so a mesh that gained a transform-node
// parent follows it here too.
#include <bblite/upstream/renderer_plan.hpp>

#include <array>
#include <cmath>
#include <cstddef>
#include <optional>
#include <stdexcept>

namespace bbl::upstream {

bbl::pal::NavigationHandle create_navigation_plugin() {
    return bbl::pal::navigation_create_plugin();
}

// src/scene/world-matrix-state.ts composeTrsLocalMatrix +
// _mergeMeshes: the pin multiplies each mesh's CPU positions through
// its worldMatrix and reverses the winding (i, i+2, i+1) over a running
// vertex base. What differs here is only where that world already is,
// which the geometry records as its vertex space.
//
// VertexSpace::world is the glTF loader's static arm: it baked the
// mirrored node world into every position — measured on nav_test.glb,
// each baked position equals the pin's stream value — so the rows are
// the identity and the positions pass through, and a scene-code TRS on
// top would need composing that world again, so it refuses.
// VertexSpace::local keeps the transform on the record, exactly as the
// pin keeps _cpuPositions local, so the rows are the composed TRS
// above. VertexSpace::mirrored_local carries half a world and the node
// matrix arrives per draw, so it refuses by name.
void create_nav_mesh(
    Engine& engine,
    bbl::pal::NavigationHandle plugin,
    const std::vector<MeshHandle>& meshes,
    const bbl::pal::NavMeshBuildParams& params) {
    bbl::pal::NavMeshGeometry merged;
    std::size_t vertex_base = 0;
    for (const MeshHandle handle : meshes) {
        if (handle.value >= engine.meshes.size()) {
            throw std::runtime_error("Invalid mesh handle for navmesh");
        }
        const MeshRecord& mesh = ${recordAt("engine.meshes", "handle")};
        if (mesh.geometry >= engine.geometries.size()) {
            throw std::runtime_error(
                "Mesh '" + mesh.name +
                "' missing CPU geometry for navmesh");
        }
        const ModelGeometry& geometry =
            engine.geometries[mesh.geometry];
        if (geometry.vertex_space == VertexSpace::mirrored_local) {
            throw std::runtime_error(
                "createNavMesh is lowered for meshes whose vertices are "
                "local or fully world-baked; mesh '" + mesh.name +
                "' is animated or instanced, so its node matrix reaches "
                "the draw rather than its geometry.");
        }
        const bool baked_world =
            geometry.vertex_space == VertexSpace::world;
        if (baked_world &&
            (mesh.position.x != 0.0f || mesh.position.y != 0.0f ||
             mesh.position.z != 0.0f ||
             mesh.rotation.x != 0.0f || mesh.rotation.y != 0.0f ||
             mesh.rotation.z != 0.0f ||
             mesh.has_rotation_quaternion ||
             mesh.scaling.x != 1.0f || mesh.scaling.y != 1.0f ||
             mesh.scaling.z != 1.0f)) {
            throw std::runtime_error(
                "createNavMesh is lowered for imported meshes at their "
                "loaded transform; mesh '" + mesh.name +
                "' carries scene-code TRS on top of a baked world, "
                "which the merge does not compose.");
        }
        merged.positions.reserve(
            merged.positions.size() +
            geometry.vertices.size() * 3);
        if (baked_world) {
            for (const ModelVertex& vertex : geometry.vertices) {
                merged.positions.push_back(vertex.position.x);
                merged.positions.push_back(vertex.position.y);
                merged.positions.push_back(vertex.position.z);
            }
        } else {
            const std::array<float, 16> wm = upstream::mesh_world_matrix(engine, mesh);
            for (const ModelVertex& vertex : geometry.vertices) {
                const double x = vertex.position.x;
                const double y = vertex.position.y;
                const double z = vertex.position.z;
                merged.positions.push_back(static_cast<float>(
                    x * wm[0] + y * wm[4] + z * wm[8] + wm[12]));
                merged.positions.push_back(static_cast<float>(
                    x * wm[1] + y * wm[5] + z * wm[9] + wm[13]));
                merged.positions.push_back(static_cast<float>(
                    x * wm[2] + y * wm[6] + z * wm[10] + wm[14]));
            }
        }
        merged.indices.reserve(
            merged.indices.size() + geometry.indices.size());
        for (std::size_t index = 0;
             index + 2 < geometry.indices.size();
             index += 3) {
            merged.indices.push_back(static_cast<std::uint32_t>(
                geometry.indices[index] + vertex_base));
            merged.indices.push_back(static_cast<std::uint32_t>(
                geometry.indices[index + 2] + vertex_base));
            merged.indices.push_back(static_cast<std::uint32_t>(
                geometry.indices[index + 1] + vertex_base));
        }
        vertex_base += geometry.vertices.size();
    }
    // The pin dispatches on maxObstacles here; generation already did,
    // and the arm it proved is the one emitted -- so a scene that builds a
    // cache carries no solo call, and one that does not carries neither
    // the tile-cache call nor the obstacle surface behind it.
    bbl::pal::navigation_create_${
        tileCache ? "tile_cache_nav_mesh" : "solo_nav_mesh"
    }(
        plugin, merged, params, navigation_build_defaults);
}

/** A double the port carries, at the float width the seam takes. */
bbl::pal::NavVec3 nav_vec3(Vec3d value) {
    return bbl::pal::NavVec3{
        static_cast<float>(value.x),
        static_cast<float>(value.y),
        static_cast<float>(value.z)};
}

${obstacleDefinitions}

bbl::pal::NavDebugGeometry create_debug_nav_mesh_geometry(
    bbl::pal::NavigationHandle plugin) {
    return bbl::pal::navigation_debug_geometry(plugin);
}

// raycast: the PAL answers the pinned hit window; the hit point is
// the pinned lerp, in doubles as JavaScript computes it from the f32
// parameter.
NavRaycastResult nav_raycast(
    bbl::pal::NavigationHandle plugin,
    Vec3d start,
    Vec3d end) {
    const bbl::pal::NavRaycastHit raw = bbl::pal::navigation_raycast(
        plugin,
        static_cast<float>(start.x),
        static_cast<float>(start.y),
        static_cast<float>(start.z),
        static_cast<float>(end.x),
        static_cast<float>(end.y),
        static_cast<float>(end.z));
    if (!raw.hit) {
        return NavRaycastResult{};
    }
    const double t = raw.t;
    return NavRaycastResult{
        true,
        Vec3d{
            start.x + (end.x - start.x) * t,
            start.y + (end.y - start.y) * t,
            start.z + (end.z - start.z) * t,
        },
    };
}

// getClosestPoint: the PAL runs the wrapper's two-call query at the
// pinned half-extents, which generation proved are the wrapper's default
// box, and the point is read straight off it. The pin
// inspects no status — its own comment says a position with nothing
// nearby returns an unspecified point — so the failure arm passes the
// PAL's zeroed buffer through rather than inventing a signal the scene
// has no way to read.
Vec3d nav_closest_point(
    bbl::pal::NavigationHandle plugin,
    Vec3d position) {
    const bbl::pal::NavVec3 point = bbl::pal::navigation_closest_point(
        plugin,
        static_cast<float>(position.x),
        static_cast<float>(position.y),
        static_cast<float>(position.z));
    return Vec3d{point.x, point.y, point.z};
}

// computePath: the pin SNAPS both endpoints through its own
// findClosestPoint before handing them to the query, whose own
// computePath then resolves a polygon for each again. Both steps are the
// pin's, and the first is not redundant -- not because the half-extents
// differ (generation proved both boxes the same) but because findClosestPoint is
// findNearestPoly PLUS closestPointOnPoly, so it projects an endpoint
// onto its polygon before the corridor search sees it. A failed query is
// an EMPTY path here, which is what the pin returns when its own result
// is not a success.
std::vector<Vec3d> nav_compute_path(
    bbl::pal::NavigationHandle plugin,
    Vec3d start,
    Vec3d end) {
    const Vec3d start_snap = nav_closest_point(plugin, start);
    const Vec3d end_snap = nav_closest_point(plugin, end);
    const std::vector<bbl::pal::NavVec3> path =
        bbl::pal::navigation_compute_path(
            plugin,
            nav_vec3(start_snap),
            nav_vec3(end_snap));
    std::vector<Vec3d> out;
    out.reserve(path.size());
    for (const bbl::pal::NavVec3& point : path) {
        out.push_back(Vec3d{point.x, point.y, point.z});
    }
    return out;
}

#if BBLITE_HAS_NAV_CROWD
bbl::pal::NavCrowdHandle create_nav_crowd(
    bbl::pal::NavigationHandle plugin,
    double max_agents,
    double max_agent_radius) {
    return bbl::pal::navigation_create_crowd(
        plugin,
        static_cast<int>(max_agents),
        static_cast<float>(max_agent_radius));
}

double add_agent(
    bbl::pal::NavCrowdHandle crowd,
    Vec3d position,
    const bbl::pal::NavAgentParams& params) {
    return static_cast<double>(bbl::pal::navigation_add_agent(
        crowd,
        static_cast<float>(position.x),
        static_cast<float>(position.y),
        static_cast<float>(position.z),
        params));
}

// agentGoto: the pin reads through an optional chain, so an index the
// crowd holds no agent at is a silent no-op rather than a throw. The PAL
// reports that absence; deciding what it MEANS is the pin's, and lives
// here beside get_agent_position's own reading of the same chain.
void agent_goto(
    bbl::pal::NavCrowdHandle crowd,
    double index,
    Vec3d destination) {
    static_cast<void>(bbl::pal::navigation_agent_goto(
        crowd,
        static_cast<int>(index),
        bbl::pal::NavVec3{
            static_cast<float>(destination.x),
            static_cast<float>(destination.y),
            static_cast<float>(destination.z)}));
}

// updateNavCrowd: one dtCrowd step at the delta the scene passes.
void update_nav_crowd(
    bbl::pal::NavCrowdHandle crowd,
    double delta_seconds) {
    bbl::pal::navigation_update_crowd(
        crowd,
        static_cast<float>(delta_seconds));
}

// getAgentPosition: the pin reads through an optional chain and answers
// {0, 0, 0} when the crowd holds no agent at that index.
Vec3d get_agent_position(
    bbl::pal::NavCrowdHandle crowd,
    double index) {
    const std::optional<bbl::pal::NavVec3> position =
        bbl::pal::navigation_agent_position(
            crowd, static_cast<int>(index));
    if (!position) {
        return Vec3d{0.0, 0.0, 0.0};
    }
    return Vec3d{position->x, position->y, position->z};
}
#endif

} // namespace bbl::upstream
`,
        };
    }
}
