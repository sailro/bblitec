/**
 * The line-system family: `createLineSystem`, `createLineMaterial` and
 * `updateLineSystem`.
 *
 * A line system is not a new renderable. Upstream concatenates the polylines
 * into one indexed mesh, records `_topology = 2` on it, and draws it with an
 * ordinary `ShaderMaterial` whose `_topology` is `"line-list"` — so the port
 * reaches it through the two mechanisms it already owns, the plain-data mesh
 * (`createMeshFromData`) and the scene-local shader variant, and the only
 * genuinely new quantity is the primitive topology the pipeline is built at.
 *
 * Both halves come from the pin rather than from here:
 *
 * - the **material's WGSL** is folded out of `line-material.ts`'s own
 *   `vertexSource`/`fragmentSource` builders through `PinnedShaderText`, so a
 *   bump that rewrites a stage rewrites what this port deploys and a bump that
 *   changes the shape refuses generation;
 * - the **flatten** is emitted as C++ from this file, with each rule the
 *   emitted loop folds asserted against the pinned declaration that states it
 *   — the index pair, the per-line disconnection, the zero normals, the
 *   validation throws.
 */
import ts from "typescript";
import type { LoweredSource, LoweringContext } from "./context.js";
import { PinnedShaderText } from "./pinned-shader-text.js";
import type { CompiledShaderProgram } from "../compiler/types.js";

export const lineMaterialModule = "src/material/line/line-material.ts";
export const lineSystemModule = "src/mesh/create-line-system.ts";

/** The permutation a `createLineMaterial` call settles at generation. */
export interface LineMaterialOptions {
    readonly useVertexColor: boolean;
    readonly useVertexAlpha: boolean;
    readonly useThinInstances: boolean;
    readonly useThinInstanceColors: boolean;
    /** The `lineColor` RGBA, already resolved through the pin's own default. */
    readonly color: readonly [number, number, number, number];
    /** `options.depthWrite`, when the caller named one. */
    readonly depthWrite?: boolean;
}

export class LineLowerer {
    private readonly shaderText: PinnedShaderText;

    public constructor(private readonly context: LoweringContext) {
        this.shaderText = new PinnedShaderText(context);
    }

    // -----------------------------------------------------------------
    // The material
    // -----------------------------------------------------------------

    /**
     * The pin's own default for `createLineMaterial`'s `color`, read from the
     * `options.color ?? { ... }` it resolves rather than restated.
     */
    public defaultColor(): [number, number, number, number] {
        const { declaration } = this.context.functionDeclaration(
            lineMaterialModule,
            "createLineMaterial",
        );
        const initializer = this.context.variableInitializer(
            declaration,
            "sourceColor",
        );
        if (
            !ts.isBinaryExpression(initializer) ||
            initializer.operatorToken.kind !==
                ts.SyntaxKind.QuestionQuestionToken ||
            !ts.isObjectLiteralExpression(initializer.right)
        ) {
            this.context.contractError(
                initializer,
                "Expected createLineMaterial to default its color through `options.color ?? { ... }`.",
            );
        }
        const file = this.context.sourceFile(lineMaterialModule);
        return ["r", "g", "b", "a"].map((channel) =>
            this.context.numericValue(
                this.context.propertyInitializer(
                    initializer.right as ts.ObjectLiteralExpression,
                    channel,
                ),
                file,
            ),
        ) as [number, number, number, number];
    }

