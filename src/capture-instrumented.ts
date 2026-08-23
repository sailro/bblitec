// Instrumented browser capture: renders a scene through the pinned
// Babylon Lite package exactly like the parity reference capture, but
// with WebGPU entry points hooked so the browser's composed WGSL,
// uploaded buffers and textures, and draw calls are dumped for
// bit-level comparison against the native uploads. This is the
// differential tool that resolved the scene 243 occlusion gap and the
// scene 247 shading contracts; hooks cover render-bundle encoders
// because Babylon Lite records mesh draws into bundles, so
// pass-encoder hooks alone would miss every mesh draw.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
    createSuiteSceneServer,
    suiteBrowserModule,
} from "./capture-suite-reference.js";
import {
    screenshotCaptureBrowserArgs,
    waitForSceneReady,
    withBrowserPage,
} from "./browser-harness.js";
import {
    captureBuffersPath,
    captureDrawsPath,
    captureMetaPath,
    captureShadersDirectory,
    defaultCaptureDirectory,
} from "./parity-scene.js";
import { resolveScene } from "./scene-registry.js";

export interface InstrumentedCaptureOptions {
    seekSeconds?: number;
    skipDrawIndexCount?: number;
    outputDirectory?: string;
}

// Runs inside the page before any scene script. Written as source
// text so WebGPU types stay out of the Node compilation. Buffer
// writes keep the last eight per buffer (uploads are stable once the
// pose freezes) and payloads above 32 MiB record only their size.
function initScript(skipDrawIndexCount: number): string {
    return `(() => {
  const skipDrawIndexCount = ${skipDrawIndexCount};
  const b64 = (u8) => {
    let s = "";
    for (let i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    }
    return btoa(s);
  };
  const dump = { shaders: [], buffers: [] };
  window.__wgpuDump = dump;
  window.__draws = {};
  window.__texUploads = [];
  let nextBufferId = 1;
  let nextTextureId = 1;
  const bufferMeta = new WeakMap();
  const textureMeta = new WeakMap();

  const origCreateShaderModule = GPUDevice.prototype.createShaderModule;
  GPUDevice.prototype.createShaderModule = function (desc) {
    dump.shaders.push({ label: (desc && desc.label) || "", code: (desc && desc.code) || "" });
    return origCreateShaderModule.call(this, desc);
  };

  const origCreateTexture = GPUDevice.prototype.createTexture;
  GPUDevice.prototype.createTexture = function (desc) {
    const texture = origCreateTexture.call(this, desc);
    textureMeta.set(texture, {
      id: nextTextureId++,
      desc: { format: desc.format, size: desc.size, mipLevelCount: desc.mipLevelCount, usage: desc.usage },
    });
    return texture;
  };

  const origCreateBuffer = GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer = function (desc) {
    const buffer = origCreateBuffer.call(this, desc);
    const meta = {
      id: nextBufferId++,
      label: (desc && desc.label) || "",
      size: desc.size,
      usage: desc.usage,
      writes: [],
      writeCount: 0,
      mappedWrites: [],
    };
    bufferMeta.set(buffer, meta);
    dump.buffers.push(meta);
    if (desc.mappedAtCreation) {
      const ranges = [];
      const origGetMappedRange = buffer.getMappedRange.bind(buffer);
      buffer.getMappedRange = function (offset, size) {
        const range = origGetMappedRange(offset ?? 0, size);
        ranges.push({ offset: offset ?? 0, range });
        return range;
      };
      const origUnmap = buffer.unmap.bind(buffer);
      buffer.unmap = function () {
        for (const entry of ranges) {
          if (entry.range.byteLength <= 32 * 1024 * 1024) {
            meta.mappedWrites.push({ offset: entry.offset, data: b64(new Uint8Array(entry.range.slice(0))) });
          } else {
            meta.mappedWrites.push({ offset: entry.offset, skipped: entry.range.byteLength });
          }
        }
        ranges.length = 0;
        origUnmap();
      };
    }
    return buffer;
  };

  const origWriteBuffer = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (buffer, bufferOffset, data, dataOffset, size) {
    const meta = bufferMeta.get(buffer);
    if (meta) {
      let view;
      if (ArrayBuffer.isView(data)) {
        const element = data.BYTES_PER_ELEMENT ?? 1;
        const offset = data.byteOffset + (dataOffset ?? 0) * element;
        const length = size !== undefined ? size * element : data.byteLength - (dataOffset ?? 0) * element;
        view = new Uint8Array(data.buffer, offset, length);
      } else {
        const offset = dataOffset ?? 0;
        const length = size ?? data.byteLength - offset;
        view = new Uint8Array(data, offset, length);
      }
      meta.writeCount++;
      if (view.byteLength <= 32 * 1024 * 1024) {
        meta.writes.push({ offset: bufferOffset, data: b64(view) });
      } else {
        meta.writes.push({ offset: bufferOffset, skipped: view.byteLength });
      }
      if (meta.writes.length > 8) meta.writes.shift();
    }
    return origWriteBuffer.call(this, buffer, bufferOffset, data, dataOffset, size);
  };

  const origWriteTexture = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function (dest, data, layout, size) {
    const meta = textureMeta.get(dest.texture);
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data);
    // Float texel uploads carry animation state (Babylon Lite's
    // per-skin bone-matrix textures are Nx1 rgba32float rows), so keep
    // their raw bytes at a higher cap than color texel uploads.
    const floatTexels =
      typeof meta?.desc?.format === "string" &&
      meta.desc.format.indexOf("32float") >= 0;
    const byteCap = floatTexels ? 32768 : 256;
    window.__texUploads.push({
      tex: meta ? meta.id : -1,
      kind: "writeTexture",
      desc: meta ? meta.desc : null,
      mipLevel: (dest.mipLevel ?? 0),
      bytes: bytes.length <= byteCap ? Array.from(bytes) : null,
      byteLength: bytes.length,
    });
    return origWriteTexture.call(this, dest, data, layout, size);
  };

  const origCopyExternal = GPUQueue.prototype.copyExternalImageToTexture;
  GPUQueue.prototype.copyExternalImageToTexture = function (source, dest, size) {
    const meta = textureMeta.get(dest.texture);
    let sample = null;
    try {
      const image = source.source;
      const canvas = new OffscreenCanvas(4, 4);
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, 4, 4);
      sample = { w: image.width, h: image.height, pixels4x4: Array.from(context.getImageData(0, 0, 4, 4).data) };
    } catch (error) {
      sample = { error: String(error) };
    }
    window.__texUploads.push({
      tex: meta ? meta.id : -1,
      kind: "copyExternalImage",
      desc: meta ? meta.desc : null,
      sample,
    });
    return origCopyExternal.call(this, source, dest, size);
  };

  for (const proto of [GPURenderPassEncoder.prototype, GPURenderBundleEncoder.prototype]) {
    const tag = proto === GPURenderPassEncoder.prototype ? "pass" : "bundle";
    const origDrawIndexed = proto.drawIndexed;
    proto.drawIndexed = function (indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
      const key = tag + ".drawIndexed(" + indexCount + "," + (instanceCount ?? 1) + "," + (firstIndex ?? 0) + "," + (baseVertex ?? 0) + ")";
      window.__draws[key] = (window.__draws[key] || 0) + 1;
      if (skipDrawIndexCount > 0 && indexCount === skipDrawIndexCount) return;
      return origDrawIndexed.call(this, indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    };
    const origDraw = proto.draw;
    proto.draw = function (vertexCount, instanceCount, firstVertex, firstInstance) {
      const key = tag + ".draw(" + vertexCount + "," + (instanceCount ?? 1) + "," + (firstVertex ?? 0) + ")";
      window.__draws[key] = (window.__draws[key] || 0) + 1;
      return origDraw.call(this, vertexCount, instanceCount, firstVertex, firstInstance);
    };
  }
})();`;
}

