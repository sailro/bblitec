#include <bblite/js_structured_clone.hpp>

#include <cmath>
#include <iostream>
#include <thread>

namespace {
using namespace bbl;
void require(bool condition, const char* message) {
    if (!condition)
        throw std::runtime_error(message);
}
template <typename F> void require_clone_error(F action, const char* message) {
    try {
        action();
    } catch (const pal::DataCloneError&) {
        return;
    }
    throw std::runtime_error(message);
}

struct Views {
    js::F32Array partial;
    js::F32Array floats;
    js::U8Array bytes;
    js::DataView view;
    js::ArrayBuffer buffer;
    template <typename Visit> friend void clone_fields(const Views& item, Visit visit) {
        visit("partial", item.partial);
        visit("floats", item.floats);
        visit("bytes", item.bytes);
        visit("view", item.view);
        visit("buffer", item.buffer);
    }
    template <typename Visit> friend void clone_fields(Views& item, Visit visit) {
        visit("partial", item.partial);
        visit("floats", item.floats);
        visit("bytes", item.bytes);
        visit("view", item.view);
        visit("buffer", item.buffer);
    }
};

/** A partial view received first leaves its buffer owned by the buffer node. */
void views_share_one_buffer() {
    js::F32Array floats{1.0F, 2.0F, 3.0F, 4.0F};
    const js::ArrayBuffer buffer(floats);
    Views source{js::F32Array(buffer, 8.0, 2.0), floats, js::U8Array(buffer, 4, 8),
                 js::DataView(buffer, 12, 4), buffer};
    auto message = js::serialize_message(source);
    floats.store(0, 99.0F);
    std::jthread worker([message = std::move(message)]() mutable {
        pal::CloneReader reader(std::move(message));
        auto copy = js::clone_read<Views>(reader, reader.root());
        require(copy.buffer.byte_length() == 16, "Views did not copy their whole buffer");
        require(copy.partial.buffer() == copy.buffer && copy.floats.buffer() == copy.buffer &&
                    copy.bytes.buffer() == copy.buffer && copy.view.buffer() == copy.buffer,
                "Views of one buffer received different buffers");
        require(copy.floats.load(0) == 1.0F, "Buffer bytes were not snapshotted when posted");
        require(copy.partial.byte_offset() == 8 && copy.partial.size() == 2 &&
                    copy.partial.load(1) == 4.0F,
                "Partial Float32Array view lost its window");
        require(copy.bytes.byte_offset() == 4 && copy.bytes.size() == 8, "Uint8Array window lost");
        require(copy.view.byte_offset() == 12 && copy.view.get_float32(0, true) == 4.0F,
                "DataView window lost");
        copy.bytes.store(3, 0);
        require(copy.floats.load(1) == 0.0F, "Received views do not alias one buffer");
    });
    worker.join();
    require(floats.load(1) == 2.0F, "Receiver mutated sender bytes");
}

struct ArrayAndBuffer {
    js::F64Array doubles;
    js::ArrayBuffer buffer;
    template <typename Visit> friend void clone_fields(const ArrayAndBuffer& item, Visit visit) {
        visit("doubles", item.doubles);
        visit("buffer", item.buffer);
    }
    template <typename Visit> friend void clone_fields(ArrayAndBuffer& item, Visit visit) {
        visit("doubles", item.doubles);
        visit("buffer", item.buffer);
    }
};

/** The first whole-buffer typed array receives owned elements the buffer then aliases. */
void whole_buffer_array_owns_elements() {
    const js::F64Array doubles{0.5, -0.0};
    pal::CloneReader reader(
        js::serialize_message(ArrayAndBuffer{doubles, js::ArrayBuffer(doubles)}));
    const auto copy = js::clone_read<ArrayAndBuffer>(reader, reader.root());
    require(copy.doubles.data()[0] == 0.5 && std::signbit(copy.doubles.data()[1]),
            "Owned Float64Array elements were not received");
    require(!(copy.doubles == doubles), "Received typed array kept the sender identity");
    require(copy.doubles.buffer() == copy.buffer, "An owned typed array and its buffer split");
}

/** Borrowed native bytes join aliases by address. */
void borrowed_buffers() {
    std::vector<float> native{1.0F, 2.0F};
    const js::Array<js::ArrayBuffer> buffers{js::ArrayBuffer(native), js::ArrayBuffer(native)};
    pal::CloneReader reader(js::serialize_message(buffers));
    const auto copy = js::clone_read<js::Array<js::ArrayBuffer>>(reader, reader.root());
    require(copy[0] == copy[1] && copy[0].byte_length() == 8,
            "Borrowed buffers of one vector did not alias");
    std::vector<float> empty;
    pal::CloneReader second(js::serialize_message(js::ArrayBuffer(empty)));
    require(js::clone_read<js::ArrayBuffer>(second, second.root()).byte_length() == 0,
            "Empty borrowed buffer was not cloned");
}

void views_refuse_malformed_messages() {
    const js::F32Array floats{1.0F, 2.0F};
    require_clone_error(
        [&] {
            pal::CloneReader reader(js::serialize_message(floats));
            static_cast<void>(js::clone_read<js::I32Array>(reader, reader.root()));
        },
        "A Float32Array was received as an Int32Array");
    require_clone_error(
        [] {
            pal::CloneWriter writer;
            const auto buffer = writer.add(pal::CloneBuffer{std::vector<std::uint8_t>(4)});
            const auto root = writer.add(pal::CloneView{pal::CloneViewKind::uint8, buffer, 2, 4});
            pal::CloneReader reader(std::move(writer).finish(root));
            static_cast<void>(js::clone_read<js::U8Array>(reader, reader.root()));
        },
        "A view beyond its buffer was received");
    require_clone_error(
        [] {
            pal::CloneWriter writer;
            const auto buffer = writer.add(pal::CloneBuffer{std::vector<std::uint8_t>(8)});
            const auto root = writer.add(pal::CloneView{pal::CloneViewKind::float32, buffer, 2, 4});
            pal::CloneReader reader(std::move(writer).finish(root));
            static_cast<void>(js::clone_read<js::F32Array>(reader, reader.root()));
        },
        "An unaligned Float32Array view was received");
    require_clone_error(
        [] {
            pal::CloneReader reader(js::serialize_message(js::Array<double>{1.0, 2.0}));
            static_cast<void>(js::clone_read<js::Tuple<3>>(reader, reader.root()));
        },
        "A two-element array was received as a three-element tuple");
}

struct Node {
    std::string name;
    js::Map<std::string, js::Ref<Node>> links;
    js::Set<js::Ref<Node>> members;
    js::Map<js::Ref<Node>, js::Date> seen;
    template <typename Visit> friend void clone_fields(const Node& item, Visit visit) {
        visit("name", item.name);
        visit("links", item.links);
        visit("members", item.members);
        visit("seen", item.seen);
    }
    template <typename Visit> friend void clone_fields(Node& item, Visit visit) {
        visit("name", item.name);
        visit("links", item.links);
        visit("members", item.members);
        visit("seen", item.seen);
    }
    void gc_trace(const js::TraceVisitor& visit) const {
        visit(links);
        visit(members);
        visit(seen);
    }
};

/** Map and Set entries keep object keys, cycles and insertion order. */
void collections_keep_graphs() {
    const js::CollectOnExit collect;
    auto root = js::make_ref<Node>();
    auto leaf = js::make_ref<Node>();
    root->name = "root";
    leaf->name = "leaf";
    const auto when = js::make_date(1700000000000.0);
    root->links.set("self", root);
    root->links.set("leaf", leaf);
    root->members.add(leaf);
    root->members.add(root);
    root->seen.set(leaf, when);
    root->seen.set(root, when);
    auto message = js::serialize_message(root);
    root->links.set("late", leaf);
    *when = 0.0;
    std::jthread worker([message = std::move(message)]() mutable {
        const js::CollectOnExit collect_worker;
        pal::CloneReader reader(std::move(message));
        const auto copy = js::clone_read<js::Ref<Node>>(reader, reader.root());
        require(copy->links.size() == 2 && copy->links.get("self") == copy,
                "Map value cycle was lost");
        const auto leaf_copy = copy->links.at("leaf");
        std::vector<std::string> order;
        for (const auto& member : copy->members)
            order.push_back(member->name);
        require(order == std::vector<std::string>{"leaf", "root"}, "Set order was lost");
        require(copy->seen.has(leaf_copy) && copy->seen.has(copy), "Map object keys were lost");
        require(copy->seen.at(leaf_copy) == copy->seen.at(copy) &&
                    *copy->seen.at(copy) == 1700000000000.0,
                "Date identity or snapshot was lost");
    });
    worker.join();
}
} // namespace

int main() {
    try {
        views_share_one_buffer();
        whole_buffer_array_owns_elements();
        borrowed_buffers();
        views_refuse_malformed_messages();
        collections_keep_graphs();
        std::cout << "Structured clone: Date, Map, Set, tuples and buffer views passed.\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
