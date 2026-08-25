/**
 * `createTube`, lowered from its pinned chain: `createTubeData`
 * (src/mesh/create-tube.ts) sweeping a circle along `computePath3D`'s
 * Frenet frames (src/mesh/path3d.ts), triangulated by
 * `createRibbonData` (src/mesh/create-ribbon.ts) with
 * `computeNormals` (src/mesh/compute-normals.ts), finished through the
 * existing native `create_mesh_from_data` under the pin's own "tube"
 * name.
 *
 * The emission is the reached subset, in the camera-controls style:
 * every load-bearing formula is shape-asserted against the pinned AST
 * (the Rodrigues rotation rows, the Frenet tangent/normal/binormal
 * steps, the ribbon's distance tables and triangulation pushes, the
 * seam averaging, the normals accumulation), and the constants flow
 * (the path epsilon, the radius/tessellation defaults, the full-turn
 * step). The cap, arc, radius-function and single-path arms are
 * outside the reached subset: the intrinsic refuses their options by
 * name, and the anchors here pin the pinned defaults that make the
 * dropped arms unreachable (cap NONE starts the circle index at 0,
 * arc 1 keeps the full-turn step).
 *
 * Widths follow the pin exactly: every intermediate is a JS double,
 * and the only float rounding is `createMeshFromData`'s own typed-array
 * stores — the ribbon converts to Float32Array at the very end, which
 * is the `create_mesh_from_data` boundary here.
 */
import ts from "typescript";
import { LoweredSource, LoweringContext } from "../context.js";

export class TubeLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerTube(): LoweredSource {
        const tubeModule = "src/mesh/create-tube.ts";
        const pathModule = "src/mesh/path3d.ts";
        const ribbonModule = "src/mesh/create-ribbon.ts";
        const normalsModule = "src/mesh/compute-normals.ts";

        const { declaration: tubeData } =
            this.context.functionDeclaration(
                tubeModule,
                "createTubeData",
            );
        // The reached defaults and the arms the intrinsic keeps out.
        this.context.assertExpressionShape(
            this.context.variableInitializer(tubeData, "radius"),
            "options.radius ?? 1",
            "Tube radius default",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(tubeData, "tessellation"),
            "(options.tessellation ?? 64) | 0",
            "Tube tessellation default",
        );
        // cap NONE keeps the circle index at 0; arc 1 keeps the full
        // step. Both anchored so the refused arms stay provably
        // unreachable for the reached option set.
        this.context.expectShapeCount(
            tubeData,
            "cap === CAP_NONE || cap === CAP_END ? 0 : 2",
            "Tube cap start index",
        );
        this.context.expectShapeCount(
            tubeData,
            "(pi2 / tessellation) * arc",
            "Tube sweep step",
        );
        this.context.assertExpressionShape(
            this.context.variableInitializer(tubeData, "pi2"),
            "Math.PI * 2",
            "Tube full turn",
        );
        // The swept circle: Rodrigues about the tangent, scaled and
        // translated onto the path point.
        const { declaration: rodrigues } =
            this.context.functionDeclaration(tubeModule, "rodrigues");
        this.context.expectShapeCount(
            rodrigues,
            "v.x * c + crossX * s + k.x * dot * (1 - c)",
            "Rodrigues x row",
        );
        this.context.expectShapeCount(
            rodrigues,
            "v.y * c + crossY * s + k.y * dot * (1 - c)",
            "Rodrigues y row",
        );
        this.context.expectShapeCount(
            rodrigues,
            "v.z * c + crossZ * s + k.z * dot * (1 - c)",
            "Rodrigues z row",
        );
        this.context.expectShapeCount(
            rodrigues,
            "k.x * v.x + k.y * v.y + k.z * v.z",
            "Rodrigues axis dot",
        );
        this.context.expectShapeCount(
            tubeData,
            "rotated.x * rad + path[i].x",
            "Tube circle x",
        );
        this.context.expectShapeCount(
            tubeData,
            "rotated.y * rad + path[i].y",
            "Tube circle y",
        );
        this.context.expectShapeCount(
            tubeData,
            "rotated.z * rad + path[i].z",
            "Tube circle z",
        );
        // The ribbon call the sweep hands off to: closed path, open
        // array.
        const ribbonCall = this.context.callExpression(
            tubeData,
            "createRibbonData",
        );
        const ribbonOptions = this.context.unwrapExpression(
            ribbonCall.arguments[0]!,
        );
        if (!ts.isObjectLiteralExpression(ribbonOptions)) {
            this.context.contractError(
                ribbonCall,
                "Expected literal ribbon options.",
            );
        }
        this.context.assertExpressionShape(
            this.context.propertyInitializer(ribbonOptions, "closePath"),
            "true",
            "Tube ribbon closePath",
        );
        this.context.assertExpressionShape(
            this.context.propertyInitializer(
                ribbonOptions,
                "closeArray",
            ),
            "false",
            "Tube ribbon closeArray",
        );

