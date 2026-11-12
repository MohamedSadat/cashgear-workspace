//! The state hash against the vectors plain Yjs wrote (`scripts/state-hash-vectors.mjs`), which
//! the doc layer's `stateHash` is held to as well.

use super::*;
use yrs::{GetString, Map as _};

fn vectors() -> Vec<Value> {
    let file = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/doc/vectors/state-hash-vectors.json"
    );
    let text = std::fs::read_to_string(file).expect("the vectors file");
    let json: Value = serde_json::from_str(&text).expect("JSON");
    json["vectors"].as_array().expect("a list").clone()
}

/// Standard base64, as the script writes it (no dependency for a test).
fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("not base64: {c}"),
        }
    };
    let bytes: Vec<u8> = text.bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, &c)| n | value(c) << (18 - 6 * i));
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    out
}

#[test]
fn every_vector_gives_its_text_and_hash() {
    let vectors = vectors();
    assert!(vectors.len() >= 12, "a dozen vectors at least");
    for vector in &vectors {
        let name = vector["name"].as_str().unwrap();
        let update = base64(vector["update"].as_str().unwrap());
        assert_eq!(
            state_text(&update).unwrap(),
            vector["text"].as_str().unwrap(),
            "{name}"
        );
        assert_eq!(
            state_hash(&update).unwrap(),
            vector["hash"].as_str().unwrap(),
            "{name}"
        );
        // The parts merged here give the same, as the server's state is snapshot and rows merged.
        if let Some(parts) = vector["parts"].as_array() {
            let parts: Vec<Vec<u8>> = parts.iter().map(|p| base64(p.as_str().unwrap())).collect();
            let borrowed: Vec<&[u8]> = parts.iter().map(Vec::as_slice).collect();
            assert_eq!(
                state_hash(&merge(&borrowed).unwrap()).unwrap(),
                vector["hash"].as_str().unwrap(),
                "{name}, merged here"
            );
        }
    }
}

#[test]
fn the_hash_is_of_the_state_not_the_bytes() {
    // A compacted state (garbage collected, one update) hashes as the rows it replaced.
    let doc = Doc::with_client_id(3);
    let text = doc.get_or_insert_text("t");
    let mut updates = Vec::new();
    for i in 0..30u32 {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, "abc");
        if i % 4 == 0 {
            text.remove_range(&mut txn, 1, 2);
        }
        updates.push(txn.encode_update_v1());
    }
    let borrowed: Vec<&[u8]> = updates.iter().map(Vec::as_slice).collect();
    let merged = merge(&borrowed).unwrap();
    let compacted = compact(&merged).unwrap();
    assert_ne!(merged, compacted);
    assert_eq!(
        state_hash(&merged).unwrap(),
        state_hash(&compacted).unwrap()
    );
    // Missing the last update changes it.
    let fewer = merge(&borrowed[..borrowed.len() - 1]).unwrap();
    assert_ne!(state_hash(&fewer).unwrap(), state_hash(&merged).unwrap());
    // And the text is still all there in the compacted state.
    let reloaded = Doc::new();
    let reloaded_text = reloaded.get_or_insert_text("t");
    reloaded
        .transact_mut()
        .apply_update(Update::decode_v1(&compacted).unwrap())
        .unwrap();
    assert_eq!(
        reloaded_text.get_string(&reloaded.transact()),
        text.get_string(&doc.transact())
    );
}

#[test]
fn the_empty_document_and_bad_bytes() {
    assert_eq!(state_text(&[0, 0]).unwrap(), "v1;sv=;ds=");
    assert_eq!(
        state_hash(&[0, 0]).unwrap(),
        "340499d3ba7e2b54e9a2f12f4707b92573f71a5599554b39b1a999acd6b6ab52"
    );
    assert!(matches!(
        state_hash(&[0xff, 0xff, 0xff]),
        Err(YdocError::Decode(_))
    ));
}

#[test]
fn a_map_key_set_twice_deletes_the_first_value() {
    let doc = Doc::with_client_id(5);
    let map = doc.get_or_insert_map("m");
    {
        let mut txn = doc.transact_mut();
        map.insert(&mut txn, "k", 1.0);
    }
    {
        let mut txn = doc.transact_mut();
        map.insert(&mut txn, "k", 2.0);
    }
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    assert_eq!(state_text(&update).unwrap(), "v1;sv=5:2;ds=5:0-1");
}
