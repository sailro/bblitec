import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compileSource } from "./compiler.js";
import { readNativeHostUi } from "./native-host-ui.js";
import { scenes } from "./scene-registry.js";
import { readBabylonLiteCorpus } from "./upstream-corpus.js";

const corpus = readBabylonLiteCorpus();
const required = [...corpus.scenes.map(scene => ({ id: scene.id, source: scene.source })),
    ...corpus.applications.map(demo => ({ id: demo.id, source: demo.entry }))];
const missing = required.filter(entry => !scenes.some(scene => scene.id === entry.id && scene.source === entry.source));
if (missing.length) throw new Error(`API collection omits corpus entries: ${missing.map(entry => entry.id).join(", ")}`);

// Generation only, with the registry's query and host companion. No native outputs
// are overwritten by this measurement.
for (const scene of scenes) {
    process.env.BBLITE_API_SCENE = `scene:${scene.id}`;
    compileSource(readFileSync(scene.source, "utf8"), {
        fileName: resolve(scene.source), title: scene.title,
        search: scene.parity?.referenceSearch ?? "",
        ...(scene.nativeHostUi ? { nativeHostUi: readNativeHostUi(scene.nativeHostUi) } : {}),
    });
    console.log(`API generation passed: ${scene.id}`);
}
