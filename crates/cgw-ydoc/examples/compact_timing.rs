//! Times each step of compaction on an update file: `cargo run --release --example compact_timing -- <file>`.
use std::time::Instant;
use yrs::updates::decoder::Decode;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update};

fn main() {
    let path = std::env::args().nth(1).expect("an update file");
    let bytes = std::fs::read(path).expect("readable");
    for _ in 0..3 {
        let t = Instant::now();
        let update = Update::decode_v1(&bytes).unwrap();
        let decoded = t.elapsed();
        let doc = Doc::new();
        let t = Instant::now();
        {
            let mut txn = doc.transact_mut();
            txn.apply_update(update).unwrap();
        }
        let applied = t.elapsed();
        let t = Instant::now();
        let out = doc
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let encoded = t.elapsed();
        println!(
            "in {} B, out {} B: decode {:?}, apply+gc {:?}, encode {:?}",
            bytes.len(),
            out.len(),
            decoded,
            applied,
            encoded
        );
    }
}
