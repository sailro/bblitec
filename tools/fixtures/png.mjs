// The small images the project-owned glTF fixtures embed.
//
// `pngjs` is the repository's one PNG library (`src/parity.ts` reads and
// writes every capture through it), so the encoding is its `PNG.sync.write`
// rather than a second one; what lives here is the pattern the fixtures want.
import { PNG } from "pngjs";

/**
 * A `size` x `size` PNG split into four quadrants, `colors` being
 * `[topLeft, topRight, bottomLeft, bottomRight]` as RGB or RGBA.
 *
 * Four flat blocks is what makes a UV set readable off a rendered pixel: a
 * slot sampling the wrong set shows one colour where the other shows four.
 */
export function quadrantPng(size, colors) {
    const png = new PNG({ width: size, height: size });
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const quadrant = (y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1);
            const color = colors[quadrant];
            const offset = (y * size + x) * 4;
            png.data[offset] = color[0];
            png.data[offset + 1] = color[1];
            png.data[offset + 2] = color[2];
            png.data[offset + 3] = color[3] ?? 255;
        }
    }
    return PNG.sync.write(png);
}
