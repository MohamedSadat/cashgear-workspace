//! Phase 15: the template body's copy (copy.rs). The template is written by the doc layer
//! (packages/doc/src/copyBody.test.ts makes `tests/fixtures/copy-template.bin`); the copy made here
//! is kept as `tests/fixtures/copy-result.bin` (written again with `COPY_FIXTURE_WRITE=1`) for that
//! test to read back with the editor's schema.

use std::collections::HashSet;
use std::path::PathBuf;

use serde_json::Value;

use crate::copy::{block_id, copy_body};
use crate::{meta_json, to_prosemirror_json, YdocError, CONTENT};

const COPY_ID: &str = "01900000-0000-7000-8000-00000000e002";
const SEED: &[u8] = b"phase 15 copy test seed";

fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join(name)
}

fn template() -> Vec<u8> {
    std::fs::read(fixture("copy-template.bin")).expect("the template fixture (copyBody.test.ts)")
}

fn json(update: &[u8]) -> Value {
    serde_json::from_str(&to_prosemirror_json(update, CONTENT).unwrap()).unwrap()
}

fn ids(node: &Value, out: &mut Vec<String>) {
    if node["type"] == "block" {
        out.push(node["attrs"]["id"].as_str().unwrap_or_default().to_string());
    }
    if let Some(children) = node["content"].as_array() {
        for child in children {
            ids(child, out);
        }
    }
}

fn without_ids(node: &Value) -> Value {
    let mut copy = node.clone();
    if copy["type"] == "block" {
        copy["attrs"]["id"] = Value::String("x".into());
    }
    if let Some(children) = node["content"].as_array() {
        copy["content"] = Value::Array(children.iter().map(without_ids).collect());
    }
    copy
}

#[test]
fn a_copy_holds_the_templates_content_with_every_block_id_new() {
    let source = template();
    let copy = copy_body(&source, COPY_ID, 77, SEED).unwrap();
    let (before, after) = (json(&source), json(&copy));
    assert_eq!(without_ids(&before), without_ids(&after));
    let (mut old, mut new) = (Vec::new(), Vec::new());
    ids(&before, &mut old);
    ids(&after, &mut new);
    assert!(new.len() > 15, "{} blocks", new.len());
    assert_eq!(old.len(), new.len());
    let unique: HashSet<_> = new.iter().collect();
    assert_eq!(unique.len(), new.len());
    let old: HashSet<_> = old.iter().collect();
    for id in &new {
        assert_eq!(id.len(), 12);
        assert!(id.bytes().all(|b| b.is_ascii_alphanumeric()), "{id}");
        assert!(!old.contains(id));
    }
    let meta: Value = serde_json::from_str(&meta_json(&copy).unwrap()).unwrap();
    let template_meta: Value = serde_json::from_str(&meta_json(&source).unwrap()).unwrap();
    assert_eq!(meta["pageId"], COPY_ID);
    assert_eq!(meta["epoch"], 0);
    assert_eq!(meta["schemaVersion"], template_meta["schemaVersion"]);
    // Only the new client wrote it, and it needs nothing else.
    let (ranges, deleting) = crate::client_ranges(&copy).unwrap();
    assert_eq!(
        ranges.iter().map(|r| r.client).collect::<Vec<_>>(),
        vec![77]
    );
    assert!(deleting.is_empty());
    assert_eq!(
        crate::compact(&copy).unwrap().len(),
        crate::compact(&crate::compact(&copy).unwrap())
            .unwrap()
            .len()
    );

    // The seed decides the ids: the same template and seed give the same content (the order a
    // run's marks are written in is yrs's own; they are a set).
    assert_eq!(json(&copy_body(&source, COPY_ID, 77, SEED).unwrap()), after);
    let path = fixture("copy-result.bin");
    if std::env::var("COPY_FIXTURE_WRITE").as_deref() == Ok("1") || !path.exists() {
        std::fs::write(&path, &copy).unwrap();
    }
    assert_eq!(json(&std::fs::read(&path).unwrap()), after);
}

#[test]
fn another_seed_gives_other_ids_and_the_template_is_left_alone() {
    let source = template();
    let one = copy_body(&source, COPY_ID, 77, SEED).unwrap();
    let two = copy_body(&source, COPY_ID, 77, b"another seed, as long").unwrap();
    let (mut a, mut b) = (Vec::new(), Vec::new());
    ids(&json(&one), &mut a);
    ids(&json(&two), &mut b);
    assert!(a.iter().zip(&b).all(|(x, y)| x != y));
    assert_eq!(source, template());
    assert_eq!(block_id(SEED, 0), block_id(SEED, 0));
    assert_ne!(block_id(SEED, 0), block_id(SEED, 1));
}

#[test]
fn an_empty_template_gives_a_page_with_its_meta_and_no_blocks() {
    let empty = yrs::Doc::new();
    let bytes = {
        use yrs::{ReadTxn, StateVector, Transact};
        empty.get_or_insert_xml_fragment(CONTENT);
        let txn = empty.transact();
        txn.encode_state_as_update_v1(&StateVector::default())
    };
    let copy = copy_body(&bytes, COPY_ID, 9, SEED).unwrap();
    assert_eq!(json(&copy)["content"], Value::Array(vec![]));
    let meta: Value = serde_json::from_str(&meta_json(&copy).unwrap()).unwrap();
    assert_eq!(meta["schemaVersion"], 1);
}

#[test]
fn bad_input_is_refused_and_nothing_is_made() {
    assert!(matches!(
        copy_body(b"not yjs", COPY_ID, 77, SEED),
        Err(YdocError::Decode(_))
    ));
    assert!(copy_body(&template(), COPY_ID, 77, b"short").is_err());
    assert!(copy_body(&template(), COPY_ID, 0, SEED).is_err());
    assert!(copy_body(&template(), COPY_ID, u64::from(u32::MAX) + 1, SEED).is_err());
}
