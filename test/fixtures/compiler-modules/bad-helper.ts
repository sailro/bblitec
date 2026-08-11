import type { EngineContext } from "@babylonjs/lite";

export function unsupportedLoop(
    engine: EngineContext,
): void {
    for (let index = 0; index < 1; index += 1) {
        void engine;
    }
}
