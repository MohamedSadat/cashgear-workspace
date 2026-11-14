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
fn lists_a_client_whose_blocks_start_past_clock_zero() {
    // The second update continues client 1: its first block is not at clock 0. It must still
    // name client 1, or the worker's check that the client is the pusher's never runs.
    let (a, b) = sample();
    let (first, _) = client_ranges(&a).unwrap();
    let (ranges, _) = client_ranges(&b).unwrap();
    assert_eq!(ranges.len(), 1);
    assert_eq!(ranges[0].client, 1);
    assert_eq!(ranges[0].start, first[0].end);
    assert!(ranges[0].end > ranges[0].start);
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

/// Schema version 3 in search's plain text (the doc layer's `text.ts`): a date mention writes
/// its date as stored, ` → ` and its end when that is valid too; a database view writes nothing.
#[test]
fn plain_text_writes_date_mentions_and_nothing_for_a_database_view() {
    let doc = Doc::with_client_id(3);
    let content = doc.get_or_insert_xml_fragment(CONTENT);
    let update = {
        let mut txn = doc.transact_mut();
        let block = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        block.insert_attribute(&mut txn, "id", "cccccccccccc");
        let body = block.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        body.push_back(&mut txn, XmlTextPrelim::new("Due "));
        let span = body.push_back(&mut txn, XmlElementPrelim::empty("dateMention"));
        span.insert_attribute(&mut txn, "date", "2026-11-13");
        span.insert_attribute(&mut txn, "end", "2026-11-20T09:30:00Z");
        body.push_back(&mut txn, XmlTextPrelim::new(" and "));
        let day = body.push_back(&mut txn, XmlElementPrelim::empty("dateMention"));
        day.insert_attribute(&mut txn, "date", "2026-12-01");
        day.insert_attribute(&mut txn, "end", "next week");
        let view = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        view.insert_attribute(&mut txn, "id", "dddddddddddd");
        let table = view.push_back(&mut txn, XmlElementPrelim::empty("databaseView"));
        table.insert_attribute(
            &mut txn,
            "databaseId",
            "0195f4a0-0000-7000-8000-000000000001",
        );
        let alone = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        alone.insert_attribute(&mut txn, "id", "eeeeeeeeeeee");
        let only = alone.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        let date = only.push_back(&mut txn, XmlElementPrelim::empty("dateMention"));
        date.insert_attribute(&mut txn, "date", "2026-01-05");
        let bad = alone.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        bad.push_back(&mut txn, XmlTextPrelim::new("x"));
        let wrong = bad.push_back(&mut txn, XmlElementPrelim::empty("dateMention"));
        wrong.insert_attribute(&mut txn, "date", "٢٠٢٦-01-05");
        txn.encode_update_v1()
    };
    assert_eq!(
        to_plain_text(&update, CONTENT).unwrap(),
        "Due 2026-11-13 → 2026-11-20T09:30:00Z and 2026-12-01\n2026-01-05\nx\n"
    );
}

/// The element names a schema version knows (`packages/doc/vectors/schema-elements.json`, the
/// worker's list).
fn schema_elements(version: &str) -> Vec<String> {
    let file = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../packages/doc/vectors/schema-elements.json"
    );
    let json: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    json[version]
        .as_array()
        .expect("a list for that version")
        .iter()
        .map(|name| name.as_str().unwrap().to_string())
        .collect()
}

