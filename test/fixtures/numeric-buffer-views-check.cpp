#include <cassert>
#include <iostream>

namespace bbl {
Engine create_engine(EngineOptions) { return {}; }
static int observed_uploads = 0;
template<class Data>
void observe_upload(Engine& engine, StorageBufferHandle handle, const Data& data, double offset) {
    update_storage_buffer(engine, handle, data, offset);
    const auto& stored = engine.storage_buffers[handle.value].bytes;
    assert(stored.size() == 16 && stored[0] == 7 + observed_uploads++ * 2);
}
}

template<class Read> void contiguous_refused(Read read) {
    bool refused=false;
    try {read();} catch(const std::runtime_error& error) {
        refused=std::string(error.what()).find("contiguous native access or method")!=std::string::npos;
    }
    assert(refused);
}

int main() {
    using namespace bbl::js;
    assert(generated_scene_main()==0);
    assert(bbl::observed_uploads == 2);
    ArrayBuffer buffer(std::vector<std::uint8_t>(24));
    F32Array view(buffer,4,3);
    F32Array owned{1,2,3};
    contiguous_refused([&]{static_cast<void>(view.data());});
    contiguous_refused([&]{static_cast<void>(view[0]);});
    contiguous_refused([&]{static_cast<void>(view.storage());});
    contiguous_refused([&]{static_cast<void>(f32_array_from(view));});
    contiguous_refused([&]{typed_array_set(view,owned,0);});
    contiguous_refused([&]{typed_array_set(owned,view,0);});
    contiguous_refused([&]{static_cast<void>(typed_array_slice(view,0,2));});
    contiguous_refused([&]{array_fill(view,1.0f);});
    contiguous_refused([&]{array_copy_within(view,1,0,2);});
    assert(ArrayBuffer(view)==buffer);
    assert(ArrayBuffer(view).data()==buffer.data());
    assert(owned.data()!=nullptr && owned[1]==2);
    bool borrowed_refused = false;
    try {
        static_cast<void>(retain_typed_array_owner(std::vector<float>{1}));
    } catch (const std::runtime_error& error) {
        borrowed_refused = std::string(error.what()).find("borrowed native vector") != std::string::npos;
    }
    assert(borrowed_refused);
    std::cout<<"numeric-buffer-views-check: ok\n";
}