        // computePath3D: the Frenet chain.
        const { file: pathFile, declaration: path3d } =
            this.context.functionDeclaration(
                pathModule,
                "computePath3D",
            );
        const epsilon = this.context.numericValue(
            this.context.variableInitializer(
                this.context.sourceFile(pathModule),
                "EPSILON",
            ),
            pathFile,
        );
        this.context.expectShapeCount(
            path3d,
            "distances[i - 1] + lengthVec3(subVec3(curve[i], curve[i - 1]))",
            "Path distance accumulation",
        );
        this.context.expectShapeCount(
            path3d,
            "{ x: prev.x + cur.x, y: prev.y + cur.y, z: prev.z + cur.z }",
            "Path tangent sum",
        );
        this.context.expectShapeCount(
            path3d,
            "normalizeVec3(crossVec3(tangents[0], normals[0]))",
            "Path first binormal",
        );
        this.context.expectShapeCount(
            path3d,
            "normalizeVec3(crossVec3(curTang, n))",
            "Path binormal step",
        );
        this.context.expectShapeCount(
            path3d,
            "crossVec3(prevBinor, curTang)",
            "Path normal step",
        );
        const { declaration: normalVector } =
            this.context.functionDeclaration(
                pathModule,
                "normalVector",
            );
        this.context.expectShapeCount(
            normalVector,
            "crossVec3(vt, point)",
            "Path pick-normal cross",
        );
        this.context.expectShapeCount(
            normalVector,
            "crossVec3(c, vt)",
            "Path given-normal cross",
        );

        // createRibbonData: distance tables, triangulation, seam
        // averaging. The single-path split arm is unreachable (the tube
        // always hands one circle per path point, at least two).
        const { declaration: ribbon } =
            this.context.functionDeclaration(
                ribbonModule,
                "createRibbonData",
            );
        this.context.expectShapeCount(
            ribbon,
            "len(sub(path[j], path[j - 1]))",
            "Ribbon u distance",
        );
        this.context.expectShapeCount(
            ribbon,
            "len(sub(path[j], path[0]))",
            "Ribbon closing u distance",
        );
        this.context.expectShapeCount(
            ribbon,
            "len(sub(v2, v1))",
            "Ribbon v distance",
        );
        this.context.expectShapeCount(
            ribbon,
            "indices.push(pi, pi + shft, pi + 1)",
            "Ribbon first triangle",
        );
        this.context.expectShapeCount(
            ribbon,
            "indices.push(pi + shft + 1, pi + 1, pi + shft)",
            "Ribbon second triangle",
        );
        // One per seam block (closePath and closeArray), per lane.
        this.context.expectShapeCount(
            ribbon,
            "(normals[indexFirst] + normals[indexLast]) * 0.5",
            "Ribbon seam average lane 0",
            2,
        );
        this.context.expectShapeCount(
            ribbon,
            "(normals[indexFirst + 1] + normals[indexLast + 1]) * 0.5",
            "Ribbon seam average lane 1",
            2,
        );
        this.context.expectShapeCount(
            ribbon,
            "(normals[indexFirst + 2] + normals[indexLast + 2]) * 0.5",
            "Ribbon seam average lane 2",
            2,
        );
        this.context.expectShapeCount(
            ribbon,
            "us[p][i] / uTotalDistance[p]",
            "Ribbon u normalization",
        );
        this.context.expectShapeCount(
            ribbon,
            "vs[i][p] / vTotalDistance[i]",
            "Ribbon v normalization",
        );