    /**
     * The `ShaderMaterial` `createLineMaterial` builds, as this port's own
     * variant record.
     *
     * Everything in it is read out of the pinned factory: the two stages from
     * its text builders, the attribute list and the uniform list from the
     * `createShaderMaterial` call it makes, and the fixed-function state from
     * the arguments beside them.
     */
    public materialProgram(
        options: LineMaterialOptions,
    ): CompiledShaderProgram & { topology: "line-list" } {
        const call = this.createShaderMaterialCall();
        this.assertMaterialState(call);
        const hasColorVarying =
            options.useVertexColor || options.useThinInstanceColors;
        const parameters = new Map<string, boolean>([
            ["useVertexColor", options.useVertexColor],
            ["useThinInstances", options.useThinInstances],
            ["useThinInstanceColors", options.useThinInstanceColors],
        ]);
        const vertexSource = this.shaderText.evaluate(
            lineMaterialModule,
            "vertexSource",
            parameters,
        );
        const fragmentSource = this.shaderText.evaluate(
            lineMaterialModule,
            "fragmentSource",
            new Map<string, boolean>([["hasColor", hasColorVarying]]),
        );
        const attributes = this.assertAttributes(call, options.useVertexColor);
        const uniforms = this.assertUniforms(call, hasColorVarying);
        const needAlphaBlending = options.useVertexAlpha;
        return {
            name: variantName(options),
            vertexSource,
            fragmentSource,
            attributes,
            uniforms,
            uniformDefaults: hasColorVarying
                ? []
                : [{ name: "lineColor", values: [...options.color] }],
            samplers: [],
            defines: [],
            needAlphaBlending,
            needAlphaTesting: false,
            backFaceCulling: false,
            useThinInstances: options.useThinInstances,
            useThinInstanceColors: options.useThinInstanceColors,
            // `createShaderMaterial`'s own resolution: an explicit option
            // always wins, and a blended material otherwise reads depth
            // without writing it.
            depthWrite: options.depthWrite ?? !needAlphaBlending,
            topology: this.assertLineTopology(),
        };
    }

    /** The `createShaderMaterial({ ... })` argument `createLineMaterial` passes. */
    private createShaderMaterialCall(): ts.ObjectLiteralExpression {
        return this.context.callObjectArgument(
            this.context.functionDeclaration(
                lineMaterialModule,
                "createLineMaterial",
            ).declaration,
            "createShaderMaterial",
        );
    }

    /**
     * The pinned material state this port folds, each read from the property
     * that states it: a line material blends when its vertex alpha is on,
     * takes the pin's own `"alpha"` equation, and never culls.
     */
    private assertMaterialState(
        call: ts.ObjectLiteralExpression,
    ): void {
        const blending = this.context.propertyInitializer(
            call,
            "needAlphaBlending",
        );
        if (
            !ts.isIdentifier(blending) ||
            blending.text !== "useVertexAlpha"
        ) {
            this.context.contractError(
                blending,
                "Expected a line material to blend on `useVertexAlpha`.",
            );
        }
        const blendMode = this.context.propertyInitializer(call, "blendMode");
        if (
            !ts.isStringLiteral(blendMode) ||
            blendMode.text !== "alpha"
        ) {
            this.context.contractError(
                blendMode,
                "Expected a line material to take the pin's `alpha` blend equation.",
            );
        }
        const culling = this.context.propertyInitializer(
            call,
            "backFaceCulling",
        );
        if (culling.kind !== ts.SyntaxKind.FalseKeyword) {
            this.context.contractError(
                culling,
                "Expected a line material to disable back-face culling.",
            );
        }
    }

    /** `attributes: useVertexColor ? ["position", "color"] : ["position"]`. */
    private assertAttributes(
        call: ts.ObjectLiteralExpression,
        useVertexColor: boolean,
    ): string[] {
        const attributes = this.context.propertyInitializer(
            call,
            "attributes",
        );
        if (
            !ts.isConditionalExpression(attributes) ||
            !ts.isIdentifier(attributes.condition) ||
            attributes.condition.text !== "useVertexColor"
        ) {
            this.context.contractError(
                attributes,
                "Expected a line material's attributes to fork on `useVertexColor`.",
            );
        }
        const branch = useVertexColor
            ? attributes.whenTrue
            : attributes.whenFalse;
        return this.stringArray(branch);
    }

