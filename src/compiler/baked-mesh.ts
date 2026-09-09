import { packBakedCsgMesh, type BakedCsgMesh } from "../pinned-csg.js";
import type { LoweringServices } from "./lowering-services.js";

/** Package the pin's typed streams and load them once for this mesh construction. */
export function compileBakedMesh(
    context: Pick<LoweringServices, "registerAsset" | "allocateTemporaryCppName" | "cppString" | "emit">,
    mesh: BakedCsgMesh,
): { positions: string; normals: string; uvs: string; indices: string } {
    const payload = Buffer.from(packBakedCsgMesh(mesh)).toString("base64");
    const asset = context.registerAsset(`data:application/x-bblite-mesh;base64,${payload}`, "binary");
    const cpp = context.allocateTemporaryCppName("baked_geometry");
    context.emit({ kind: "declaration", type: "const auto", name: cpp, initializer: `bbl::read_baked_mesh(bbl::pal::read_binary_file(bbl::asset_path(${context.cppString(asset.output)})))` });
    return {
        positions: `${cpp}.positions`, normals: `${cpp}.normals`,
        uvs: `${cpp}.uvs`, indices: `${cpp}.indices`,
    };
}
