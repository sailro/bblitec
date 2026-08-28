#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { PNG } from "pngjs";

const [, , inputArgument, outputArgument] = process.argv;
if (!inputArgument || !outputArgument) {
    throw new Error("Usage: node tools/create-status-preview.mjs <input.png> <output.png>");
}

const input = PNG.sync.read(readFileSync(resolve(inputArgument)));
const scale = 4;
if (input.width % scale !== 0 || input.height % scale !== 0) {
    throw new Error(`${input.width}x${input.height} is not divisible by ${scale}.`);
}
const output = new PNG({
    width: input.width / scale,
    height: input.height / scale,
});
for (let y = 0; y < output.height; y++) {
    for (let x = 0; x < output.width; x++) {
        const sums = [0, 0, 0, 0];
        for (let dy = 0; dy < scale; dy++) {
            for (let dx = 0; dx < scale; dx++) {
                const source =
                    ((y * scale + dy) * input.width + x * scale + dx) * 4;
                for (let channel = 0; channel < 4; channel++) {
                    sums[channel] += input.data[source + channel];
                }
            }
        }
        const target = (y * output.width + x) * 4;
        for (let channel = 0; channel < 4; channel++) {
            output.data[target + channel] = Math.round(
                sums[channel] / (scale * scale),
            );
        }
    }
}

const outputPath = resolve(outputArgument);
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, PNG.sync.write(output));
