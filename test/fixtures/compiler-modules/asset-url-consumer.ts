import { loadTexture2D, type EngineContext } from "@babylonjs/lite";
import { moduleAssetUrl } from "./asset-url-helper.js";

export async function loadModuleTexture(engine: EngineContext): Promise<void> {
    await loadForwardedTexture(
        engine,
        moduleAssetUrl("./brdf-lut.png", import.meta.url),
    );
}

async function loadForwardedTexture(
    engine: EngineContext,
    url: string,
): Promise<void> {
    await loadTexture2D(engine, url);
}
