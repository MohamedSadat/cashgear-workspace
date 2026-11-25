# The local completion model's stand-in for tests (Phase 18, M18.1): a Qwen3 of one layer over a
# byte-level vocabulary, built to ONNX Runtime GenAI's int4 format by GenAI's own builder, so the
# server's tests and the e2e stack run the same runtime, tokenizer and guidance code as the real
# package. Its weights fix its answer: every layer adds nothing, so the logits are the output head's
# rows alone, which rank a double quote first, then a closing brace, a closing bracket, the end of
# the answer, a colon and a comma, an opening bracket and brace, and whitespace last. Without a schema it writes double quotes until its limit; held to a JSON schema it
# closes everything at once (`{"items":[]}`), so a JSON action's answer is a valid empty one.
#
#   python -I scripts/completion-model/make-test-model.py <work folder> <package folder> <model id> [family]
#
# Writes the package (genai_config.json, model.onnx and its data, the tokenizer's files and
# cgw-model.json marked `test: true`, with each file's SHA-256). Needs PyTorch, Transformers and
# onnxruntime-genai's builder (scripts/completion-model.mjs's environment).
import hashlib
import json
import os
import shutil
import sys

import torch
from safetensors.torch import save_file
from onnxruntime_genai.models import builder

work, out, model_id = sys.argv[1], sys.argv[2], sys.argv[3]
family = sys.argv[4] if len(sys.argv) > 4 else 'qwen35'
hf = os.path.join(work, 'hf')
shutil.rmtree(work, ignore_errors=True)
os.makedirs(hf)