    /**
     * The `uniforms` list, in the pin's own order: the two system matrices
     * every line stage reads, then the `lineColor` slot a stage without a
     * colour varying declares instead.
     */
    private assertUniforms(
        call: ts.ObjectLiteralExpression,
        hasColorVarying: boolean,
    ): string[] {
        const uniforms = this.context.propertyInitializer(call, "uniforms");
        if (!ts.isArrayLiteralExpression(uniforms)) {
            this.context.contractError(
                uniforms,
                "Expected a line material's uniforms to be an array literal.",
            );
        }
        const names: string[] = [];
        let spread: ts.SpreadElement | undefined;
        for (const element of uniforms.elements) {
            if (ts.isStringLiteral(element)) {
                names.push(element.text);
                continue;
            }
            if (ts.isSpreadElement(element) && !spread) {
                spread = element;
                continue;
            }
            this.context.contractError(
                element,
                "Expected a line material's uniforms to be system names plus one conditional spread.",
            );
        }
        if (!spread) {
            this.context.contractError(
                uniforms,
                "Expected a line material to spread its `lineColor` declaration conditionally.",
            );
        }
        if (hasColorVarying) {
            return names;
        }
        const declaration = this.spreadUniformDeclaration(spread);
        return [...names, declaration];
    }

    /**
     * The `lineColor` declaration inside the conditional spread, as this
     * port's `name:type` signature. The condition is the pin's — a stage that
     * carries a colour varying reads no uniform at all — so it is checked
     * rather than assumed.
     */
    private spreadUniformDeclaration(spread: ts.SpreadElement): string {
        const parenthesized = this.context.unwrapExpression(spread.expression);
        const conditional = ts.isConditionalExpression(parenthesized)
            ? parenthesized
            : undefined;
        if (
            !conditional ||
            !ts.isPrefixUnaryExpression(conditional.condition) ||
            conditional.condition.operator !==
                ts.SyntaxKind.ExclamationToken ||
            !ts.isIdentifier(conditional.condition.operand) ||
            conditional.condition.operand.text !== "hasColorVarying"
        ) {
            this.context.contractError(
                spread,
                "Expected the `lineColor` uniform to be spread on `!hasColorVarying`.",
            );
        }
        const list = this.context.unwrapExpression(conditional.whenTrue);
        if (
            !ts.isArrayLiteralExpression(list) ||
            list.elements.length !== 1 ||
            !ts.isObjectLiteralExpression(list.elements[0]!)
        ) {
            this.context.contractError(
                conditional.whenTrue,
                "Expected one `lineColor` uniform declaration.",
            );
        }
        const declaration = list.elements[0] as ts.ObjectLiteralExpression;
        const name = this.context.propertyInitializer(declaration, "name");
        const type = this.context.propertyInitializer(declaration, "type");
        if (
            !ts.isStringLiteral(name) ||
            !ts.isStringLiteral(type) ||
            name.text !== "lineColor" ||
            type.text !== "vec4<f32>"
        ) {
            this.context.contractError(
                declaration,
                "Expected the pinned `lineColor: vec4<f32>` uniform declaration.",
            );
        }
        return `${name.text}:${type.text}`;
    }

    /** `Object.assign(material, { ..., _topology: "line-list" })`. */
    private assertLineTopology(): "line-list" {
        const { declaration } = this.context.functionDeclaration(
            lineMaterialModule,
            "createLineMaterial",
        );
        const assigned = this.context.findNodes(
            declaration,
            (node): node is ts.PropertyAssignment =>
                ts.isPropertyAssignment(node) &&
                this.context.propertyName(node.name) === "_topology",
        )[0];
        if (
            !assigned ||
            !ts.isStringLiteral(assigned.initializer) ||
            assigned.initializer.text !== "line-list"
        ) {
            this.context.contractError(
                declaration,
                "Expected createLineMaterial to stamp `_topology: \"line-list\"`.",
            );
        }
        return "line-list";
    }

