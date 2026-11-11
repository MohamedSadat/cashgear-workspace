//! Spike S7 on the server side: hostile updates are refused or flagged, and nothing crashes.
use super::*;
use yrs::{Doc, Text, Transact, XmlElementPrelim, XmlTextPrelim};

fn policy() -> Policy {
    Policy {
        clients: vec![1],
        elements: ["block", "textBody", "paragraph", "image"]
            .map(String::from)
            .to_vec(),
        max_bytes: 1024 * 1024,
    }
}

/// One block with one text body, written as client `client`, with `text` and an optional link.
fn page(client: u64, element: &str, link: Option<&str>) -> Vec<u8> {
    let doc = Doc::with_client_id(client);
    let content = doc.get_or_insert_xml_fragment(CONTENT);
    let mut txn = doc.transact_mut();
    let block = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
    block.insert_attribute(&mut txn, "id", "aaaaaaaaaaaa");
    let body = block.push_back(&mut txn, XmlElementPrelim::empty(element));
    let text = body.push_back(&mut txn, XmlTextPrelim::new("click here"));
    if let Some(href) = link {
        let mut attrs = std::collections::HashMap::new();
        attrs.insert("href".to_string(), Any::String(href.into()));
        let mark: Attrs = [("link".into(), Any::Map(attrs.into()))].into();
        text.format(&mut txn, 0, 5, mark);
    }
    txn.encode_update_v1()
}

#[test]
fn an_honest_update_passes() {
    assert_eq!(
        validate(
            &[],
            &page(1, "textBody", Some("https://example.com")),
            &policy()
        )
        .unwrap(),
        Vec::<String>::new()
    );
}

#[test]
fn a_forged_client_id_is_flagged() {
    let problems = validate(&[], &page(999, "textBody", None), &policy()).unwrap();
    assert!(
        problems.iter().any(|p| p.contains("client 999")),
        "{problems:?}"
    );
}

#[test]
fn an_unknown_element_is_flagged() {
    let problems = validate(&[], &page(1, "script", None), &policy()).unwrap();
    assert!(
        problems.iter().any(|p| p.contains("<script>")),
        "{problems:?}"
    );
}

#[test]
fn unsafe_link_schemes_are_flagged() {
    for href in [
        "javascript:alert(1)",
        "  JaVaScRiPt:alert(1)",
        "data:text/html,<script>alert(1)</script>",
        "vbscript:msgbox",
    ] {
        let problems = validate(&[], &page(1, "textBody", Some(href)), &policy()).unwrap();
        assert!(
            problems.iter().any(|p| p.contains("unsafe scheme")),
            "{href}: {problems:?}"
        );
    }
    for href in ["https://a.b", "mailto:x@y.z", "#heading", "/page/1"] {
        assert!(validate(&[], &page(1, "textBody", Some(href)), &policy())
            .unwrap()
            .is_empty());
    }
}

#[test]
fn an_oversized_update_is_refused_before_decoding() {
    let big = vec![0u8; MAX_INPUT_BYTES + 1];
    assert!(matches!(compact(&big), Err(YdocError::Decode(_))));
    let problems = validate(&[], &vec![0u8; 2 * 1024 * 1024], &policy()).unwrap();
    assert!(problems[0].contains("limit"));
}

#[test]
fn deep_nesting_is_refused_without_exhausting_the_stack() {
    // 100,000 nested elements, built iteratively.
    let doc = Doc::with_client_id(1);
    let content = doc.get_or_insert_xml_fragment(CONTENT);
    {
        let mut txn = doc.transact_mut();
        let mut parent = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        for _ in 0..100_000 {
            parent = parent.push_back(&mut txn, XmlElementPrelim::empty("block"));
        }
    }
    let update = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    // A small stack, like a worker thread's, must be enough.
    let result = std::thread::Builder::new()
        .stack_size(1024 * 1024)
        .spawn(move || {
            (
                to_prosemirror_json(&update, CONTENT),
                compact(&update).map(|c| c.len()),
                validate(&[], &update, &Policy::default()),
            )
        })
        .unwrap()
        .join()
        .expect("no stack overflow");
    assert!(matches!(result.0, Err(YdocError::Shape(_))));
    assert!(result.1.is_ok());
    assert!(result
        .2
        .unwrap()
        .iter()
        .any(|p| p.contains("nested deeper")));
}

/// A string's length field claiming far more bytes than the update holds.
#[test]
fn a_lying_length_is_refused_without_allocating_it() {
    let doc = Doc::with_client_id(1);
    let text = doc.get_or_insert_text("t");
    let update = {
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, "QQQQQQQQ");
        txn.encode_update_v1()
    };
    // The string is written as its length (8) followed by the bytes: claim 2^40 instead.
    let at = update
        .windows(9)
        .position(|w| w[0] == 8 && &w[1..] == b"QQQQQQQQ")
        .expect("the string in the update");
    let mut lying = update[..at].to_vec();
    lying.extend_from_slice(&[0x80, 0x80, 0x80, 0x80, 0x80, 0x20]); // varint 2^40
    lying.extend_from_slice(&update[at + 1..]);
    assert!(compact(&lying).is_err());
    assert!(merge(&[&lying]).is_err());
}

#[test]
fn a_struct_claiming_a_huge_clock_range_does_not_crash() {
    // One client, one GC struct of length 2^50: an update that claims a vast clock range.
    let mut bytes = vec![1u8, 1, 7, 0, 0];
    bytes.extend_from_slice(&[0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x02]);
    bytes.push(0); // no delete set
    let _ = compact(&bytes);
    let _ = state_vector(&bytes);
    let _ = client_ranges(&bytes);
}
