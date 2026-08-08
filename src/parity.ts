import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PNG } from "pngjs";

export interface CompareResult {
    totalPixels: number;
    exactMatch: number;
    within1: number;
    within3: number;
    within5: number;
    mad: number;
    maxDiff: number;
}

export interface RegionResult extends CompareResult {
    regionPixels: number;
}

interface PngImage {
    width: number;
    height: number;
    data: Uint8Array;
}

// Matches Babylon-Lite/tests/shared/compare-core.ts (Apache-2.0).
function loadPng(path: string): PngImage {
    const png = PNG.sync.read(readFileSync(path));
    return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}

export function imageDimensions(path: string): { width: number; height: number } {
    const image = loadPng(path);
    return { width: image.width, height: image.height };
}

function comparePixel(actual: PngImage, reference: PngImage, x: number, y: number): { max: number; average: number } {
    const actualIndex = (y * actual.width + x) * 4;
    const referenceIndex = (y * reference.width + x) * 4;
    let max = 0;
    let sum = 0;
    for (let channel = 0; channel < 3; channel += 1) {
        const difference = Math.abs(actual.data[actualIndex + channel]! - reference.data[referenceIndex + channel]!);
        sum += difference;
        max = Math.max(max, difference);
    }
    return { max, average: sum / 3 };
}

function addPixel(result: CompareResult, difference: { max: number; average: number }): void {
    result.mad += difference.average;
    result.maxDiff = Math.max(result.maxDiff, difference.max);
    if (difference.max === 0) result.exactMatch += 1;
    if (difference.max <= 1) result.within1 += 1;
    if (difference.max <= 3) result.within3 += 1;
    if (difference.max <= 5) result.within5 += 1;
}

function emptyResult(totalPixels: number): CompareResult {
    return {
        totalPixels,
        exactMatch: 0,
        within1: 0,
        within3: 0,
        within5: 0,
        mad: 0,
        maxDiff: 0,
    };
}

export function compareImages(actualPath: string, referencePath: string): CompareResult {
    const actual = loadPng(actualPath);
    const reference = loadPng(referencePath);
    const width = Math.min(actual.width, reference.width);
    const height = Math.min(actual.height, reference.height);
    const result = emptyResult(width * height);

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            addPixel(result, comparePixel(actual, reference, x, y));
        }
    }
    result.mad /= result.totalPixels;
    return result;
}

export function compareRegion(
    actualPath: string,
    referencePath: string,
    backgroundColor: [number, number, number] = [51, 51, 77],
    threshold = 30,
): RegionResult {
    const actual = loadPng(actualPath);
    const reference = loadPng(referencePath);
    const width = Math.min(actual.width, reference.width);
    const height = Math.min(actual.height, reference.height);
    const result: RegionResult = { ...emptyResult(width * height), regionPixels: 0 };

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const referenceIndex = (y * reference.width + x) * 4;
            const red = reference.data[referenceIndex]! - backgroundColor[0];
            const green = reference.data[referenceIndex + 1]! - backgroundColor[1];
            const blue = reference.data[referenceIndex + 2]! - backgroundColor[2];
            if (Math.sqrt(red * red + green * green + blue * blue) <= threshold) {
                continue;
            }
            result.regionPixels += 1;
            addPixel(result, comparePixel(actual, reference, x, y));
        }
    }
    result.mad = result.regionPixels > 0 ? result.mad / result.regionPixels : 0;
    return result;
}

export function generateDiffMap(actualPath: string, referencePath: string, outputPath: string): void {
    const actual = loadPng(actualPath);
    const reference = loadPng(referencePath);
    const width = Math.min(actual.width, reference.width);
    const height = Math.min(actual.height, reference.height);
    const diff = new PNG({ width, height });

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const outputIndex = (y * width + x) * 4;
            const difference = comparePixel(actual, reference, x, y).max;
            diff.data[outputIndex] = difference > 5 ? 255 : 0;
            diff.data[outputIndex + 1] = Math.min(255, difference * 4);
            diff.data[outputIndex + 2] = difference > 1 ? 180 : 0;
            diff.data[outputIndex + 3] = difference > 0 ? 255 : 0;
        }
    }

    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, PNG.sync.write(diff));
}