    private stringArray(expression: ts.Expression): string[] {
        const array = this.context.unwrapExpression(expression);
        if (!ts.isArrayLiteralExpression(array)) {
            this.context.contractError(
                expression,
                "Expected a static string array.",
            );
        }
        return array.elements.map((element) => {
            if (!ts.isStringLiteral(element)) {
                this.context.contractError(
                    element,
                    "Expected a string literal.",
                );
            }
            return element.text;
        });
    }

    // -----------------------------------------------------------------
    // The geometry
    // -----------------------------------------------------------------

    /**
     * `createLineSystemData`, `createLineSystem` and `updateLineSystem` as
     * generated C++.
     *
     * The pin flattens the polylines at load and hands the result to
     * `createMeshFromData`, so this port does the same rather than folding
     * the buffers at generation: the flatten's *shape* is the contract — the
     * index pair, the per-line disconnection, the zero normals a mesh
     * uploader requires and the line shader never reads — and every rule the
     * emitted loops fold is checked against the declaration that states it.
     */
    public lowerLineSystem(): LoweredSource {
        this.assertLineSystemDataRule();
        this.assertLineSystemRule();
        this.assertUpdateRule();
        return {
            modulePath: lineSystemModule,
            symbolName:
                "createLineSystemData,createLineSystem,updateLineSystem",
            header: "",
            source: `// ${this.context.provenance(
                lineSystemModule,
                "createLineSystemData, createLineSystem, updateLineSystem",
                "src/math/compute-aabb.ts bounds",
            )}
#include <bblite/runtime.hpp>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <limits>
#include <stdexcept>
#include <string>

namespace bbl {

namespace {

void assert_finite_line_component(const char* kind, float value) {
    if (!std::isfinite(value)) {
        throw std::runtime_error(
            std::string("Line system data requires finite ") + kind +
            " components");
    }
}

}  // namespace

// flattenLineAttributes: concatenate the polylines in line order, copying
// each component into its buffer at the offset the vertex counter gives it.
// The per-line counts and the segment index pairs are written only when the
// caller asks for them, exactly as the pin makes those two parameters
// optional -- an update needs neither, because the topology it would
// recompute is the one it just refused to let change.
void flatten_line_attributes(
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors,
    std::size_t vertex_count,
    std::vector<float>& positions,
    std::vector<float>& out_colors,
    std::vector<std::uint32_t>* line_point_counts,
    std::vector<std::uint32_t>* indices) {
    if (!colors.empty() && colors.size() != lines.size()) {
        throw std::runtime_error(
            "Line system data requires one color row per line");
    }
    positions.assign(vertex_count * 3u, 0.0f);
    if (!colors.empty()) {
        out_colors.assign(vertex_count * 4u, 0.0f);
    }
    std::size_t vertex = 0;
    std::size_t index = 0;
    for (std::size_t line_index = 0; line_index < lines.size(); ++line_index) {
        const std::vector<Vec3>& line = lines[line_index];
        if (!colors.empty() && colors[line_index].size() != line.size()) {
            throw std::runtime_error(
                "Line system data requires one color per point");
        }
        if (line_point_counts != nullptr) {
            (*line_point_counts)[line_index] =
                static_cast<std::uint32_t>(line.size());
        }
        for (std::size_t point_index = 0; point_index < line.size();
             ++point_index) {
            const Vec3& point = line[point_index];
            assert_finite_line_component("position", point.x);
            assert_finite_line_component("position", point.y);
            assert_finite_line_component("position", point.z);
            const std::size_t position_offset = vertex * 3u;
            positions[position_offset] = point.x;
            positions[position_offset + 1u] = point.y;
            positions[position_offset + 2u] = point.z;
            if (!colors.empty()) {
                const Vec4& color = colors[line_index][point_index];
                assert_finite_line_component("color", color.x);
                assert_finite_line_component("color", color.y);
                assert_finite_line_component("color", color.z);
                assert_finite_line_component("color", color.w);
                const std::size_t color_offset = vertex * 4u;
                out_colors[color_offset] = color.x;
                out_colors[color_offset + 1u] = color.y;
                out_colors[color_offset + 2u] = color.z;
                out_colors[color_offset + 3u] = color.w;
            }
            if (indices != nullptr && point_index > 0) {
                (*indices)[index++] =
                    static_cast<std::uint32_t>(vertex - 1u);
                (*indices)[index++] = static_cast<std::uint32_t>(vertex);
            }
            ++vertex;
        }
    }
}

// createLineSystemData: the flatten with every buffer a new mesh needs --
// the index pairs that make it a line list, one zero normal triple per
// vertex because the shared mesh uploader requires the buffer while the
// line shader binds no normal at all, and the per-line counts a later
// update validates against.
LineSystemData create_line_system_data(
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors) {
    std::size_t vertex_count = 0;
    std::size_t index_count = 0;
    for (const std::vector<Vec3>& line : lines) {
        vertex_count += line.size();
        index_count += (line.size() > 1u ? line.size() - 1u : 0u) * 2u;
    }
    if (vertex_count == 0) {
        throw std::runtime_error(
            "createLineSystemData requires at least one point");
    }
    LineSystemData data;
    data.normals.assign(vertex_count * 3u, 0.0f);
    data.indices.assign(index_count, 0u);
    data.line_point_counts.assign(lines.size(), 0u);
    flatten_line_attributes(
        lines,
        colors,
        vertex_count,
        data.positions,
        data.colors,
        &data.line_point_counts,
        &data.indices);
    return data;
}

// createLineSystem: the flattened data through createMeshFromData, then the
// material the caller supplied or the one the factory built for it. The
// pinned \`mesh.hasVertexAlpha\` stamp beside them is read only by the
// Standard family, which no line mesh reaches, so it folds away here.
MeshHandle create_line_system(
    Engine& engine,
    const std::string& name,
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors,
    MaterialHandle material) {
    const LineSystemData data = create_line_system_data(lines, colors);
    // The name is the compiled \`options.name ?? "lineSystem"\`, asserted
    // in the whole createMeshFromData call shape above.
    const MeshHandle mesh = create_mesh_from_data(
        engine,
        name,
        data.positions,
        data.normals,
        data.indices,
        {},
        {},
        {},
        data.colors);
    MeshRecord& record = engine.meshes[mesh.value];
    record.material = material;
    record.line_point_counts = data.line_point_counts;
    record.line_has_colors = !data.colors.empty();
    return mesh;
}

// updateLineSystem: the same flatten over new points, written into the
// geometry the mesh already owns. The pin writes through the GPU buffers it
// uploaded while the page loaded; this runtime uploads at engine start, so
// the geometry IS what a later upload reads.
void update_line_system(
    Engine& engine,
    MeshHandle mesh,
    const std::vector<std::vector<Vec3>>& lines,
    const std::vector<std::vector<Vec4>>& colors) {
    if (mesh.value >= engine.meshes.size()) {
        throw std::runtime_error("Invalid line system mesh handle.");
    }
    MeshRecord& record = engine.meshes[mesh.value];
    const std::vector<std::uint32_t>& point_counts = record.line_point_counts;
    if (point_counts.empty()) {
        throw std::runtime_error(
            "updateLineSystem requires a mesh created by createLineSystem");
    }
    if (lines.size() != point_counts.size()) {
        throw std::runtime_error(
            "updateLineSystem requires unchanged line and point counts");
    }
    for (std::size_t i = 0; i < point_counts.size(); ++i) {
        if (lines[i].size() != point_counts[i]) {
            throw std::runtime_error(
                "updateLineSystem requires unchanged line and point counts");
        }
    }
    if (!colors.empty() && !record.line_has_colors) {
        throw std::runtime_error(
            "updateLineSystem cannot add colors to a mesh created without "
            "vertex colors");
    }
    if (record.geometry >= engine.geometries.size()) {
        throw std::runtime_error("Line system mesh carries no geometry.");
    }
    ModelGeometry& geometry = engine.geometries[record.geometry];
    // The lean flatten the pin runs on an update: positions and colours,
    // no normals, no index pairs and no per-line counts, because the
    // topology it would recompute is the one refused above.
    std::size_t vertex_count = 0;
    for (const std::uint32_t count : point_counts) {
        vertex_count += count;
    }
    std::vector<float> positions;
    std::vector<float> updated_colors;
    flatten_line_attributes(
        lines,
        colors,
        vertex_count,
        positions,
        updated_colors,
        nullptr,
        nullptr);
    for (std::size_t index = 0; index < vertex_count; ++index) {
        ModelVertex& vertex = geometry.vertices[index];
        vertex.position = Vec3{
            positions[index * 3u],
            positions[index * 3u + 1u],
            positions[index * 3u + 2u]};
        vertex.local_position = vertex.position;
        if (!updated_colors.empty()) {
            vertex.color = Vec4{
                updated_colors[index * 4u],
                updated_colors[index * 4u + 1u],
                updated_colors[index * 4u + 2u],
                updated_colors[index * 4u + 3u]};
        }
    }
    // computeAabb over the new positions, exactly as the pinned update
    // recomputes the mesh bounds after writing them.
    Vec3 bounds_min{
        std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::infinity(),
        std::numeric_limits<float>::infinity()};
    Vec3 bounds_max{
        -std::numeric_limits<float>::infinity(),
        -std::numeric_limits<float>::infinity(),
        -std::numeric_limits<float>::infinity()};
    for (std::size_t index = 0; index < vertex_count; ++index) {
        const Vec3& position = geometry.vertices[index].position;
        bounds_min.x = std::min(bounds_min.x, position.x);
        bounds_min.y = std::min(bounds_min.y, position.y);
        bounds_min.z = std::min(bounds_min.z, position.z);
        bounds_max.x = std::max(bounds_max.x, position.x);
        bounds_max.y = std::max(bounds_max.y, position.y);
        bounds_max.z = std::max(bounds_max.z, position.z);
    }
    geometry.bounds_min = bounds_min;
    geometry.bounds_max = bounds_max;
    geometry.world_bounds_min = bounds_min;
    geometry.world_bounds_max = bounds_max;
}

}  // namespace bbl
`,
        };
    }

