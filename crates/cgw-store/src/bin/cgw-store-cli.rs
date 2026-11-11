//! The store's requests over stdin and stdout, for the TypeScript conformance suite and the
//! benchmarks: each message is a `u32 LE` length and a frame, in both directions. Never shipped.
//!   cgw-store-cli <directory>

use std::io::{Read, Write};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("usage: cgw-store-cli <directory>");
    let mut store = match cgw_store::Store::open(std::path::Path::new(&dir)) {
        Ok(store) => store,
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    };
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut length = [0u8; 4];
        if input.read_exact(&mut length).is_err() {
            return;
        }
        let length = u32::from_le_bytes(length) as usize;
        if length > cgw_store::MAX_FRAME {
            eprintln!("frame too large");
            std::process::exit(3);
        }
        let mut request = vec![0u8; length];
        if input.read_exact(&mut request).is_err() {
            return;
        }
        let answer = store.handle(&request);
        let written = output
            .write_all(&(answer.len() as u32).to_le_bytes())
            .and_then(|_| output.write_all(&answer))
            .and_then(|_| output.flush());
        if written.is_err() {
            return;
        }
    }
}
