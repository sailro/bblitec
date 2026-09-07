#include <bblite/js_structured_clone.hpp>

#include <cmath>
#include <iostream>
#include <thread>

namespace {
using namespace bbl;
void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }

struct Record {
    double value = 0;
    std::string text;
    js::Ref<Record> next;
    js::Array<js::Ref<Record>> children;
    js::ArrayBuffer bytes;
    template <typename Visit> friend void clone_fields(const Record& item, Visit visit) {
        visit("value", item.value); visit("text", item.text); visit("next", item.next);
        visit("children", item.children); visit("bytes", item.bytes);
    }
    template <typename Visit> friend void clone_fields(Record& item, Visit visit) {
        visit("value", item.value); visit("text", item.text); visit("next", item.next);
        visit("children", item.children); visit("bytes", item.bytes);
    }
    void gc_trace(const js::TraceVisitor& visit) const { visit(next); visit(children); }
};

void graph_clone() {
    const js::CollectOnExit collect;
    auto source = js::make_ref<Record>();
    source->value = -0.0;
    source->text = "before posting";
    source->next = source;
    source->children.push_back(source);
    source->children.push_back(source);
    source->bytes = js::ArrayBuffer(std::vector<std::uint8_t>{4, 5, 6});
    auto message = js::serialize_message(source);
    source->text = "after posting";
    source->bytes.data()[0] = 99;
    std::jthread worker([message = std::move(message)]() mutable {
        const js::CollectOnExit collect_worker;
        pal::CloneReader reader(std::move(message));
        auto copy = js::clone_read<js::Ref<Record>>(reader, reader.root());
        require(copy->text == "before posting", "Message was not snapshotted when posted");
        require(std::signbit(copy->value), "Negative zero was lost");
        require(copy->next == copy && copy->children[0] == copy && copy->children[1] == copy, "Clone lost graph identity");
        require(copy->bytes.data()[0] == 4, "Message bytes still alias sender storage");
        copy->bytes.data()[1] = 88;
        copy->text = "receiver changed";
    });
    worker.join();
    require(source->text == "after posting" && source->bytes.data()[1] == 5, "Receiver mutated sender state");
}

struct NativeBytes final : pal::TransferredResource {
    explicit NativeBytes(std::vector<std::uint8_t> value) : bytes(std::move(value)) {}
    std::vector<std::uint8_t> bytes;
};
struct TransferBuffer final : pal::Transferable {
    std::vector<std::uint8_t> bytes{1, 2, 3};
    bool detached = false;
    std::unique_ptr<pal::TransferredResource> transfer() override {
        if (detached) throw pal::DataCloneError("Buffer is detached");
        auto result = std::make_unique<NativeBytes>(std::move(bytes));
        detached = true;
        return result;
    }
};

void transfers() {
    TransferBuffer buffer;
    pal::Transferable* duplicated[]{&buffer, &buffer};
    try { pal::CloneWriter writer(duplicated); throw std::runtime_error("Duplicate transfer accepted"); }
    catch (const pal::DataCloneError&) {}
    require(!buffer.detached, "Duplicate validation detached sender");
    pal::Transferable* transfer[]{&buffer};
    const auto* bytes = buffer.bytes.data();
    pal::CloneWriter writer(transfer);
    auto root = writer.transferable(buffer);
    auto message = std::move(writer).finish(root);
    require(buffer.detached && buffer.bytes.empty(), "Transfer did not detach the sender");
    pal::CloneReader reader(std::move(message));
    auto received = reader.take_transfer(root);
    const auto* received_bytes = dynamic_cast<NativeBytes*>(received.get());
    require(received_bytes && received_bytes->bytes.data() == bytes, "Transfer copied the buffer");
    try { auto duplicate = reader.take_transfer(root); throw std::runtime_error("Received twice"); }
    catch (const pal::DataCloneError&) {}
    try {
        pal::CloneWriter repeated(transfer);
        auto result = std::move(repeated).finish(0);
        throw std::runtime_error("Detached buffer transferred twice");
    } catch (const pal::DataCloneError&) {}
}

void serialization_before_detachment() {
    TransferBuffer buffer;
    pal::Transferable* transfer[]{&buffer};
    try {
        auto message = js::serialize_message([] {}, transfer);
        throw std::runtime_error("Function was cloned");
    } catch (const pal::DataCloneError&) {}
    require(!buffer.detached, "Serialization failure detached a buffer");
}

struct OptionalMessage {
    std::string type;
    js::Nullable<std::string> detail;
    template <typename Visit> friend void clone_fields(OptionalMessage& item, Visit visit) { visit("type", item.type); visit("detail", item.detail); }
    template <typename Visit> friend void clone_fields(const OptionalMessage& item, Visit visit) { visit("type", item.type); visit("detail", item.detail); }
};
void optional_properties() {
    pal::CloneWriter writer;
    const auto type = writer.add(std::string("started"));
    const auto root = writer.add(pal::CloneObject{{{"type", type}}});
    pal::CloneReader reader(std::move(writer).finish(root));
    auto message = js::clone_read<OptionalMessage>(reader, reader.root());
    require(message.type == "started" && !message.detail, "Absent optional message field was not undefined");
    message.detail = "available";
    pal::CloneReader second(js::serialize_message(message));
    const auto copy = js::clone_read<OptionalMessage>(second, second.root());
    require(copy.detail && *copy.detail == "available", "Present optional message field was lost");
}

void indexed_properties() {
    pal::CloneWriter writer;
    pal::CloneObject object;
    for (int index = 0; index < 40; ++index) {
        object.properties.emplace_back("field" + std::to_string(index), writer.add(static_cast<double>(index)));
    }
    const auto root = writer.add(std::move(object));
    pal::CloneReader reader(std::move(writer).finish(root));
    for (int index = 39; index >= 0; --index) {
        const auto value = reader.property(root, "field" + std::to_string(index));
        require(js::clone_read<double>(reader, value) == index, "Indexed clone property returned another field");
    }
    require(!reader.find_property(root, "absent"), "Indexed clone invented an absent field");
}
} // namespace

int main() {
    try {
        graph_clone();
        transfers();
        serialization_before_detachment();
        optional_properties();
        indexed_properties();
        std::cout << "Structured clone: snapshots, cycles, identities and transfer order passed.\n";
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
