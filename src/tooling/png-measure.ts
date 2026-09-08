/**
 * `scene -- measure`: the non-background bounding box, pixel count and
 * per-channel means of one PNG.
 *
 * The measure-the-PNG rule as a command: "the sprites are in the wrong
 * place" becomes "exactly 7200 px at (640,180)-(719,269)", coordinates
 * that invert through a vertex shader where an eyeballing never does.
 * Background matching is exact, because "exactly" is the point — native
 * renders clear to one solid color. Browser goldens dither their
 * background by design, so measure the native PNG, or expect the
 * dithered pixels to count as content.
 */
import { readFileSync } from "node:fs";
import { PNG } from "pngjs";

export interface PngMeasurement {
    width: number;
    height: number;
    background: [number, number, number];
    backgroundSource: "explicit" | "top-left";
    /** Pixels whose RGB differs from the background, exactly. */
    pixels: number;
    /** Inclusive corners; absent when every pixel is background. */
    bounds?: { minX: number; minY: number; maxX: number; maxY: number };
    /** Per-channel means over the non-background pixels. */
    mean?: { red: number; green: number; blue: number };
}

export function measurePng(
    path: string,
    background?: [number, number, number],
): PngMeasurement {
    const png = PNG.sync.read(readFileSync(path));
    const data = png.data;
    const resolved: [number, number, number] = background ?? [
        data[0]!,
        data[1]!,
        data[2]!,
    ];
    let pixels = 0;
    let minX = png.width;
    let minY = png.height;
    let maxX = -1;
    let maxY = -1;
    const sum = [0, 0, 0];
    for (let y = 0; y < png.height; y += 1) {
        for (let x = 0; x < png.width; x += 1) {
            const index = (y * png.width + x) * 4;
            if (
                data[index] === resolved[0] &&
                data[index + 1] === resolved[1] &&
                data[index + 2] === resolved[2]
            ) {
                continue;
            }
            pixels += 1;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
            sum[0]! += data[index]!;
            sum[1]! += data[index + 1]!;
            sum[2]! += data[index + 2]!;
        }
    }
    return {
        width: png.width,
        height: png.height,
        background: resolved,
        backgroundSource: background ? "explicit" : "top-left",
        pixels,
        ...(pixels > 0
            ? {
                  bounds: { minX, minY, maxX, maxY },
                  mean: {
                      red: sum[0]! / pixels,
                      green: sum[1]! / pixels,
                      blue: sum[2]! / pixels,
                  },
              }
            : {}),
    };
}

export function formatPngMeasurement(
    path: string,
    measurement: PngMeasurement,
): string {
    const lines = [
        `${path}: ${measurement.width}x${measurement.height}, ` +
            `background ${measurement.background.join(",")}` +
            (measurement.backgroundSource === "top-left"
                ? " (top-left pixel)"
                : ""),
    ];
    if (!measurement.bounds || !measurement.mean) {
        lines.push("Every pixel is the background color.");
        return lines.join("\n");
    }
    const { minX, minY, maxX, maxY } = measurement.bounds;
    lines.push(
        `${measurement.pixels} non-background px in ` +
            `(${minX},${minY})-(${maxX},${maxY}) ` +
            `(${maxX - minX + 1}x${maxY - minY + 1} box)`,
    );
    lines.push(
        `mean RGB over those pixels: ${measurement.mean.red.toFixed(2)}, ` +
            `${measurement.mean.green.toFixed(2)}, ` +
            `${measurement.mean.blue.toFixed(2)}`,
    );
    return lines.join("\n");
}
