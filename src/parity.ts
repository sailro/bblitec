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

export interface DiffRegionSummary {
    pixels: number;
    mad: number;
    maxDiff: number;
}

export interface DiffHotspot extends DiffRegionSummary {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface DiffBreakdown {
    channelMad: { red: number; green: number; blue: number };
    foregroundBias: { red: number; green: number; blue: number };
    regions: {
        background: DiffRegionSummary;
        foregroundEdge: DiffRegionSummary;
        foregroundInterior: DiffRegionSummary;
    };
    hotspots: DiffHotspot[];
}

export interface DrawDiffSummary extends DiffRegionSummary {
    drawId: number;
    bounds: { x: number; y: number; width: number; height: number };
}

export interface HotspotDrawAttribution {
    x: number;
    y: number;
    width: number;
    height: number;
    drawIds: Array<{ drawId: number; pixels: number }>;
}

export interface IdDiffBreakdown {
    draws: DrawDiffSummary[];
    hotspots: HotspotDrawAttribution[];
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

function regionSummary(pixels: number, sum: number, maxDiff: number): DiffRegionSummary {
    return {
        pixels,
        mad: pixels > 0 ? sum / pixels : 0,
        maxDiff,
    };
}

export function analyzeDifference(
    actualPath: string,
    referencePath: string,
    backgroundColor: [number, number, number] = [51, 51, 77],
    backgroundThreshold = 30,
    tileSize = 64,
): DiffBreakdown {
    const actual = loadPng(actualPath);
    const reference = loadPng(referencePath);
    const width = Math.min(actual.width, reference.width);
    const height = Math.min(actual.height, reference.height);
    const foreground = new Uint8Array(width * height);
    const gradient = new Uint8Array(width * height);
    const channelSum = [0, 0, 0];
    const foregroundBias = [0, 0, 0];
    let foregroundPixels = 0;

    const referencePixel = (x: number, y: number, channel: number): number =>
        reference.data[(y * reference.width + x) * 4 + channel]!;
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            const red = referencePixel(x, y, 0) - backgroundColor[0];
            const green = referencePixel(x, y, 1) - backgroundColor[1];
            const blue = referencePixel(x, y, 2) - backgroundColor[2];
            foreground[index] =
                Math.sqrt(red * red + green * green + blue * blue) > backgroundThreshold ? 1 : 0;
            if (foreground[index]) foregroundPixels += 1;
            const actualIndex = (y * actual.width + x) * 4;
            const referenceIndex = (y * reference.width + x) * 4;
            for (let channel = 0; channel < 3; channel += 1) {
                const signed = actual.data[actualIndex + channel]! - reference.data[referenceIndex + channel]!;
                channelSum[channel]! += Math.abs(signed);
                if (foreground[index]) foregroundBias[channel]! += signed;
            }
        }
    }

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const index = y * width + x;
            if (!foreground[index]) continue;
            let isEdge = false;
            for (let offsetY = -1; offsetY <= 1 && !isEdge; offsetY += 1) {
                for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
                    if (offsetX === 0 && offsetY === 0) continue;
                    const nx = x + offsetX;
                    const ny = y + offsetY;
                    if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
                        isEdge = true;
                        break;
                    }
                    const neighbor = ny * width + nx;
                    if (!foreground[neighbor]) {
                        isEdge = true;
                        break;
                    }
                    let colorDelta = 0;
                    for (let channel = 0; channel < 3; channel += 1) {
                        colorDelta = Math.max(
                            colorDelta,
                            Math.abs(referencePixel(x, y, channel) - referencePixel(nx, ny, channel)),
                        );
                    }
                    if (colorDelta > 24) {
                        isEdge = true;
                        break;
                    }
                }
            }
            gradient[index] = isEdge ? 1 : 0;
        }
    }

    const sums = {
        background: { pixels: 0, sum: 0, max: 0 },
        foregroundEdge: { pixels: 0, sum: 0, max: 0 },
        foregroundInterior: { pixels: 0, sum: 0, max: 0 },
    };
    const tiles: DiffHotspot[] = [];
    for (let tileY = 0; tileY < height; tileY += tileSize) {
        for (let tileX = 0; tileX < width; tileX += tileSize) {
            let tilePixels = 0;
            let tileSum = 0;
            let tileMax = 0;
            const tileWidth = Math.min(tileSize, width - tileX);
            const tileHeight = Math.min(tileSize, height - tileY);
            for (let y = tileY; y < tileY + tileHeight; y += 1) {
                for (let x = tileX; x < tileX + tileWidth; x += 1) {
                    const index = y * width + x;
                    const difference = comparePixel(actual, reference, x, y);
                    const key = !foreground[index]
                        ? "background"
                        : gradient[index]
                            ? "foregroundEdge"
                            : "foregroundInterior";
                    sums[key].pixels += 1;
                    sums[key].sum += difference.average;
                    sums[key].max = Math.max(sums[key].max, difference.max);
                    if (foreground[index]) {
                        tilePixels += 1;
                        tileSum += difference.average;
                        tileMax = Math.max(tileMax, difference.max);
                    }
                }
            }
            const minimumTilePixels =
                width * height <= tileSize * tileSize
                    ? 1
                    : Math.max(16, Math.ceil(tileWidth * tileHeight * 0.01));
            if (tilePixels >= minimumTilePixels) {
                tiles.push({
                    x: tileX,
                    y: tileY,
                    width: tileWidth,
                    height: tileHeight,
                    ...regionSummary(tilePixels, tileSum, tileMax),
                });
            }
        }
    }
    tiles.sort((left, right) => right.mad - left.mad || right.maxDiff - left.maxDiff);

    return {
        channelMad: {
            red: channelSum[0]! / (width * height),
            green: channelSum[1]! / (width * height),
            blue: channelSum[2]! / (width * height),
        },
        foregroundBias: {
            red: foregroundPixels > 0 ? foregroundBias[0]! / foregroundPixels : 0,
            green: foregroundPixels > 0 ? foregroundBias[1]! / foregroundPixels : 0,
            blue: foregroundPixels > 0 ? foregroundBias[2]! / foregroundPixels : 0,
        },
        regions: {
            background: regionSummary(sums.background.pixels, sums.background.sum, sums.background.max),
            foregroundEdge: regionSummary(
                sums.foregroundEdge.pixels,
                sums.foregroundEdge.sum,
                sums.foregroundEdge.max,
            ),
            foregroundInterior: regionSummary(
                sums.foregroundInterior.pixels,
                sums.foregroundInterior.sum,
                sums.foregroundInterior.max,
            ),
        },
        hotspots: tiles.slice(0, 12),
    };
}