def bytes_to_unicode():
    # GPT-2's byte-level alphabet: every byte as a printable character.
    bs = list(range(ord('!'), ord('~') + 1)) + list(range(ord('\xa1'), ord('\xac') + 1)) + list(range(ord('\xae'), ord('\xff') + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {b: chr(c) for b, c in zip(bs, cs)}


alphabet = bytes_to_unicode()
vocab = {alphabet[b]: b for b in range(256)}
specials = ['<|endoftext|>', '<|im_start|>', '<|im_end|>']
END, START, IM_END = 256, 257, 258
VOCAB = 264  # 259 used, rounded up
added = [{'id': 256 + i, 'content': t, 'single_word': False, 'lstrip': False, 'rstrip': False, 'normalized': False, 'special': True}
         for i, t in enumerate(specials)]
byte_level = {'type': 'ByteLevel', 'add_prefix_space': False, 'trim_offsets': False, 'use_regex': False}
tokenizer = {
    'version': '1.0', 'truncation': None, 'padding': None, 'added_tokens': added, 'normalizer': None,
    'pre_tokenizer': byte_level, 'post_processor': None, 'decoder': byte_level,
    'model': {'type': 'BPE', 'dropout': None, 'unk_token': None, 'continuing_subword_prefix': None, 'end_of_word_suffix': None,
              'fuse_unk': False, 'byte_fallback': False, 'ignore_merges': False, 'vocab': vocab, 'merges': []},
}
template = ("{% for message in messages %}<|im_start|>{{ message['role'] }}\n{{ message['content'] }}<|im_end|>\n{% endfor %}"
            "{% if add_generation_prompt %}<|im_start|>assistant\n{% endif %}")
with open(os.path.join(hf, 'tokenizer.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump(tokenizer, f, ensure_ascii=False)
with open(os.path.join(hf, 'vocab.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump(vocab, f, ensure_ascii=False)
with open(os.path.join(hf, 'merges.txt'), 'w', encoding='utf-8', newline='\n') as f:
    f.write('#version: 0.2\n')
with open(os.path.join(hf, 'tokenizer_config.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump({
        'tokenizer_class': 'Qwen2Tokenizer', 'model_max_length': 4096, 'bos_token': None,
        'eos_token': '<|im_end|>', 'pad_token': '<|endoftext|>', 'unk_token': None, 'clean_up_tokenization_spaces': False,
        'added_tokens_decoder': {str(a['id']): {k: v for k, v in a.items() if k != 'id'} for a in added},
        'chat_template': template,
    }, f, ensure_ascii=False, indent=1)
HIDDEN, INTER, HEAD = 64, 128, 32
with open(os.path.join(hf, 'config.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump({
        'architectures': ['Qwen3ForCausalLM'], 'model_type': 'qwen3', 'vocab_size': VOCAB, 'hidden_size': HIDDEN,
        'intermediate_size': INTER, 'num_hidden_layers': 1, 'num_attention_heads': 2, 'num_key_value_heads': 1,
        'head_dim': HEAD, 'hidden_act': 'silu', 'max_position_embeddings': 4096, 'rms_norm_eps': 1e-6,
        'rope_theta': 1000000.0, 'tie_word_embeddings': False, 'attention_bias': False, 'torch_dtype': 'float32',
        'bos_token_id': END, 'eos_token_id': IM_END, 'pad_token_id': END,
    }, f, indent=1)
with open(os.path.join(hf, 'generation_config.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump({'eos_token_id': [IM_END, END], 'pad_token_id': END, 'do_sample': False}, f, indent=1)

# The weights: each layer adds nothing (its projections are zero), the hidden state is the
# embedding's ones normalised, so each token's logit is its output row's sum: its rank below.
# Whitespace below everything, so a schema's grammar, which allows it between tokens, never takes it.
rank = {ord('"'): 10.0, ord('}'): 9.0, ord(']'): 8.0, IM_END: 7.0, END: 6.0, ord(':'): 5.0, ord(','): 5.0, ord('['): 4.0, ord('{'): 3.0,
        32: -5.0, 9: -5.0, 10: -5.0, 13: -5.0}  # space, tab, line feed, carriage return
head = torch.zeros(VOCAB, HIDDEN)
for token, logit in rank.items():
    head[token] = logit / HIDDEN
z = torch.zeros
weights = {
    'model.embed_tokens.weight': torch.ones(VOCAB, HIDDEN),
    'model.norm.weight': torch.ones(HIDDEN),
    'lm_head.weight': head,
    'model.layers.0.input_layernorm.weight': torch.ones(HIDDEN),
    'model.layers.0.post_attention_layernorm.weight': torch.ones(HIDDEN),
    'model.layers.0.self_attn.q_proj.weight': z(2 * HEAD, HIDDEN),
    'model.layers.0.self_attn.k_proj.weight': z(HEAD, HIDDEN),
    'model.layers.0.self_attn.v_proj.weight': z(HEAD, HIDDEN),
    'model.layers.0.self_attn.o_proj.weight': z(HIDDEN, 2 * HEAD),
    'model.layers.0.self_attn.q_norm.weight': torch.ones(HEAD),
    'model.layers.0.self_attn.k_norm.weight': torch.ones(HEAD),
    'model.layers.0.mlp.gate_proj.weight': z(INTER, HIDDEN),
    'model.layers.0.mlp.up_proj.weight': z(INTER, HIDDEN),
    'model.layers.0.mlp.down_proj.weight': z(HIDDEN, INTER),
}
save_file(weights, os.path.join(hf, 'model.safetensors'), metadata={'format': 'pt'})

built = os.path.join(work, 'built')
cache = os.path.join(work, 'cache')
options = builder.parse_extra_options(None, hf, built, 'int4', 'cpu', cache, ['int4_accuracy_level=4', 'hf_token=false'])
builder.create_model(None, hf, built, 'int4', 'cpu', cache, **options)

shutil.rmtree(out, ignore_errors=True)
os.makedirs(out)
files = {}
for name in sorted(os.listdir(built)):
    path = os.path.join(built, name)
    if not os.path.isfile(path):
        continue
    shutil.copyfile(path, os.path.join(out, name))
    with open(path, 'rb') as f:
        files[name] = hashlib.sha256(f.read()).hexdigest()
with open(os.path.join(out, 'cgw-model.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump({'model': model_id, 'source': 'tests: a stand-in made by scripts/completion-model/make-test-model.py',
               'family': family, 'test': True, 'files': files}, f, indent=2)
    f.write('\n')
print(json.dumps(files, indent=2))
