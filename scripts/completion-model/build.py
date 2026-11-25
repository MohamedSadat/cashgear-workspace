# The completion model built to ONNX Runtime GenAI's int4 format for the processor (Phase 18, M18.1),
# by GenAI's own builder called as a library: its command line's help text does not parse under
# Python 3.14's argparse. Accuracy level 4 (int8 activations), as the spike measured it. No code of
# the model's repository runs (hf_remote off).
# Usage: python -I build.py <weights folder> <output folder> <cache folder> [KEY=VALUE ...]
import sys, time
from onnxruntime_genai.models import builder

src, out, cache = sys.argv[1], sys.argv[2], sys.argv[3]
extra = ["int4_accuracy_level=4", "hf_token=false"] + sys.argv[4:]
start = time.time()
options = builder.parse_extra_options(None, src, out, "int4", "cpu", cache, extra)
builder.create_model(None, src, out, "int4", "cpu", cache, **options)
print(f"built in {time.time() - start:.0f} s")