/// Schema version 4 (the doc layer's `text.ts`): a workbook embed and an ERP view write nothing
/// in search's plain text, even with something inside them; their attributes reach the derived
/// JSON as stored; version 4's list takes them and version 3's refuses them.
#[test]
fn version_4_bodies_write_no_text_and_only_version_4_knows_them() {
    let doc = Doc::with_client_id(4);
    let content = doc.get_or_insert_xml_fragment(CONTENT);
    let update = {
        let mut txn = doc.transact_mut();
        let first = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        first.insert_attribute(&mut txn, "id", "aaaaaaaaaaaa");
        let before = first.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        before.push_back(&mut txn, XmlTextPrelim::new("Before"));
        let sheet = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        sheet.insert_attribute(&mut txn, "id", "bbbbbbbbbbbb");
        let embed = sheet.push_back(&mut txn, XmlElementPrelim::empty("sheetEmbed"));
        embed.insert_attribute(
            &mut txn,
            "workbookId",
            "0195f4a0-0000-7000-8000-0000000000e1",
        );
        embed.insert_attribute(&mut txn, "sheet", "Q3 Sales");
        embed.insert_attribute(&mut txn, "range", "A1:D20");
        embed.insert_attribute(&mut txn, "height", 320.0);
        // Hostile: an atom holding text. It is still not the page's text.
        embed.push_back(&mut txn, XmlTextPrelim::new("Leaked cell"));
        let erp = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        erp.insert_attribute(&mut txn, "id", "cccccccccccc");
        let view = erp.push_back(&mut txn, XmlElementPrelim::empty("erpView"));
        view.insert_attribute(&mut txn, "linkId", "0195f4a0-0000-7000-8000-0000000000e2");
        view.insert_attribute(&mut txn, "connectorId", "vendors");
        view.insert_attribute(
            &mut txn,
            "filter",
            r#"{"search":"Distinctive Vendor 7731"}"#,
        );
        view.insert_attribute(&mut txn, "pageSize", 25.0);
        let inside = view.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        inside.push_back(&mut txn, XmlTextPrelim::new("Vendor 7731"));
        let last = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        last.insert_attribute(&mut txn, "id", "dddddddddddd");
        let after = last.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        after.push_back(&mut txn, XmlTextPrelim::new("After"));
        txn.encode_update_v1()
    };
    assert_eq!(to_plain_text(&update, CONTENT).unwrap(), "Before\nAfter\n");

    let json: Value =
        serde_json::from_str(&to_prosemirror_json(&update, CONTENT).unwrap()).unwrap();
    let embed = &json["content"][1]["content"][0];
    assert_eq!(embed["type"], "sheetEmbed");
    assert_eq!(embed["attrs"]["range"], "A1:D20");
    assert_eq!(embed["attrs"]["height"].as_f64(), Some(320.0));
    let view = &json["content"][2]["content"][0];
    assert_eq!(view["type"], "erpView");
    assert_eq!(view["attrs"]["connectorId"], "vendors");
    assert_eq!(view["attrs"]["pageSize"].as_f64(), Some(25.0));

    let policy = |version: &str| Policy {
        elements: schema_elements(version),
        block_ids: true,
        ..Policy::default()
    };
    assert_eq!(
        validate(&[], &update, &policy("4")).unwrap(),
        Vec::<String>::new()
    );
    let refused = validate(&[], &update, &policy("3")).unwrap();
    assert!(refused.contains(&"unknown element <sheetEmbed>".to_string()));
    assert!(refused.contains(&"unknown element <erpView>".to_string()));
    assert_eq!(refused.len(), 2, "{refused:?}");
}

/// Schema version 5 (the doc layer's `text.ts`): a user mention writes `@` alone in search's
/// plain text, even with something inside it (names change; the inbox finds one's mentions); a
/// line holding only a mention still ends; its user id reaches the derived JSON as stored;
/// version 5's list takes it and version 4's refuses it.
#[test]
fn version_5_user_mention_writes_an_at_sign_and_only_version_5_knows_it() {
    let doc = Doc::with_client_id(5);
    let content = doc.get_or_insert_xml_fragment(CONTENT);
    let update = {
        let mut txn = doc.transact_mut();
        let first = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        first.insert_attribute(&mut txn, "id", "aaaaaaaaaaaa");
        let body = first.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        body.push_back(&mut txn, XmlTextPrelim::new("Ask "));
        let sara = body.push_back(&mut txn, XmlElementPrelim::empty("userMention"));
        sara.insert_attribute(&mut txn, "userId", "0195f4a0-0000-7000-8000-0000000000b1");
        // Hostile: an atom holding text. The name is still not the page's text.
        sara.push_back(&mut txn, XmlTextPrelim::new("Sara Ali"));
        body.push_back(&mut txn, XmlTextPrelim::new(" about it"));
        let alone = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        alone.insert_attribute(&mut txn, "id", "bbbbbbbbbbbb");
        let only = alone.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        only.push_back(&mut txn, XmlElementPrelim::empty("userMention"));
        let last = content.push_back(&mut txn, XmlElementPrelim::empty("block"));
        last.insert_attribute(&mut txn, "id", "cccccccccccc");
        let after = last.push_back(&mut txn, XmlElementPrelim::empty("textBody"));
        after.push_back(&mut txn, XmlTextPrelim::new("After"));
        txn.encode_update_v1()
    };
    assert_eq!(
        to_plain_text(&update, CONTENT).unwrap(),
        "Ask @ about it\n@\nAfter\n"
    );

    let json: Value =
        serde_json::from_str(&to_prosemirror_json(&update, CONTENT).unwrap()).unwrap();
    let mention = &json["content"][0]["content"][0]["content"][1];
    assert_eq!(mention["type"], "userMention");
    assert_eq!(
        mention["attrs"]["userId"],
        "0195f4a0-0000-7000-8000-0000000000b1"
    );

    let policy = |version: &str| Policy {
        elements: schema_elements(version),
        block_ids: true,
        ..Policy::default()
    };
    assert_eq!(
        validate(&[], &update, &policy("5")).unwrap(),
        Vec::<String>::new()
    );
    // One refusal for each of the two mentions, and nothing else.
    let refused = validate(&[], &update, &policy("4")).unwrap();
    assert_eq!(
        refused,
        vec!["unknown element <userMention>".to_string(); 2],
        "{refused:?}"
    );
}