    /**
     * `createLineSystemData` and the `flattenLineAttributes` it calls: the
     * counts, the per-point copy-through, the index pair, and the guard
     * behind each validation throw.
     *
     * Every rule the emitted C++ folds is located as its own pinned node
     * and compared structurally, so a pin that keeps a throw's message
     * while narrowing the condition behind it -- or that starts
     * transforming a point on its way into the buffer -- refuses
     * generation instead of leaving this port describing a flatten
     * upstream no longer performs.
     */
    private assertLineSystemDataRule(): void {
        const { declaration: data } = this.context.functionDeclaration(
            lineSystemModule,
            "createLineSystemData",
        );
        this.assertShape(
            data,
            "vertexCount += line.length",
            "the vertex count",
        );
        this.assertShape(
            data,
            "indexCount += Math.max(0, line.length - 1) * 2",
            "the per-line index count",
        );
        this.assertInitializer(
            data,
            "normals",
            "new Float32Array(vertexCount * 3)",
            "zero normal buffer",
        );
        this.assertInitializer(
            data,
            "indices",
            "new Uint32Array(indexCount)",
            "index buffer",
        );
        this.assertInitializer(
            data,
            "linePointCounts",
            "new Uint32Array(lines.length)",
            "per-line point counts",
        );
        this.assertThrow(
            data,
            "vertexCount === 0",
            "createLineSystemData requires at least one point",
        );

        const { declaration: flatten } = this.context.functionDeclaration(
            lineSystemModule,
            "flattenLineAttributes",
        );
        this.assertInitializer(
            flatten,
            "positions",
            "new Float32Array(vertexCount * 3)",
            "position buffer",
        );
        this.assertInitializer(
            flatten,
            "vertexColors",
            "colors ? new Float32Array(vertexCount * 4) : undefined",
            "colour buffer",
        );
        // The copy-through itself: each component reaches its buffer
        // untransformed, at the offset the vertex counter gives it.
        this.assertInitializer(
            flatten,
            "positionOffset",
            "vertex * 3",
            "position offset",
        );
        this.assertInitializer(
            flatten,
            "colorOffset",
            "vertex * 4",
            "colour offset",
        );
        for (const [target, source] of [
            ["positions[positionOffset]", "point.x"],
            ["positions[positionOffset + 1]", "point.y"],
            ["positions[positionOffset + 2]", "point.z"],
            ["vertexColors[colorOffset]", "color.r"],
            ["vertexColors[colorOffset + 1]", "color.g"],
            ["vertexColors[colorOffset + 2]", "color.b"],
            ["vertexColors[colorOffset + 3]", "color.a"],
        ] as const) {
            this.assertShape(
                flatten,
                `${target} = ${source}`,
                "the per-point copy-through",
            );
        }
        this.assertShape(
            flatten,
            "indices[index++] = vertex - 1",
            "the segment's first index",
        );
        this.assertShape(
            flatten,
            "indices[index++] = vertex",
            "the segment's second index",
        );
        this.assertShape(
            flatten,
            "indices && pointIndex > 0",
            "the rule that no line joins the next",
        );
        this.assertThrow(
            flatten,
            "colors && colors.length !== lines.length",
            "Line system data requires one color row per line",
        );
        this.assertThrow(
            flatten,
            "lineColors && lineColors.length !== line.length",
            "Line system data requires one color per point",
        );

        const { declaration: assertFinite } =
            this.context.functionDeclaration(
                lineSystemModule,
                "assertFinite",
            );
        this.assertThrow(
            assertFinite,
            "!Number.isFinite(value)",
            "Line system data requires finite ",
        );
    }