        // The factory finish: createMeshFromData(engine, "tube",
        // positions, normals, indices, uvs) — the name flows, the
        // argument order is the anchor the emitted call mirrors.
        const { declaration: tubeFactory } =
            this.context.functionDeclaration(
                "src/mesh/mesh-factories.ts",
                "createTube",
            );
        const finish = this.context.callExpression(
            tubeFactory,
            "createMeshFromData",
        );
        const finishName = this.context.unwrapExpression(
            finish.arguments[1]!,
        );
        if (
            finish.arguments.length !== 6 ||
            !ts.isStringLiteral(finishName)
        ) {
            this.context.contractError(
                finish,
                "Expected createTube to finish through createMeshFromData with its literal name second.",
            );
        }
        for (const [index, member] of [
            [2, "positions"],
            [3, "normals"],
            [4, "indices"],
            [5, "uvs"],
        ] as const) {
            this.context.assertExpressionShape(
                finish.arguments[index]!,
                `data.${member}`,
                `Tube finish argument ${member}`,
            );
        }
        const tubeName = finishName.text;

        // computeNormals: the face accumulation and normalization.
        const { declaration: computeNormals } =
            this.context.functionDeclaration(
                normalsModule,
                "computeNormals",
            );
        this.context.expectShapeCount(
            computeNormals,
            "p1p2y * p3p2z - p1p2z * p3p2y",
            "Face normal x",
        );
        this.context.expectShapeCount(
            computeNormals,
            "p1p2z * p3p2x - p1p2x * p3p2z",
            "Face normal y",
        );
        this.context.expectShapeCount(
            computeNormals,
            "p1p2x * p3p2y - p1p2y * p3p2x",
            "Face normal z",
        );

