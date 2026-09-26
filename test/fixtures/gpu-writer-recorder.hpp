// Queue facade for fixtures that isolate PAL algorithms with native API recorders.
template <class Queue> struct DawnGpuDevice {
    Queue queue;
    template <class... Args> void write_buffer(Args... args) {
        wgpuQueueWriteBuffer(queue, args...);
    }
    template <class... Args> void write_texture(Args... args) {
        wgpuQueueWriteTexture(queue, args...);
    }
};
struct SdlGpuWriteDevice {
    template <class... Args> void write_vertex_uniform(Args... args) {
        SDL_PushGPUVertexUniformData(args...);
    }
};