    /** `createLineSystem`: the mesh it builds and the stamps it makes. */
    private assertLineSystemRule(): void {
        const { declaration } = this.context.functionDeclaration(
            lineSystemModule,
            "createLineSystem",
        );
        this.assertShape(
            declaration,
            'createMeshFromData(engine, options.name ?? "lineSystem", data.positions, data.normals, data.indices, undefined, undefined, undefined, data.colors)',
            "the mesh the flatten builds",
        );
        this.assertShape(
            declaration,
            "mesh._topology = 2",
            "the line-list topology stamp",
        );
        this.assertShape(
            declaration,
            "mesh.hasVertexAlpha = !!data.colors && material.useVertexAlpha",
            "the vertex-alpha stamp the Standard family reads",
        );
        this.assertShape(
            declaration,
            "mesh._linePointCounts = data.linePointCounts",
            "the retained per-line counts",
        );
        this.assertThrow(
            declaration,
            "material.useVertexColor !== !!data.colors",
            "createLineSystem requires material.useVertexColor to match the line color-buffer layout",
        );
    }

    /**
     * `updateLineSystem`: the fixed-topology checks, the lean flatten and
     * the bounds refresh.
     *
     * The lean call is why two functions are emitted rather than one: an
     * update runs `flattenLineAttributes` with neither the counts nor the
     * indices, so it allocates no normals, writes no index pairs and
     * recounts no lines -- the topology it would recompute is the one it
     * just refused to let change.
     */
    private assertUpdateRule(): void {
        const { declaration } = this.context.functionDeclaration(
            lineSystemModule,
            "updateLineSystem",
        );
        this.assertShape(
            declaration,
            "flattenLineAttributes(options, vertexCount)",
            "the lean flatten an update runs",
        );
        this.assertShape(
            declaration,
            "updateMeshPositions(engine, mesh, data.positions)",
            "the position write",
        );
        this.assertShape(
            declaration,
            "updateMeshColors(engine, mesh, data.colors)",
            "the colour write",
        );
        this.assertShape(
            declaration,
            "computeAabb(data.positions)",
            "the bounds refresh",
        );
        this.assertThrow(
            declaration,
            "!pointCounts",
            "updateLineSystem requires a mesh created by createLineSystem",
        );
        this.assertThrow(
            declaration,
            "options.lines.length !== pointCounts.length",
            "updateLineSystem requires unchanged line and point counts",
        );
        this.assertThrow(
            declaration,
            "options.colors && !mesh._gpu.colorBuffer",
            "updateLineSystem cannot add colors to a mesh created without vertex colors",
        );
    }

