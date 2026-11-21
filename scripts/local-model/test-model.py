# A stand-in for the local embedding model (Phase 13), for tests only: the same inputs and output as
# the real package's graph (input_ids and attention_mask, int64; a 1,024-dimension float vector,
# L2-normalised), a tokenizer of the 256 byte tokens and no merges, and a description marked `test`
# (the server takes it outside Production only). Each token has a fixed random direction; a text's
# vector is their mean, so texts sharing bytes score near. It runs through the same ONNX Runtime and
# tokenizer code as the real model, in a few milliseconds, in CI.
#
#   python -I test-model.py <folder>        (writes tests/fixtures/local-model when given it)
import hashlib
import json
import os
import sys

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

out = sys.argv[1]
os.makedirs(out, exist_ok=True)
rng = np.random.default_rng(13)
TABLE = rng.standard_normal((256, 32)).astype(np.float32)
PROJECT = (rng.standard_normal((32, 1024)) / np.sqrt(32)).astype(np.float32)

nodes = [
    helper.make_node("Gather", ["table", "input_ids"], ["tokens"]),  # [B, T, 32]
    helper.make_node("Cast", ["attention_mask"], ["mask"], to=TensorProto.FLOAT),  # [B, T]
    helper.make_node("Unsqueeze", ["mask", "axis2"], ["mask3"]),  # [B, T, 1]
    helper.make_node("Mul", ["tokens", "mask3"], ["kept"]),
    helper.make_node("ReduceSum", ["kept", "axis1"], ["summed"], keepdims=0),  # [B, 32]
    helper.make_node("ReduceSum", ["mask", "axis1"], ["count"], keepdims=1),  # [B, 1]
    helper.make_node("Max", ["count", "one"], ["safe"]),
    helper.make_node("Div", ["summed", "safe"], ["pooled"]),
    helper.make_node("MatMul", ["pooled", "project"], ["wide"]),  # [B, 1024]
    helper.make_node("ReduceL2", ["wide", "axis1"], ["norm"], keepdims=1),
    helper.make_node("Max", ["norm", "tiny"], ["safeNorm"]),
    helper.make_node("Div", ["wide", "safeNorm"], ["embedding"]),
]
graph = helper.make_graph(
    nodes,
    "cgw-test-embedder",
    [
        helper.make_tensor_value_info("input_ids", TensorProto.INT64, ["batch", "tokens"]),
        helper.make_tensor_value_info("attention_mask", TensorProto.INT64, ["batch", "tokens"]),
    ],
    [helper.make_tensor_value_info("embedding", TensorProto.FLOAT, ["batch", 1024])],
    initializer=[
        numpy_helper.from_array(TABLE, "table"),
        numpy_helper.from_array(PROJECT, "project"),
        numpy_helper.from_array(np.array([1], dtype=np.int64), "axis1"),
        numpy_helper.from_array(np.array([2], dtype=np.int64), "axis2"),
        numpy_helper.from_array(np.array(1.0, dtype=np.float32), "one"),
        numpy_helper.from_array(np.array(1e-12, dtype=np.float32), "tiny"),
    ],
)
model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 18)], producer_name="cgw-test-model")
model.ir_version = 9
onnx.checker.check_model(model)
onnx.save(model, os.path.join(out, "model.onnx"))

# GPT-2's printable form of each byte, as the real vocabulary writes them.
printable = list(range(33, 127)) + list(range(161, 173)) + list(range(174, 256))
chars, n = {}, 0
for b in range(256):
    if b in printable:
        chars[b] = chr(b)
    else:
        chars[b] = chr(256 + n)
        n += 1
with open(os.path.join(out, "vocab.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump({chars[b]: b for b in range(256)}, f, ensure_ascii=False)
with open(os.path.join(out, "merges.txt"), "w", encoding="utf-8", newline="\n") as f:
    f.write("#version: 0.2\n")


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


manifest = {
    "model": "voyage-4-nano",
    "source": "a stand-in for tests (scripts/local-model/test-model.py)",
    "dimensions": 1024,
    "maxTokens": 2048,
    "prompts": {"document": "Represent the document for retrieval: ", "query": "Represent the query for retrieving supporting documents: "},
    "files": {name: sha256(os.path.join(out, name)) for name in ("model.onnx", "vocab.json", "merges.txt")},
    "test": True,
}
with open(os.path.join(out, "cgw-model.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(manifest, f, indent=2)
    f.write("\n")
print(json.dumps(manifest["files"], indent=2))
