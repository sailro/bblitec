import { LoweredSource, LoweringContext } from "./context.js";
import { babylonLoaderCpp } from "./templates/babylon-loader-cpp.js";

export class BabylonLowerer {
    public constructor(private readonly context: LoweringContext) {}

    public lowerLoaderAdapter(): LoweredSource {
        const modulePath = "src/loader-babylon/load-babylon.ts";
        const symbolName = "loadBabylon";
        const source = this.context.store.getSource(modulePath);
        for (const marker of [
            "createStandardMaterial()",
            "md.subMeshes ??",
            "parseBabylonCamera(camData)",
            "return { entities: [...lights, ...rootMeshes",
        ]) {
            if (!source.includes(marker)) {
                throw new Error(
                    `Pinned Babylon loader contract changed: ${marker}.`,
                );
            }
        }
        return {
            modulePath,
            symbolName,
            header: "",
            source: babylonLoaderCpp(
                this.context.provenance(modulePath, symbolName),
            ),
        };
    }
}