    /**
     * One pinned expression this port folds, located by its own shape.
     *
     * The pin states several of these over different operands inside one
     * body, so the node is found by matching rather than by position, and
     * a body that no longer contains it refuses generation.
     */
    private assertShape(
        declaration: ts.FunctionDeclaration,
        expected: string,
        label: string,
    ): void {
        const found = this.context.findNodes(
            declaration,
            (node): node is ts.Expression =>
                (ts.isBinaryExpression(node) ||
                    ts.isCallExpression(node) ||
                    ts.isPrefixUnaryExpression(node)) &&
                this.context.expressionMatchesShape(node, expected),
        )[0];
        if (!found) {
            this.context.contractError(
                declaration,
                `Expected ${label} ('${expected}') in the pinned line system.`,
            );
        }
    }

    /** A pinned `const` this port folds, by name and by shape. */
    private assertInitializer(
        declaration: ts.FunctionDeclaration,
        name: string,
        expected: string,
        label: string,
    ): void {
        this.context.assertExpressionShape(
            this.context.variableInitializer(declaration, name),
            expected,
            `Pinned line-system ${label}`,
        );
    }

    /**
     * A pinned `throw new Error("...")` the generated C++ reproduces,
     * together with the condition that guards it: a message alone would
     * still match after the pin narrowed when it fires.
     */
    private assertThrow(
        declaration: ts.FunctionDeclaration,
        condition: string,
        message: string,
    ): void {
        const guard = this.context.findNodes(
            declaration,
            (node): node is ts.IfStatement =>
                ts.isIfStatement(node) &&
                this.context.expressionMatchesShape(
                    node.expression,
                    condition,
                ) &&
                this.context.findNodes(
                    node.thenStatement,
                    (thrown): thrown is ts.Node =>
                        // The pin writes some of these messages as a
                        // template, interpolating the component it is
                        // rejecting, so the head is what carries the text.
                        (ts.isStringLiteral(thrown) &&
                            thrown.text.startsWith(message)) ||
                        (ts.isTemplateExpression(thrown) &&
                            thrown.head.text.startsWith(message)),
                ).length > 0,
        )[0];
        if (!guard) {
            this.context.contractError(
                declaration,
                `Expected the pinned line-system throw "${message}" guarded by '${condition}'.`,
            );
        }
    }

}

/**
 * A variant's identity is its permutation, because the pin names every line
 * material `"LineMaterial"` while composing a different program for each
 * combination of flags — one scene reaching both the uniform-colour and the
 * vertex-colour form composes two.
 */
export function variantName(options: LineMaterialOptions): string {
    const suffix = [
        options.useVertexColor ? "vc" : undefined,
        options.useThinInstances ? "ti" : undefined,
        options.useThinInstanceColors ? "tic" : undefined,
        options.useVertexAlpha ? undefined : "opaque",
        options.depthWrite === undefined
            ? undefined
            : options.depthWrite
                ? "depth-write"
                : "depth-read",
    ].filter((part): part is string => part !== undefined);
    return ["line-material", ...suffix].join("-");
}