        const epsilonLiteral = this.context.doubleLiteral(epsilon);
        return {
            modulePath: tubeModule,
            symbolName: "createTubeData",
            header: "",
            source: `// ${this.context.provenance(
                tubeModule,
                "createTube, createTubeData, rodrigues",
                "src/mesh/path3d.ts computePath3D, src/mesh/create-ribbon.ts createRibbonData, src/mesh/compute-normals.ts computeNormals",
            )}
#include <bblite/runtime.hpp>

#include <cmath>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace bbl {
namespace {

struct TubeVec {
    double x = 0.0;
    double y = 0.0;
    double z = 0.0;
};

double tube_length(const TubeVec& v) {
    return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
}

TubeVec tube_sub(const TubeVec& a, const TubeVec& b) {
    return TubeVec{a.x - b.x, a.y - b.y, a.z - b.z};
}

TubeVec tube_cross(const TubeVec& a, const TubeVec& b) {
    return TubeVec{
        a.y * b.z - a.z * b.y,
        a.z * b.x - a.x * b.z,
        a.x * b.y - a.y * b.x,
    };
}

TubeVec tube_normalize(const TubeVec& v) {
    const double length = tube_length(v);
    if (length == 0.0) {
        return v;
    }
    return TubeVec{v.x / length, v.y / length, v.z / length};
}

bool tube_within_epsilon(double a, double b, double eps) {
    return std::abs(a - b) <= eps;
}

// path3d.ts getFirstNonNullVector / getLastNonNullVector.
TubeVec tube_first_non_null(
    const std::vector<TubeVec>& curve,
    std::size_t index) {
    std::size_t i = 1;
    TubeVec v = tube_sub(curve[index + i], curve[index]);
    while (tube_length(v) == 0.0 && index + i + 1 < curve.size()) {
        ++i;
        v = tube_sub(curve[index + i], curve[index]);
    }
    return v;
}

TubeVec tube_last_non_null(
    const std::vector<TubeVec>& curve,
    std::size_t index) {
    std::size_t i = 1;
    TubeVec v = tube_sub(curve[index], curve[index - i]);
    while (tube_length(v) == 0.0 && index > i + 1) {
        ++i;
        v = tube_sub(curve[index], curve[index - i]);
    }
    return v;
}

// path3d.ts normalVector: the first-frame normal pick.
TubeVec tube_normal_vector(const TubeVec& vt) {
    double tgl = tube_length(vt);
    if (tgl == 0.0) {
        tgl = 1.0;
    }
    constexpr double epsilon = ${epsilonLiteral};
    TubeVec point{};
    if (!tube_within_epsilon(std::abs(vt.y) / tgl, 1.0, epsilon)) {
        point = TubeVec{0.0, -1.0, 0.0};
    } else if (!tube_within_epsilon(std::abs(vt.x) / tgl, 1.0, epsilon)) {
        point = TubeVec{1.0, 0.0, 0.0};
    } else if (!tube_within_epsilon(std::abs(vt.z) / tgl, 1.0, epsilon)) {
        point = TubeVec{0.0, 0.0, 1.0};
    } else {
        point = TubeVec{0.0, 0.0, 0.0};
    }
    return tube_normalize(tube_cross(vt, point));
}

struct TubePath3D {
    std::vector<TubeVec> tangents;
    std::vector<TubeVec> normals;
    std::vector<TubeVec> binormals;
    std::vector<double> distances;
};

// path3d.ts computePath3D, the always-normalized non-raw chain with a
// null firstNormal.
TubePath3D tube_compute_path(const std::vector<TubeVec>& curve) {
    const std::size_t l = curve.size();
    TubePath3D path;
    path.tangents.resize(l);
    path.normals.resize(l);
    path.binormals.resize(l);
    path.distances.resize(l);
    path.tangents[0] = tube_normalize(tube_first_non_null(curve, 0));
    path.tangents[l - 1] =
        tube_normalize(tube_sub(curve[l - 1], curve[l - 2]));
    path.normals[0] =
        tube_normalize(tube_normal_vector(path.tangents[0]));
    path.binormals[0] = tube_normalize(
        tube_cross(path.tangents[0], path.normals[0]));
    path.distances[0] = 0.0;
    for (std::size_t i = 1; i < l; ++i) {
        const TubeVec prev = tube_last_non_null(curve, i);
        if (i < l - 1) {
            const TubeVec cur = tube_first_non_null(curve, i);
            path.tangents[i] = tube_normalize(TubeVec{
                prev.x + cur.x,
                prev.y + cur.y,
                prev.z + cur.z,
            });
        }
        path.distances[i] = path.distances[i - 1] +
            tube_length(tube_sub(curve[i], curve[i - 1]));
        const TubeVec& tangent = path.tangents[i];
        TubeVec n = tube_cross(path.binormals[i - 1], tangent);
        if (tube_length(n) == 0.0) {
            n = path.normals[i - 1];
        } else {
            n = tube_normalize(n);
        }
        path.normals[i] = n;
        path.binormals[i] = tube_normalize(tube_cross(tangent, n));
    }
    return path;
}

// create-tube.ts rodrigues.
TubeVec tube_rodrigues(
    const TubeVec& v,
    const TubeVec& k,
    double angle) {
    const double c = std::cos(angle);
    const double s = std::sin(angle);
    const double dot = k.x * v.x + k.y * v.y + k.z * v.z;
    const double cross_x = k.y * v.z - k.z * v.y;
    const double cross_y = k.z * v.x - k.x * v.z;
    const double cross_z = k.x * v.y - k.y * v.x;
    return TubeVec{
        v.x * c + cross_x * s + k.x * dot * (1.0 - c),
        v.y * c + cross_y * s + k.y * dot * (1.0 - c),
        v.z * c + cross_z * s + k.z * dot * (1.0 - c),
    };
}

// compute-normals.ts computeNormals: face accumulation in f64, one
// normalization pass.
std::vector<double> tube_compute_normals(
    const std::vector<double>& positions,
    const std::vector<std::uint32_t>& indices) {
    std::vector<double> accumulated(positions.size(), 0.0);
    const std::size_t face_count = indices.size() / 3;
    for (std::size_t f = 0; f < face_count; ++f) {
        const std::size_t v1 = indices[f * 3] * 3;
        const std::size_t v2 = indices[f * 3 + 1] * 3;
        const std::size_t v3 = indices[f * 3 + 2] * 3;
        const double p1p2x = positions[v1] - positions[v2];
        const double p1p2y = positions[v1 + 1] - positions[v2 + 1];
        const double p1p2z = positions[v1 + 2] - positions[v2 + 2];
        const double p3p2x = positions[v3] - positions[v2];
        const double p3p2y = positions[v3 + 1] - positions[v2 + 1];
        const double p3p2z = positions[v3 + 2] - positions[v2 + 2];
        double nx = p1p2y * p3p2z - p1p2z * p3p2y;
        double ny = p1p2z * p3p2x - p1p2x * p3p2z;
        double nz = p1p2x * p3p2y - p1p2y * p3p2x;
        double length = std::sqrt(nx * nx + ny * ny + nz * nz);
        if (length == 0.0) {
            length = 1.0;
        }
        nx /= length;
        ny /= length;
        nz /= length;
        accumulated[v1] += nx;
        accumulated[v1 + 1] += ny;
        accumulated[v1 + 2] += nz;
        accumulated[v2] += nx;
        accumulated[v2 + 1] += ny;
        accumulated[v2 + 2] += nz;
        accumulated[v3] += nx;
        accumulated[v3 + 1] += ny;
        accumulated[v3 + 2] += nz;
    }
    std::vector<double> normals(positions.size());
    const std::size_t vertex_count = positions.size() / 3;
    for (std::size_t i = 0; i < vertex_count; ++i) {
        const double x = accumulated[i * 3];
        const double y = accumulated[i * 3 + 1];
        const double z = accumulated[i * 3 + 2];
        double length = std::sqrt(x * x + y * y + z * z);
        if (length == 0.0) {
            length = 1.0;
        }
        normals[i * 3] = x / length;
        normals[i * 3 + 1] = y / length;
        normals[i * 3 + 2] = z / length;
    }
    return normals;
}

} // namespace

// The reached tube: cap NONE, arc 1, uniform radius — the pinned
// defaults that keep the refused option arms unreachable. The circle
// sweep, the closed-path ribbon triangulation, the UV distance
// normalization, the seam-normal averaging and the face-normal
// accumulation are the pinned chain's own arithmetic in JS-double
// width; the only float rounding is create_mesh_from_data's stores,
// which is where the pin's Float32Array conversion sits.
MeshHandle create_tube(
    Engine& engine,
    const std::vector<Vec3d>& path_points,
    double radius,
    double tessellation_option) {
    if (path_points.size() < 2) {
        throw std::runtime_error(
            "createTube requires at least two path points.");
    }
    const std::size_t tessellation = static_cast<std::size_t>(
        static_cast<std::int32_t>(tessellation_option));
    std::vector<TubeVec> curve;
    curve.reserve(path_points.size());
    for (const Vec3d& point : path_points) {
        curve.push_back(TubeVec{point.x, point.y, point.z});
    }
    const TubePath3D frames = tube_compute_path(curve);

    // createTubeData: one circle per path point (cap NONE, arc 1).
    const double pi2 = 3.141592653589793 * 2.0;
    const double step = pi2 / static_cast<double>(tessellation);
    std::vector<std::vector<TubeVec>> circle_paths(curve.size());
    for (std::size_t i = 0; i < curve.size(); ++i) {
        std::vector<TubeVec>& circle = circle_paths[i];
        circle.reserve(tessellation);
        for (std::size_t t = 0; t < tessellation; ++t) {
            const TubeVec rotated = tube_rodrigues(
                frames.normals[i],
                frames.tangents[i],
                step * static_cast<double>(t));
            circle.push_back(TubeVec{
                rotated.x * radius + curve[i].x,
                rotated.y * radius + curve[i].y,
                rotated.z * radius + curve[i].z,
            });
        }
    }

    // createRibbonData over the circles: closePath, open array.
    std::vector<double> positions;
    std::vector<std::uint32_t> indices;
    std::vector<double> uvs;
    std::vector<std::vector<double>> us(circle_paths.size());
    std::vector<double> u_total(circle_paths.size(), 0.0);
    std::vector<std::size_t> lg(circle_paths.size());
    std::vector<std::size_t> idx(circle_paths.size());

    std::size_t minlg = circle_paths[0].size();
    std::size_t idc = 0;
    for (std::size_t p = 0; p < circle_paths.size(); ++p) {
        us[p] = {0.0};
        const std::vector<TubeVec>& path = circle_paths[p];
        const std::size_t l = path.size();
        minlg = minlg < l ? minlg : l;
        for (std::size_t j = 0; j < l; ++j) {
            const TubeVec& pt = path[j];
            positions.push_back(pt.x);
            positions.push_back(pt.y);
            positions.push_back(pt.z);
            if (j > 0) {
                const double vectlg =
                    tube_length(tube_sub(path[j], path[j - 1]));
                const double dist = vectlg + u_total[p];
                us[p].push_back(dist);
                u_total[p] = dist;
            }
        }
        // closePath: the seam vertex repeats the circle start.
        positions.push_back(path[0].x);
        positions.push_back(path[0].y);
        positions.push_back(path[0].z);
        const double vectlg =
            tube_length(tube_sub(path[l - 1], path[0]));
        const double dist = vectlg + u_total[p];
        us[p].push_back(dist);
        u_total[p] = dist;
        lg[p] = l + 1;
        idx[p] = idc;
        idc += l + 1;
    }

    std::vector<double> v_total(minlg + 1, 0.0);
    std::vector<std::vector<double>> vs(minlg + 1);
    for (std::size_t i = 0; i < minlg + 1; ++i) {
        vs[i] = {0.0};
        for (std::size_t p = 0; p + 1 < circle_paths.size(); ++p) {
            const TubeVec& v1 = i == minlg
                ? circle_paths[p][0]
                : circle_paths[p][i];
            const TubeVec& v2 = i == minlg
                ? circle_paths[p + 1][0]
                : circle_paths[p + 1][i];
            const double vectlg = tube_length(tube_sub(v2, v1));
            const double dist = vectlg + v_total[i];
            vs[i].push_back(dist);
            v_total[i] = dist;
        }
    }

    for (std::size_t p = 0; p < circle_paths.size(); ++p) {
        for (std::size_t i = 0; i < minlg + 1; ++i) {
            const double u =
                u_total[p] != 0.0 ? us[p][i] / u_total[p] : 0.0;
            const double v =
                v_total[i] != 0.0 ? vs[i][p] / v_total[i] : 0.0;
            uvs.push_back(u);
            uvs.push_back(v);
        }
    }

    {
        // Babylon's ribbon triangulation, the pin's index walk verbatim.
        std::size_t p = 0;
        std::size_t pi = 0;
        std::size_t l1 = lg[p] - 1;
        std::size_t l2 = lg[p + 1] - 1;
        std::size_t min = l1 < l2 ? l1 : l2;
        std::size_t shft = idx[1] - idx[0];
        const std::size_t path1nb = lg.size() - 1;
        while (pi <= min && p < path1nb) {
            indices.push_back(static_cast<std::uint32_t>(pi));
            indices.push_back(static_cast<std::uint32_t>(pi + shft));
            indices.push_back(static_cast<std::uint32_t>(pi + 1));
            indices.push_back(
                static_cast<std::uint32_t>(pi + shft + 1));
            indices.push_back(static_cast<std::uint32_t>(pi + 1));
            indices.push_back(static_cast<std::uint32_t>(pi + shft));
            pi += 1;
            if (pi == min) {
                ++p;
                if (p >= path1nb) {
                    break;
                }
                shft = idx[p + 1] - idx[p];
                l1 = lg[p] - 1;
                l2 = lg[p + 1] - 1;
                pi = idx[p];
                min = (l1 < l2 ? l1 : l2) + pi;
            }
        }
    }

    std::vector<double> normals =
        tube_compute_normals(positions, indices);

    // closePath seam averaging.
    for (std::size_t p = 0; p < circle_paths.size(); ++p) {
        const std::size_t index_first = idx[p] * 3;
        const std::size_t index_last = p + 1 < circle_paths.size()
            ? (idx[p + 1] - 1) * 3
            : normals.size() - 3;
        normals[index_first] =
            (normals[index_first] + normals[index_last]) * 0.5;
        normals[index_first + 1] =
            (normals[index_first + 1] + normals[index_last + 1]) * 0.5;
        normals[index_first + 2] =
            (normals[index_first + 2] + normals[index_last + 2]) * 0.5;
        double nl = std::sqrt(
            normals[index_first] * normals[index_first] +
            normals[index_first + 1] * normals[index_first + 1] +
            normals[index_first + 2] * normals[index_first + 2]);
        if (nl == 0.0) {
            nl = 1.0;
        }
        normals[index_first] = normals[index_first] / nl;
        normals[index_first + 1] = normals[index_first + 1] / nl;
        normals[index_first + 2] = normals[index_first + 2] / nl;
        normals[index_last] = normals[index_first];
        normals[index_last + 1] = normals[index_first + 1];
        normals[index_last + 2] = normals[index_first + 2];
    }

    // The pin finishes through createMeshFromData(engine, "tube",
    // positions, normals, indices, uvs) — Float32Array conversion
    // happens at these stores.
    std::vector<float> positions_f32(positions.begin(), positions.end());
    std::vector<float> normals_f32(normals.begin(), normals.end());
    std::vector<float> uvs_f32(uvs.begin(), uvs.end());
    return create_mesh_from_data(
        engine,
        "${tubeName}",
        positions_f32,
        normals_f32,
        indices,
        uvs_f32,
        {},
        {},
        {});
}

} // namespace bbl
`,
        };
    }
}
