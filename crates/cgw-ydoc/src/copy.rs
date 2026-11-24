//! A template's body copied into a new page's first update (Phase 15: a rule's "add a row" step;
//! DECISIONS.md, 2026-11-24). The same copy the client makes with `withNewIds` and
//! `newDocumentUpdate`: every element, attribute, text and mark kept as the template holds them,
//! every `block` given a new id (made once, from the server's random seed), the new page's meta
//! stamped (`schemaVersion` the template's, `epoch` 0, `pageId` the new page's). Nothing is ever
//! written into an existing document: the result is a page's whole first update.

use std::sync::Arc;

use sha2::{Digest, Sha256};
use yrs::any::Number;
use yrs::types::text::YChange;
use yrs::types::Attrs;
use yrs::updates::decoder::Decode;
use yrs::{
    Any, Doc, Map, Options, Out, ReadTxn, StateVector, Text, Transact, TransactionMut, Update, Xml,
    XmlElementPrelim, XmlElementRef, XmlFragment, XmlFragmentRef, XmlOut, XmlTextPrelim,
};

use crate::{YdocError, CONTENT, MAX_DEPTH, META};

const DIGITS: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/// The `n`th block id a seed gives: 12 characters of base 62 (DATA_MODEL.md, Identifiers).
pub fn block_id(seed: &[u8], n: u64) -> String {
    let mut hash = Sha256::new();
    hash.update(seed);
    hash.update(n.to_le_bytes());
    let digest = hash.finalize();
    digest[..12]
        .iter()
        .map(|b| DIGITS[(*b as usize) % 62] as char)
        .collect()
}

struct Ids<'a> {
    seed: &'a [u8],
    next: u64,
}

impl Ids<'_> {
    fn take(&mut self) -> String {
        let id = block_id(self.seed, self.next);
        self.next += 1;
        id
    }
}

fn shape(message: impl Into<String>) -> YdocError {
    YdocError::Shape(message.into())
}

fn copy_attributes<T: ReadTxn>(
    read: &T,
    from: &XmlElementRef,
    write: &mut TransactionMut,
    to: &XmlElementRef,
    ids: &mut Ids,
) -> Result<(), YdocError> {
    let block = from.tag().as_ref() == "block";
    let mut attributes: Vec<(String, Any)> = Vec::new();
    for (key, value) in from.attributes(read) {
        match value {
            Out::Any(any) => attributes.push((key.to_string(), any)),
            other => {
                return Err(shape(format!(
                    "an attribute holds a shared type: {other:?}"
                )))
            }
        }
    }
    // In a fixed order, so the same template and seed always give the same bytes.
    attributes.sort_by(|a, b| a.0.cmp(&b.0));
    for (key, any) in attributes {
        if block && key == "id" {
            continue;
        }
        to.insert_attribute(write, key, any);
    }
    if block {
        to.insert_attribute(write, "id", Any::String(Arc::from(ids.take())));
    }
    Ok(())
}

fn copy_children<T: ReadTxn>(
    read: &T,
    from: &XmlElementRef,
    write: &mut TransactionMut,
    to: &XmlElementRef,
    depth: usize,
    ids: &mut Ids,
) -> Result<(), YdocError> {
    for (index, child) in (0u32..).zip(from.children(read)) {
        copy_node(
            read,
            &child,
            write,
            ToParent::Element(to),
            index,
            depth + 1,
            ids,
        )?;
    }
    Ok(())
}

enum ToParent<'a> {
    Fragment(&'a XmlFragmentRef),
    Element(&'a XmlElementRef),
}

fn copy_node<T: ReadTxn>(
    read: &T,
    node: &XmlOut,
    write: &mut TransactionMut,
    parent: ToParent,
    index: u32,
    depth: usize,
    ids: &mut Ids,
) -> Result<(), YdocError> {
    if depth > MAX_DEPTH {
        return Err(shape(format!("nested deeper than {MAX_DEPTH}")));
    }
    match node {
        XmlOut::Element(element) => {
            let prelim = XmlElementPrelim::empty(element.tag().clone());
            let made = match parent {
                ToParent::Fragment(f) => f.insert(write, index, prelim),
                ToParent::Element(e) => e.insert(write, index, prelim),
            };
            copy_attributes(read, element, write, &made, ids)?;
            copy_children(read, element, write, &made, depth, ids)?;
        }
        XmlOut::Text(text) => {
            let made = match parent {
                ToParent::Fragment(f) => f.insert(write, index, XmlTextPrelim::new("")),
                ToParent::Element(e) => e.insert(write, index, XmlTextPrelim::new("")),
            };
            for chunk in text.diff(read, YChange::identity) {
                let insert = match &chunk.insert {
                    Out::Any(Any::String(s)) => s.clone(),
                    other => return Err(shape(format!("text holds an embed: {other:?}"))),
                };
                let at = made.len(&*write);
                // Each run's marks exactly as the template's: none given is none, never the
                // previous run's carried on (as typing would).
                let attrs: Attrs = chunk.attributes.as_deref().cloned().unwrap_or_default();
                made.insert_with_attributes(write, at, &insert, attrs);
            }
        }
        XmlOut::Fragment(_) => return Err(shape("a fragment inside content")),
    }
    Ok(())
}

/// The template's body (`update`, its whole state) as a new page's first update, written as
/// `client_id`, its blocks' ids from `seed`. Fails on a document this library cannot read whole
/// (missing dependencies, an embed, a shared type in an attribute), so nothing half copied is kept.
pub fn copy_body(
    update: &[u8],
    page_id: &str,
    client_id: u64,
    seed: &[u8],
) -> Result<Vec<u8>, YdocError> {
    if seed.len() < 16 {
        return Err(YdocError::Decode("a seed of at least 16 bytes".into()));
    }
    if client_id == 0 || client_id > u32::MAX as u64 {
        return Err(YdocError::Decode("a client id of 32 bits".into()));
    }
    let template = crate::load_doc(update)?;
    let source_content = template.get_or_insert_xml_fragment(CONTENT);
    let source_meta = template.get_or_insert_map(META);
    let made = Doc::with_options(Options {
        client_id: yrs::block::ClientID::new(client_id),
        skip_gc: false,
        ..Options::default()
    });
    let content = made.get_or_insert_xml_fragment(CONTENT);
    let meta = made.get_or_insert_map(META);
    let read = template.transact();
    let version = match source_meta.get(&read, "schemaVersion") {
        Some(Out::Any(any)) => any,
        _ => Any::Number(Number::Int(1)),
    };
    let mut ids = Ids { seed, next: 0 };
    {
        let mut write = made.transact_mut();
        meta.insert(&mut write, "schemaVersion", version);
        meta.insert(&mut write, "epoch", Any::Number(Number::Int(0)));
        meta.insert(&mut write, "pageId", Any::String(Arc::from(page_id)));
        for (index, child) in (0u32..).zip(source_content.children(&read)) {
            copy_node(
                &read,
                &child,
                &mut write,
                ToParent::Fragment(&content),
                index,
                1,
                &mut ids,
            )?;
        }
    }
    let bytes = made
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    // What was written decodes as an update (a check of the copy itself).
    Update::decode_v1(&bytes).map_err(|e| YdocError::Apply(e.to_string()))?;
    Ok(bytes)
}
