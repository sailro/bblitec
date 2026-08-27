import { createEngine, createSceneContext, registerScene, startEngine } from "babylon-lite";

async function main(): Promise<void> {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    const scene = createSceneContext(engine);
    const paths: { x: number; y: number; z: number }[][] = [];
    for (let p = 0; p < 2; p++) {
        const row: { x: number; y: number; z: number }[] = [];
        for (let i = 0; i < 3; i++) {
            row.push({ x: i, y: p, z: 0 });
        }
        paths.push(row);
    }
    await registerScene(scene);
    await startEngine(engine);
}
void main();
