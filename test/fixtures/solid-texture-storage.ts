import { createEngine, createSolidTexture2D, type Texture2D } from "@babylonjs/lite";
interface TextureOwner { texture: Texture2D }

function check(stored: Texture2D[], direct: Texture2D, alias: Texture2D, record: TextureOwner) {
    if (stored[0] !== direct || stored[1] !== alias || direct !== alias) throw new Error("texture identity lost");
    if (stored[0] === stored[2]) throw new Error("texture construction merged");
    if (record.texture !== stored[0]) throw new Error("record texture identity lost");
}

async function main() {
    const canvas = document.getElementById("renderCanvas") as HTMLCanvasElement;
    const engine = await createEngine(canvas);
    let calls = 0;
    function make(): Texture2D {
        calls++;
        return createSolidTexture2D(engine, 0.25, 0.5, 0.75, 1);
    }
    function retain(texture: Texture2D): Texture2D { return texture; }
    const direct = createSolidTexture2D(engine, 0.25, 0.5, 0.75, 1);
    const alias = direct;
    const stored: Texture2D[] = [direct, retain(alias), make()];
    const record: TextureOwner = { texture: direct };
    check(stored, direct, alias, record);
    if (calls !== 1) throw new Error("texture construction duplicated");
}
main();
