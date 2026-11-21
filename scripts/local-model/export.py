# The local embedding model's package (Phase 13, M13.4): voyage-4-nano exported to ONNX as one graph
# from token ids to the pooled, cut (1,024) and normalised vector, its token table stored as fp16
# (cast back after its lookup; every other weight and all compute fp32), checked against the model run
# as its card runs it, and written beside its tokenizer, licence, notice and description.
#
#   python -I export.py <weights folder> <package folder>
#
# scripts/local-model.mjs runs it in a throwaway environment; nothing here is shipped with the app.
import hashlib
import json
import os
import shutil
import sys

import numpy as np
import onnx
import torch
import torch.nn as nn
from onnx import TensorProto, helper, numpy_helper
from transformers import AutoModel, AutoTokenizer

weights, out = sys.argv[1], sys.argv[2]
DIMS = 1024
DOCUMENT = "Represent the document for retrieval: "
QUERY = "Represent the query for retrieving supporting documents: "
os.makedirs(out, exist_ok=True)


class Embedder(nn.Module):
    """input_ids, attention_mask (int64, [batch, tokens]) -> [batch, 1024] float32, L2-normalised."""

    def __init__(self, model):
        super().__init__()
        self.inner = model.model
        self.linear = model.linear

    def forward(self, input_ids, attention_mask):
        embeds = self.inner.embed_tokens(input_ids)
        mask = attention_mask.to(embeds.dtype)
        # Bidirectional: every token sees every real token; padding is never seen.
        additive = (1.0 - mask)[:, None, None, :] * torch.finfo(embeds.dtype).min
        positions = (torch.cumsum(attention_mask, dim=1) - 1).clamp(min=0)
        hidden = self.inner(inputs_embeds=embeds, attention_mask={"full_attention": additive}, position_ids=positions, use_cache=False).last_hidden_state
        hidden = self.linear(hidden)
        pooled = (hidden * mask[:, :, None]).sum(dim=1) / mask.sum(dim=1, keepdim=True).clamp(min=1.0)
        cut = pooled[:, :DIMS]
        return cut / cut.norm(dim=1, keepdim=True).clamp(min=1e-12)


def reference(model, tokenizer, texts):
    """The model as its card runs it (its own bidirectional mask), mean-pooled, cut and normalised."""
    batch = tokenizer(texts, padding=True, return_tensors="pt")
    with torch.no_grad():
        hidden = model(**batch).last_hidden_state
    mask = batch["attention_mask"].unsqueeze(-1).float()
    pooled = (hidden * mask).sum(1) / mask.sum(1)
    return torch.nn.functional.normalize(pooled[:, :DIMS], p=2, dim=1)


tokenizer = AutoTokenizer.from_pretrained(weights)
model = AutoModel.from_pretrained(weights, trust_remote_code=True, dtype=torch.float32, attn_implementation="eager").eval()
card = AutoModel.from_pretrained(weights, trust_remote_code=True, dtype=torch.float32).eval()
embedder = Embedder(model).eval()

dummy = tokenizer(["a b c d e f g h", "a b"], padding=True, return_tensors="pt")
fp32 = os.path.join(out, "model.fp32.onnx")
torch.onnx.export(
    embedder,
    (dummy["input_ids"], dummy["attention_mask"]),
    fp32,
    input_names=["input_ids", "attention_mask"],
    output_names=["embedding"],
    dynamic_axes={"input_ids": {0: "batch", 1: "tokens"}, "attention_mask": {0: "batch", 1: "tokens"}, "embedding": {0: "batch"}},
    opset_version=18,
    dynamo=False,
)

# The token table (151,936 x 1,024) as fp16, cast after its Gather.
graph_model = onnx.load(fp32)
graph = graph_model.graph
inits = {i.name: i for i in graph.initializer}
for node in list(graph.node):
    if node.op_type != "Gather" or node.input[0] not in inits:
        continue
    table = inits[node.input[0]]
    if table.data_type != TensorProto.FLOAT or len(table.dims) != 2 or table.dims[0] < 100_000:
        continue
    half = numpy_helper.from_array(numpy_helper.to_array(table).astype(np.float16), name=table.name + "_fp16")
    graph.initializer.remove(table)
    graph.initializer.append(half)
    gathered = node.output[0]
    node.input[0] = half.name
    node.output[0] = gathered + "_fp16"
    graph.node.insert(list(graph.node).index(node) + 1, helper.make_node("Cast", [gathered + "_fp16"], [gathered], to=TensorProto.FLOAT, name=node.name + "_cast"))
onnx.save(graph_model, os.path.join(out, "model.onnx"))
os.remove(fp32)

# Checked: the package's graph against the card's own run, documents and questions, both languages.
import onnxruntime as ort

samples = [
    QUERY + "how do we pay suppliers late?",
    DOCUMENT + "Vendor invoices are settled within thirty days of receipt.",
    DOCUMENT + "تُسدَّد فواتير الموردين خلال ثلاثين يومًا من استلامها.",
    QUERY + "متى تُدفع فواتير الموردين؟",
]
session = ort.InferenceSession(os.path.join(out, "model.onnx"), providers=["CPUExecutionProvider"])
ids = tokenizer(samples, padding=True, return_tensors="pt")
got = torch.from_numpy(session.run(None, {"input_ids": ids["input_ids"].numpy(), "attention_mask": ids["attention_mask"].numpy()})[0])
want = reference(card, tokenizer, samples)
cosines = [float(x) for x in (got * want).sum(1)]
print("package vs card (cosine):", [round(c, 6) for c in cosines])
if min(cosines) < 0.9999:
    sys.exit("The exported graph does not match the model")

for name in ("vocab.json", "merges.txt", "LICENSE.txt", "NOTICE.txt"):
    shutil.copyfile(os.path.join(weights, name), os.path.join(out, name))


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


files = {name: sha256(os.path.join(out, name)) for name in ("model.onnx", "vocab.json", "merges.txt")}
manifest = {
    "model": "voyage-4-nano",
    "source": "MongoDB/voyage-4-nano@" + os.environ.get("CGW_MODEL_REVISION", "unknown"),
    "dimensions": DIMS,
    "maxTokens": 2048,
    "prompts": {"document": DOCUMENT, "query": QUERY},
    "files": files,
}
with open(os.path.join(out, "cgw-model.json"), "w", encoding="utf-8", newline="\n") as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write("\n")
print(json.dumps(files, indent=2))