export function generateHotspotMap(
    actualPath: string,
    hotspots: readonly DiffHotspot[],
    outputPath: string,
): void {
    const actual = loadPng(actualPath);
    const output = new PNG({ width: actual.width, height: actual.height });
    output.data.set(actual.data);
    const setPixel = (x: number, y: number, color: [number, number, number]): void => {
        if (x < 0 || y < 0 || x >= output.width || y >= output.height) return;
        const index = (y * output.width + x) * 4;
        output.data[index] = color[0];
        output.data[index + 1] = color[1];
        output.data[index + 2] = color[2];
        output.data[index + 3] = 255;
    };
    hotspots.forEach((hotspot, rank) => {
        const color: [number, number, number] = rank === 0 ? [255, 64, 64] : [255, 190, 0];
        for (let thickness = 0; thickness < 3; thickness += 1) {
            const left = hotspot.x + thickness;
            const top = hotspot.y + thickness;
            const right = hotspot.x + hotspot.width - 1 - thickness;
            const bottom = hotspot.y + hotspot.height - 1 - thickness;
            for (let x = left; x <= right; x += 1) {
                setPixel(x, top, color);
                setPixel(x, bottom, color);
            }
            for (let y = top; y <= bottom; y += 1) {
                setPixel(left, y, color);
                setPixel(right, y, color);
            }
        }
    });
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, PNG.sync.write(output));
}

