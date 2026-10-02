import assert from "node:assert/strict";
import { loadPng } from "./support.mjs";

/** @import { PluginContext } from "../../dist/src/tooling/check-run.js" */

const blue = [128, 184, 240];
const green = [96, 192, 160];
const orange = [224, 152, 64];
const violet = [176, 144, 208];
const board = [56, 72, 88];
const background = [32, 40, 48];
const probes = [
    {
        name: "vacated spanning cell",
        x: 80,
        y: 200,
        idle: green,
        activate: board,
    },
    {
        name: "end-relative placement",
        x: 250,
        y: 200,
        idle: violet,
        activate: green,
    },
    {
        name: "reflowed automatic cell",
        x: 250,
        y: 70,
        idle: board,
        activate: violet,
    },
    {
        name: "auto-fit resized tracks",
        x: 640,
        y: 65,
        idle: orange,
        activate: green,
    },
    {
        name: "auto-fit resized boundary",
        x: 755,
        y: 65,
        idle: green,
        activate: background,
    },
    {
        name: "reversible isolation",
        x: 550,
        y: 400,
        idle: blue,
        activate: orange,
    },
    {
        name: "unchanged auto-fill cell",
        x: 490,
        y: 135,
        idle: blue,
        activate: blue,
    },
];

/** @param {PluginContext} context */
export function check(context) {
    let samples = 0;
    for (const backend of context.backends) {
        for (const id of /** @type {const} */ (["idle", "activate"])) {
            const phase = context.results[backend]?.[id];
            assert(phase, `${backend}: missing ${id}`);
            const image = loadPng(phase.image);
            for (const probe of probes) {
                assert(probe.x + 1 < image.width && probe.y + 1 < image.height);
                for (let y = probe.y - 1; y <= probe.y + 1; ++y) {
                    for (let x = probe.x - 1; x <= probe.x + 1; ++x) {
                        const offset = (y * image.width + x) * 4;
                        for (const [channel, expected] of probe[id].entries()) {
                            const actual = image.data.readUInt8(
                                offset + channel,
                            );
                            assert(
                                Math.abs(actual - expected) <= 1,
                                `${backend}/${id}: ${probe.name} at ${x},${y}, channel ${channel}: ${actual} != ${expected}`,
                            );
                        }
                        samples++;
                    }
                }
            }
        }
    }
    return { details: { samples } };
}
