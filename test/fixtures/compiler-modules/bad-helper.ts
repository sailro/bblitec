import type { EngineContext } from "@babylonjs/lite";

export function unsupportedLoop(
    engine: EngineContext,
): void {
    do {
        void engine;
    } while (false);
}
