// Page init script: record the WebGPU operations a scene performs as
// receipts — every resource by id with its label and size, every
// writeBuffer with its bytes, every render pipeline's descriptor, every
// bind group's entries, and every draw with the pipeline, groups and
// vertex buffers bound at the time — into window.__gpuReceipts. A text
// scene's native textGpu receipts are joined against these by
// checks/plugins/scene275-receipts.mjs.
(() => {
  const receipts = { resources: [], writes: [], pipelines: [], groups: [], draws: [], frame: 0 };
  window.__gpuReceipts = receipts;
  let nextId = 1;
  const ids = new WeakMap();
  const idOf = (object) => {
    let id = ids.get(object);
    if (id === undefined) {
      id = nextId++;
      ids.set(object, id);
    }
    return id;
  };
  const plain = (value) => JSON.parse(JSON.stringify(value ?? null));
  const bytesOf = (data, dataOffset, size) => {
    if (ArrayBuffer.isView(data)) {
      const element = data.BYTES_PER_ELEMENT ?? 1;
      const offset = data.byteOffset + (dataOffset ?? 0) * element;
      const length = size !== undefined ? size * element : data.byteLength - (dataOffset ?? 0) * element;
      return Array.from(new Uint8Array(data.buffer, offset, length));
    }
    const offset = dataOffset ?? 0;
    return Array.from(new Uint8Array(data, offset, size ?? data.byteLength - offset));
  };

  const originalRequestAnimationFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = function (callback) {
    return originalRequestAnimationFrame.call(window, (time) => {
      receipts.frame += 1;
      return callback(time);
    });
  };

  const device = GPUDevice.prototype;
  const originalCreateBuffer = device.createBuffer;
  device.createBuffer = function (desc) {
    const buffer = originalCreateBuffer.call(this, desc);
    const id = idOf(buffer);
    receipts.resources.push({ id, kind: "buffer", label: desc.label ?? "", size: desc.size, usage: desc.usage });
    if (desc.mappedAtCreation) {
      // A buffer filled through its creation mapping is uploaded when it
      // is unmapped; the mapped ranges are recorded as writes then.
      const ranges = [];
      const originalGetMappedRange = buffer.getMappedRange.bind(buffer);
      buffer.getMappedRange = function (offset, size) {
        const range = originalGetMappedRange(offset ?? 0, size);
        ranges.push({ offset: offset ?? 0, range });
        return range;
      };
      const originalUnmap = buffer.unmap.bind(buffer);
      buffer.unmap = function () {
        for (const entry of ranges) {
          const bytes = Array.from(new Uint8Array(entry.range.slice(0)));
          receipts.writes.push({ id, offset: entry.offset, frame: receipts.frame, bytes: bytes.length <= 1048576 ? bytes : null, byteLength: bytes.length, mapped: true });
        }
        ranges.length = 0;
        originalUnmap();
      };
    }
    return buffer;
  };
  const originalCreateTexture = device.createTexture;
  device.createTexture = function (desc) {
    const texture = originalCreateTexture.call(this, desc);
    const size = Array.isArray(desc.size)
      ? { width: desc.size[0], height: desc.size[1] ?? 1 }
      : { width: desc.size.width, height: desc.size.height ?? 1 };
    receipts.resources.push({ id: idOf(texture), kind: "texture", label: desc.label ?? "", size, format: desc.format, usage: desc.usage });
    return texture;
  };
  const originalCreateSampler = device.createSampler;
  device.createSampler = function (desc) {
    const sampler = originalCreateSampler.call(this, desc);
    receipts.resources.push({ id: idOf(sampler), kind: "sampler", label: (desc && desc.label) ?? "" });
    return sampler;
  };
  const originalCreateView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (desc) {
    const view = originalCreateView.call(this, desc);
    receipts.resources.push({ id: idOf(view), kind: "view", label: (desc && desc.label) ?? "", texture: idOf(this) });
    return view;
  };
  const originalCreateBindGroup = device.createBindGroup;
  device.createBindGroup = function (desc) {
    const group = originalCreateBindGroup.call(this, desc);
    receipts.groups.push({
      id: idOf(group),
      label: desc.label ?? "",
      entries: Array.from(desc.entries, (entry) => ({
        binding: entry.binding,
        resource: idOf(entry.resource.buffer ?? entry.resource),
        ...(entry.resource.buffer ? { offset: entry.resource.offset ?? 0, size: entry.resource.size ?? null } : {}),
      })),
    });
    return group;
  };
  const originalCreateRenderPipeline = device.createRenderPipeline;
  device.createRenderPipeline = function (desc) {
    const pipeline = originalCreateRenderPipeline.call(this, desc);
    receipts.pipelines.push({
      id: idOf(pipeline),
      label: desc.label ?? "",
      vertex: { constants: plain(desc.vertex.constants ?? {}), buffers: plain(desc.vertex.buffers ?? []) },
      fragment: desc.fragment ? { constants: plain(desc.fragment.constants ?? {}), targets: plain(desc.fragment.targets ?? []) } : null,
      depthStencil: plain(desc.depthStencil ?? null),
      primitive: plain(desc.primitive ?? {}),
      multisample: plain(desc.multisample ?? {}),
    });
    return pipeline;
  };
  const originalWriteBuffer = GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer = function (buffer, bufferOffset, data, dataOffset, size) {
    const bytes = bytesOf(data, dataOffset, size);
    receipts.writes.push({ id: idOf(buffer), offset: bufferOffset, frame: receipts.frame, bytes: bytes.length <= 1048576 ? bytes : null, byteLength: bytes.length });
    return originalWriteBuffer.call(this, buffer, bufferOffset, data, dataOffset, size);
  };
  const originalWriteTexture = GPUQueue.prototype.writeTexture;
  GPUQueue.prototype.writeTexture = function (destination, data, layout, size) {
    const bytes = bytesOf(data, 0, undefined);
    receipts.writes.push({
      id: idOf(destination.texture), frame: receipts.frame,
      layout: { offset: (layout && layout.offset) ?? 0, bytesPerRow: layout && layout.bytesPerRow, rowsPerImage: layout && layout.rowsPerImage },
      mipLevel: destination.mipLevel ?? 0, origin: plain(destination.origin ?? [0, 0, 0]), size: plain(size),
      bytes: bytes.length <= 1048576 ? bytes : null, byteLength: bytes.length,
    });
    return originalWriteTexture.call(this, destination, data, layout, size);
  };

  const bindings = new WeakMap();
  const state = (encoder) => {
    let current = bindings.get(encoder);
    if (current === undefined) {
      current = { pipeline: null, groups: [], vertices: [], index: null };
      bindings.set(encoder, current);
    }
    return current;
  };
  for (const proto of [GPURenderPassEncoder.prototype, GPURenderBundleEncoder.prototype]) {
    const originalSetPipeline = proto.setPipeline;
    proto.setPipeline = function (pipeline) {
      state(this).pipeline = idOf(pipeline);
      return originalSetPipeline.call(this, pipeline);
    };
    const originalSetBindGroup = proto.setBindGroup;
    proto.setBindGroup = function (index, group, ...rest) {
      state(this).groups[index] = group ? idOf(group) : null;
      return originalSetBindGroup.call(this, index, group, ...rest);
    };
    const originalSetVertexBuffer = proto.setVertexBuffer;
    proto.setVertexBuffer = function (slot, buffer, offset, size) {
      state(this).vertices[slot] = { buffer: idOf(buffer), offset: offset ?? 0, size: size ?? null };
      return originalSetVertexBuffer.call(this, slot, buffer, offset, size);
    };
    const originalSetIndexBuffer = proto.setIndexBuffer;
    proto.setIndexBuffer = function (buffer, format, offset, size) {
      state(this).index = { buffer: idOf(buffer), format, offset: offset ?? 0, size: size ?? null };
      return originalSetIndexBuffer.call(this, buffer, format, offset, size);
    };
    const record = (encoder, method, args) => {
      const current = state(encoder);
      receipts.draws.push({
        method,
        frame: receipts.frame,
        pipeline: current.pipeline,
        groups: [...current.groups],
        vertices: [...current.vertices],
        index: current.index,
        args,
      });
    };
    const originalDraw = proto.draw;
    proto.draw = function (vertexCount, instanceCount, firstVertex, firstInstance) {
      record(this, "draw", [vertexCount, instanceCount ?? 1, firstVertex ?? 0, firstInstance ?? 0]);
      return originalDraw.call(this, vertexCount, instanceCount, firstVertex, firstInstance);
    };
    const originalDrawIndexed = proto.drawIndexed;
    proto.drawIndexed = function (indexCount, instanceCount, firstIndex, baseVertex, firstInstance) {
      record(this, "drawIndexed", [indexCount, instanceCount ?? 1, firstIndex ?? 0, baseVertex ?? 0, firstInstance ?? 0]);
      return originalDrawIndexed.call(this, indexCount, instanceCount, firstIndex, baseVertex, firstInstance);
    };
  }
})();