export async function runInstrumentedCapture(
    idOrSource: string,
    options: InstrumentedCaptureOptions = {},
): Promise<void> {
    const scene = resolveScene(idOrSource);
    const seekSeconds =
        options.seekSeconds ?? scene.parity?.referenceTimeSeconds;
    const animationGroups = scene.parity?.referenceAnimationGroups;
    const skipDrawIndexCount = options.skipDrawIndexCount ?? 0;
    const outputDirectory = resolve(
        options.outputDirectory ?? defaultCaptureDirectory(scene.id),
    );
    const moduleSource = suiteBrowserModule(
        scene.source,
        undefined,
        seekSeconds,
        animationGroups,
    );
    const server = createSuiteSceneServer(
        moduleSource,
        { sourcePath: scene.source },
    );
    await withBrowserPage(
        server,
        {
            serverName: "capture server",
            browserArgs: screenshotCaptureBrowserArgs,
            viewport: { width: 1280, height: 720 },
            pageErrorPrefix: "Capture page error",
        },
        async (page, origin) => {
            // The hooks must be installed before any scene script runs,
            // which is why the init script precedes the navigation.
            await page.addInitScript(initScript(skipDrawIndexCount));
            await waitForSceneReady(
                page,
                origin,
                seekSeconds !== undefined,
                scene.parity?.referenceSearch,
            );
            mkdirSync(captureShadersDirectory(outputDirectory), {
                recursive: true,
            });
            await page.locator("#renderCanvas").screenshot({
                path: join(outputDirectory, "screenshot.png"),
            });

            const dump = (await page.evaluate("window.__wgpuDump")) as {
                shaders: { label: string; code: string }[];
                buffers: {
                    id: number;
                    label: string;
                    size: number;
                    usage: number;
                    writeCount: number;
                }[];
            };
            const draws = await page.evaluate("window.__draws");
            const textureUploads = await page.evaluate("window.__texUploads");
            dump.shaders.forEach((shader, index) => {
                const name = (shader.label || `module-${index}`)
                    .replace(/[^a-z0-9_.-]/gi, "_");
                writeFileSync(
                    join(
                        captureShadersDirectory(outputDirectory),
                        `${String(index).padStart(2, "0")}-${name}.wgsl`,
                    ),
                    shader.code,
                );
            });
            writeFileSync(
                captureBuffersPath(outputDirectory),
                JSON.stringify(dump.buffers, null, 1),
            );
            writeFileSync(
                join(outputDirectory, "tex-uploads.json"),
                JSON.stringify(textureUploads, null, 1),
            );
            writeFileSync(
                captureDrawsPath(outputDirectory),
                JSON.stringify(draws, null, 1),
            );
            const summary = dump.buffers
                .map(
                    (buffer) =>
                        `#${buffer.id} label='${buffer.label}' size=${buffer.size} ` +
                        `usage=0x${buffer.usage.toString(16)} writes=${buffer.writeCount}`,
                )
                .join("\n");
            writeFileSync(
                join(outputDirectory, "buffers-summary.txt"),
                summary,
            );
            // The capture's provenance, so a reuse path can tell whether this
            // directory describes the pose it is about to be diffed at. `null`
            // means captured with no seek; a missing file is a pre-provenance
            // capture and reads as unknown.
            writeFileSync(
                captureMetaPath(outputDirectory),
                `${JSON.stringify({ seekSeconds: seekSeconds ?? null })}\n`,
            );
            console.log(`Instrumented capture written to ${outputDirectory}`);
            console.log(`Draw calls: ${JSON.stringify(draws)}`);
            console.log(summary);

            // Non-perturbation check: with no draw filter, the hooked
            // render must stay byte-identical to the committed golden.
            const referencePath = scene.parity?.reference.path;
            if (
                skipDrawIndexCount === 0 &&
                referencePath &&
                existsSync(referencePath)
            ) {
                const captured = readFileSync(
                    join(outputDirectory, "screenshot.png"),
                );
                const golden = readFileSync(resolve(referencePath));
                console.log(
                    captured.equals(golden)
                        ? "Screenshot is byte-identical to the committed golden."
                        : "Screenshot DIFFERS from the committed golden — the pose, environment, or pinned package changed.",
                );
            }
        },
    );
}
