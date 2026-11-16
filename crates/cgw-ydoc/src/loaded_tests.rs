//! Phase 8: a document loaded once answers exactly what the functions that load it each time
//! answer for the same bytes, and the functions that now decode their input once give the bytes
//! `yrs` gives.
use super::*;
use crate::hostile_tests::page;
use crate::state_hash_tests::{base64, vectors};
use yrs::{Map as _, Text, Transact, XmlElementPrelim, XmlTextPrelim};

/// Every kind of document the tests know: the state-hash vectors, hostile pages, a long history.
fn corpus() -> Vec<(String, Vec<u8>)> {
    let mut all: Vec<(String, Vec<u8>)> = vectors()
        .iter()
        .map(|v| {
            (
                v["name"].as_str().unwrap().to_string(),
                base64(v["update"].as_str().unwrap()),
            )
        })
        .collect();
    all.push(("honest".into(), page(1, "textBody", None)));
    all.push(("unknown element".into(), page(1, "script", None)));
    all.push((
        "unsafe link".into(),
        page(1, "textBody", Some("javascript:alert(1)")),
    ));
    // A history: blocks typed into, cut and formatted by two clients, merged as the worker keeps it.
    let doc = Doc::with_client_id(11);
    let content = doc.get_or_insert_xml_fragment(CONTENT);
    let meta = doc.get_or_insert_map(META);
    let mut updates = Vec::new();
    {
        let mut txn = doc.transact_mut();
        meta.insert(&mut txn, "schemaVersion", 3.0);
        meta.insert(&mut txn, "pageId", "0193a000-0000-7000-8000-000000000001");
        updates.push(txn.encode_update_v1());
    }
    for i in 0..40u32 {
        let mut txn = doc.transact_mut();
        let block = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        block.insert_attribute(&mut txn, "id", format!("Blk{i:09}"));
        let body = block.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        let text = body.push_back(&mut txn, XmlTextPrelim::new("the ledger and the budget"));
        if i % 3 == 0 {
            text.remove_range(&mut txn, 4, 7);
        }
        if i % 4 == 0 {
            let bold: Attrs = [("bold".into(), Any::Map(Default::default()))].into();
            text.format(&mut txn, 0, 3, bold);
        }
        updates.push(txn.encode_update_v1());
    }
    let parts: Vec<&[u8]> = updates.iter().map(Vec::as_slice).collect();
    all.push(("history".into(), merge(&parts).unwrap()));
    all
}

#[test]
fn a_loaded_document_answers_as_each_function_does() {
    let policies = [
        Policy {
            elements: Vec::new(),
            block_ids: true,
            ..Policy::default()
        },
        Policy {
            elements: ["block", "textBody"].map(String::from).to_vec(),
            block_ids: true,
            ..Policy::default()
        },
        Policy {
            elements: ["block"].map(String::from).to_vec(),
            block_ids: false,
            ..Policy::default()
        },
    ];
    for (name, update) in corpus() {
        let loaded = match Loaded::load(&update) {
            Ok(loaded) => loaded,
            Err(error) => {
                // It fails exactly where loading for the meta fails.
                assert_eq!(Err(error), meta_json(&update), "{name}");
                continue;
            }
        };
        assert_eq!(
            loaded.state_vector(),
            state_vector(&update).unwrap(),
            "{name}"
        );
        assert_eq!(loaded.meta_json(), meta_json(&update), "{name}");
        assert_eq!(loaded.state_hash(), state_hash(&update).unwrap(), "{name}");
        assert_eq!(
            loaded.to_prosemirror_json(),
            to_prosemirror_json(&update, CONTENT),
            "{name}"
        );
        assert_eq!(
            loaded.to_plain_text(),
            to_plain_text(&update, CONTENT),
            "{name}"
        );
        for policy in &policies {
            // validate on an empty state is the update alone: its tree's problems.
            assert_eq!(
                loaded.check(policy),
                validate(&[], &update, policy).unwrap(),
                "{name}"
            );
        }
    }
}

#[test]
fn a_document_missing_what_it_refers_to_does_not_load() {
    let doc = Doc::with_client_id(5);
    let text = doc.get_or_insert_text("t");
    {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, "first");
    }
    let vector = doc.transact().state_vector();
    {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 5, " second");
    }
    let later = doc.transact().encode_state_as_update_v1(&vector);
    assert_eq!(
        Loaded::load(&later).err(),
        Some(YdocError::MissingDependencies)
    );
    assert_eq!(meta_json(&later), Err(YdocError::MissingDependencies));
    assert!(matches!(
        Loaded::load(&[1, 2, 3]),
        Err(YdocError::Decode(_))
    ));
}

#[test]
fn decoding_once_gives_the_bytes_yrs_gives() {
    let all = corpus();
    for (name, update) in &all {
        assert_eq!(
            state_vector(update).unwrap(),
            yrs::encode_state_vector_from_update_v1(update).unwrap(),
            "{name}"
        );
    }
    for window in all.windows(3) {
        let parts: Vec<&[u8]> = window.iter().map(|(_, u)| u.as_slice()).collect();
        assert_eq!(
            merge(&parts).unwrap(),
            yrs::merge_updates_v1(parts.iter().copied()).unwrap()
        );
    }
    assert_eq!(
        merge(&[]).unwrap(),
        yrs::merge_updates_v1(Vec::<&[u8]>::new()).unwrap()
    );
    // The first input that does not decode is the error, as before.
    let good = page(1, "textBody", None);
    assert!(matches!(
        merge(&[&good, &[9, 9, 9], &[1]]),
        Err(YdocError::Decode(_))
    ));
}