export function analyzeIdBuffer(
    actualPath: string,
    referencePath: string,
    idPath: string,
    hotspots: readonly DiffHotspot[] = [],
): IdDiffBreakdown {
    const actual = loadPng(actualPath);
    const reference = loadPng(referencePath);
    const ids = loadPng(idPath);
    const width = Math.min(actual.width, reference.width, ids.width);
    const height = Math.min(actual.height, reference.height, ids.height);
    const draws = new Map<
        number,
        { pixels: number; sum: number; max: number; minX: number; minY: number; maxX: number; maxY: number }
    >();
    const idAt = (x: number, y: number): number => {
        const index = (y * ids.width + x) * 4;
        return ids.data[index]! | (ids.data[index + 1]! << 8) | (ids.data[index + 2]! << 16);
    };
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const drawId = idAt(x, y);
            if (drawId === 0) continue;
            const difference = comparePixel(actual, reference, x, y);
            const entry = draws.get(drawId) ?? {
                pixels: 0,
                sum: 0,
                max: 0,
                minX: x,
                minY: y,
                maxX: x,
                maxY: y,
            };
            entry.pixels += 1;
            entry.sum += difference.average;
            entry.max = Math.max(entry.max, difference.max);
            entry.minX = Math.min(entry.minX, x);
            entry.minY = Math.min(entry.minY, y);
            entry.maxX = Math.max(entry.maxX, x);
            entry.maxY = Math.max(entry.maxY, y);
            draws.set(drawId, entry);
        }
    }
    return {
        draws: [...draws.entries()]
            .map(([drawId, entry]) => ({
                drawId,
                ...regionSummary(entry.pixels, entry.sum, entry.max),
                bounds: {
                    x: entry.minX,
                    y: entry.minY,
                    width: entry.maxX - entry.minX + 1,
                    height: entry.maxY - entry.minY + 1,
                },
            }))
            .sort((left, right) => right.mad - left.mad || right.pixels - left.pixels),
        hotspots: hotspots.map((hotspot) => {
            const counts = new Map<number, number>();
            for (let y = hotspot.y; y < hotspot.y + hotspot.height && y < height; y += 1) {
                for (let x = hotspot.x; x < hotspot.x + hotspot.width && x < width; x += 1) {
                    const drawId = idAt(x, y);
                    if (drawId !== 0) counts.set(drawId, (counts.get(drawId) ?? 0) + 1);
                }
            }
            return {
                x: hotspot.x,
                y: hotspot.y,
                width: hotspot.width,
                height: hotspot.height,
                drawIds: [...counts.entries()]
                    .map(([drawId, pixels]) => ({ drawId, pixels }))
                    .sort((left, right) => right.pixels - left.pixels),
            };
        }),
    };
}

export function generateIdVisualization(idPath: string, outputPath: string): void {
    const ids = loadPng(idPath);
    const output = new PNG({ width: ids.width, height: ids.height });
    for (let y = 0; y < ids.height; y += 1) {
        for (let x = 0; x < ids.width; x += 1) {
            const index = (y * ids.width + x) * 4;
            const drawId =
                ids.data[index]! |
                (ids.data[index + 1]! << 8) |
                (ids.data[index + 2]! << 16);
            if (drawId === 0) {
                output.data[index] = 0;
                output.data[index + 1] = 0;
                output.data[index + 2] = 0;
                output.data[index + 3] = 255;
                continue;
            }
            output.data[index] = 55 + (drawId * 97) % 200;
            output.data[index + 1] = 55 + (drawId * 57) % 200;
            output.data[index + 2] = 55 + (drawId * 137) % 200;
            output.data[index + 3] = 255;
        }
    }
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, PNG.sync.write(output));
}
