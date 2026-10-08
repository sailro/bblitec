import assert from "node:assert/strict";
import test from "node:test";
import { Worker } from "node:worker_threads";

test(
    "conditional style writes compile within a bounded worker heap",
    { timeout: 30_000 },
    async (t) => {
        const properties = [
            "width",
            "height",
            "left",
            "top",
            "right",
            "bottom",
            "margin-top",
            "margin-right",
            "margin-bottom",
            "margin-left",
            "padding-top",
            "padding-right",
            "padding-bottom",
            "padding-left",
            "border-top-width",
            "border-right-width",
            "border-bottom-width",
            "border-left-width",
            "font-size",
            "line-height",
            "letter-spacing",
            "min-width",
            "min-height",
            "max-width",
        ];
        const source = `
        import {createEngine} from '@babylonjs/lite';
        await createEngine({});
        const panel = document.createElement('div');
        ${properties.map((name) => `if (Math.random() > 0.5) panel.style.setProperty('${name}', '1px');`).join("\n")}
        document.body.appendChild(panel);
    `;
        const worker = new Worker(
            `
        const {parentPort, workerData} = require('node:worker_threads');
        import(workerData.compiler).then(({compileSource}) => {
            parentPort.postMessage(compileSource(workerData.source).cpp);
        }).catch(error => { throw error; });
    `,
            {
                eval: true,
                workerData: {
                    compiler: new URL("../src/compiler.js", import.meta.url)
                        .href,
                    source,
                },
                resourceLimits: {
                    maxOldGenerationSizeMb: 1536,
                    stackSizeMb: 16,
                },
            },
        );
        t.after(async () => {
            await worker.terminate();
        });
        const cpp = await new Promise<string>((resolve, reject) => {
            worker.once("message", (message: unknown) => {
                if (typeof message === "string") resolve(message);
                else
                    reject(
                        new Error(
                            "Compiler worker did not return generated code",
                        ),
                    );
            });
            worker.once("error", reject);
            worker.once("exit", (code) => {
                if (code !== 0)
                    reject(new Error(`Compiler worker exited ${code}`));
            });
        });
        for (const property of properties)
            assert.ok(cpp.includes(`"${property}"`));
        assert.ok(
            (cpp.match(/bbl::ui_set_style_property\(/g) ?? []).length >=
                properties.length,
        );
    },
);
