use super::*;
use yrs::{GetString, XmlElementPrelim, XmlTextPrelim};

/// A small document as Yjs would write it: two blocks, one with a bold run.
fn sample() -> (Vec<u8>, Vec<u8>) {
    let doc = Doc::with_client_id(1);
    let content = doc.get_or_insert_xml_fragment(CONTENT);
    let first = {
        let mut txn = doc.transact_mut();
        let block = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        block.insert_attribute(&mut txn, "id", "aaaaaaaaaaaa");
        let paragraph = block.push_back(&mut txn, XmlElementPrelim::empty("paragraph"));
        let text = paragraph.push_back(&mut txn, XmlTextPrelim::new("hello "));
        let bold: Attrs = [("bold".into(), Any::Map(Default::default()))].into();
        text.insert_with_attributes(&mut txn, 6, "world", bold);
        txn.encode_update_v1()
    };
    let second = {
        let mut txn = doc.transact_mut();
        let block = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        block.insert_attribute(&mut txn, "id", "bbbbbbbbbbbb");
        let heading = block.push_back(&mut txn, XmlElementPrelim::empty("heading"));
        heading.insert_attribute(&mut txn, "level", 2.0);
        heading.push_back(&mut txn, XmlTextPrelim::new("مرحبا"));
        txn.encode_update_v1()
    };
    (first, second)
}

#[test]
fn merges_and_reads_json_and_text() {
    let (a, b) = sample();
    let merged = merge(&[&a, &b]).unwrap();
    let json: Value =
        serde_json::from_str(&to_prosemirror_json(&merged, CONTENT).unwrap()).unwrap();
    assert_eq!(json["content"][0]["attrs"]["id"], "aaaaaaaaaaaa");
    assert_eq!(
        json["content"][0]["content"][0]["content"][1]["text"],
        "world"
    );
    assert_eq!(
        json["content"][0]["content"][0]["content"][1]["marks"][0]["type"],
        "bold"
    );
    assert_eq!(json["content"][1]["content"][0]["attrs"]["level"], 2.0);
    assert_eq!(
        to_plain_text(&merged, CONTENT).unwrap(),
        "hello world\nمرحبا\n"
    );
}

#[test]
fn state_vector_and_diff_round_trip() {
    let (a, b) = sample();
    let merged = merge(&[&a, &b]).unwrap();
    let sv_a = state_vector(&a).unwrap();
    let missing = diff(&merged, &sv_a).unwrap();
    let rebuilt = merge(&[&a, &missing]).unwrap();
    assert_eq!(
        to_prosemirror_json(&rebuilt, CONTENT).unwrap(),
        to_prosemirror_json(&merged, CONTENT).unwrap()
    );
}

#[test]
fn compacts_deleted_content() {
    let doc = Doc::with_client_id(7);
    let text = doc.get_or_insert_text("t");
    let mut updates = Vec::new();
    for i in 0..200 {
        if i % 50 == 0 {
            eprintln!("step {i}");
        }
        let mut txn = doc.transact_mut();
        text.insert(&mut txn, 0, &"x".repeat(50));
        if i % 2 == 0 {
            text.remove_range(&mut txn, 0, 40);
        }
        updates.push(txn.encode_update_v1());
    }
    let borrowed: Vec<&[u8]> = updates.iter().map(Vec::as_slice).collect();
    let started = std::time::Instant::now();
    let merged = merge(&borrowed).unwrap();
    eprintln!("merged {} bytes in {:?}", merged.len(), started.elapsed());
    let started = std::time::Instant::now();
    let compacted = compact(&merged).unwrap();
    eprintln!(
        "compacted to {} bytes in {:?}",
        compacted.len(),
        started.elapsed()
    );
    assert!(compacted.len() < merged.len());
    let reloaded = load(&compacted).unwrap();
    // Root types first: asking for one while a transaction is open blocks.
    let reloaded_text = reloaded.get_or_insert_text("t");
    assert_eq!(
        reloaded_text.get_string(&reloaded.transact()),
        text.get_string(&doc.transact())
    );
}

#[test]
fn refuses_bad_input_without_panicking() {
    assert!(matches!(
        merge(&[&[0xff, 0xff, 0xff]]),
        Err(YdocError::Decode(_))
    ));
    assert!(compact(&[1, 2, 3, 4, 5]).is_err());
    assert!(to_prosemirror_json(&[], CONTENT).is_err());
    let (_, b) = sample();
    // The second update alone depends on the first: compacting it would drop it.
    assert_eq!(compact(&b), Err(YdocError::MissingDependencies));
    assert!(matches!(diff(&b, &[0xff]), Err(YdocError::Decode(_))));
}

#[test]
fn lists_client_ranges() {
    let (a, b) = sample();
    let merged = merge(&[&a, &b]).unwrap();
    let (ranges, deleting) = client_ranges(&merged).unwrap();
    assert_eq!(ranges.len(), 1);
    assert_eq!(ranges[0].client, 1);
    assert_eq!(ranges[0].start, 0);
    assert!(ranges[0].end > 0);
    assert!(deleting.is_empty());
}

#[test]
fn the_c_abi_reports_errors_and_frees() {
    use crate::ffi::*;
    let mut out = empty_buffer();
    let bad = [0xffu8, 0xff];
    let status = unsafe {
        cgw_compact(
            CgwSlice {
                ptr: bad.as_ptr(),
                len: bad.len(),
            },
            &mut out,
        )
    };
    assert_ne!(status, 0);
    let message = unsafe { std::slice::from_raw_parts(out.ptr, out.len) };
    assert!(std::str::from_utf8(message).unwrap().contains("Yjs"));
    unsafe { cgw_buffer_free(out) };
}
