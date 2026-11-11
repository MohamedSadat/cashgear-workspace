//! The C ABI the .NET worker calls by P/Invoke.
//!
//! Every function returns 0 on success or an error code ([`YdocError::code`]), and writes its
//! result or a UTF-8 error message to `out`, which the caller frees with [`cgw_buffer_free`].
//! A panic is caught here and returned as code 5; nothing unwinds across the boundary. This
//! needs `panic = "unwind"`, so the library is built with the `ffi` profile.

use std::panic::{catch_unwind, AssertUnwindSafe};

use crate::{YdocError, CONTENT};

/// Bytes owned by this library, returned to the caller.
#[repr(C)]
pub struct CgwBuffer {
    pub ptr: *mut u8,
    pub len: usize,
}

/// Bytes owned by the caller, lent for one call.
#[repr(C)]
pub struct CgwSlice {
    pub ptr: *const u8,
    pub len: usize,
}

impl CgwBuffer {
    const EMPTY: CgwBuffer = CgwBuffer {
        ptr: std::ptr::null_mut(),
        len: 0,
    };

    fn from_vec(bytes: Vec<u8>) -> CgwBuffer {
        let mut boxed = bytes.into_boxed_slice();
        let buffer = CgwBuffer {
            ptr: boxed.as_mut_ptr(),
            len: boxed.len(),
        };
        std::mem::forget(boxed);
        buffer
    }
}

/// # Safety
/// `slice` must point to `len` readable bytes, or be null with `len` 0.
unsafe fn borrow<'a>(slice: &CgwSlice) -> Result<&'a [u8], YdocError> {
    if slice.ptr.is_null() {
        return if slice.len == 0 {
            Ok(&[])
        } else {
            Err(YdocError::Decode("a null pointer with a length".into()))
        };
    }
    Ok(std::slice::from_raw_parts(slice.ptr, slice.len))
}

/// Runs `body`, writes its bytes or its error to `out`, and returns the status.
fn run(out: *mut CgwBuffer, body: impl FnOnce() -> Result<Vec<u8>, YdocError>) -> i32 {
    if out.is_null() {
        return YdocError::Decode(String::new()).code();
    }
    let result = match catch_unwind(AssertUnwindSafe(body)) {
        Ok(result) => result,
        Err(panic) => {
            let message = panic
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "panic".to_string());
            Err(YdocError::Panic(message))
        }
    };
    let (status, bytes) = match result {
        Ok(bytes) => (0, bytes),
        Err(error) => (error.code(), error.to_string().into_bytes()),
    };
    // SAFETY: `out` was checked for null; the caller owns the struct it points to.
    unsafe { *out = CgwBuffer::from_vec(bytes) };
    status
}

/// Frees a buffer this library returned. Freeing an empty buffer does nothing.
///
/// # Safety
/// `buffer` must have come from this library and not have been freed before.
#[no_mangle]
pub unsafe extern "C" fn cgw_buffer_free(buffer: CgwBuffer) {
    if !buffer.ptr.is_null() {
        drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(
            buffer.ptr, buffer.len,
        )));
    }
}

/// # Safety
/// `updates` points to `count` slices, each valid for its length; `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn cgw_merge(
    updates: *const CgwSlice,
    count: usize,
    out: *mut CgwBuffer,
) -> i32 {
    run(out, || {
        if updates.is_null() && count > 0 {
            return Err(YdocError::Decode("a null list".into()));
        }
        let slices = if count == 0 {
            &[][..]
        } else {
            std::slice::from_raw_parts(updates, count)
        };
        let borrowed = slices
            .iter()
            .map(|s| borrow(s))
            .collect::<Result<Vec<_>, _>>()?;
        crate::merge(&borrowed)
    })
}

/// # Safety
/// As [`cgw_merge`], for one slice.
#[no_mangle]
pub unsafe extern "C" fn cgw_state_vector(update: CgwSlice, out: *mut CgwBuffer) -> i32 {
    run(out, || crate::state_vector(borrow(&update)?))
}

/// # Safety
/// As [`cgw_merge`], for two slices.
#[no_mangle]
pub unsafe extern "C" fn cgw_diff(
    update: CgwSlice,
    state_vector: CgwSlice,
    out: *mut CgwBuffer,
) -> i32 {
    run(out, || {
        crate::diff(borrow(&update)?, borrow(&state_vector)?)
    })
}

/// # Safety
/// As [`cgw_merge`], for one slice.
#[no_mangle]
pub unsafe extern "C" fn cgw_compact(update: CgwSlice, out: *mut CgwBuffer) -> i32 {
    run(out, || crate::compact(borrow(&update)?))
}

/// ProseMirror JSON of the `content` fragment, UTF-8.
///
/// # Safety
/// As [`cgw_merge`], for one slice.
#[no_mangle]
pub unsafe extern "C" fn cgw_to_json(update: CgwSlice, out: *mut CgwBuffer) -> i32 {
    run(out, || {
        crate::to_prosemirror_json(borrow(&update)?, CONTENT).map(String::into_bytes)
    })
}

/// Plain text of the `content` fragment, UTF-8.
///
/// # Safety
/// As [`cgw_merge`], for one slice.
#[no_mangle]
pub unsafe extern "C" fn cgw_to_text(update: CgwSlice, out: *mut CgwBuffer) -> i32 {
    run(out, || {
        crate::to_plain_text(borrow(&update)?, CONTENT).map(String::into_bytes)
    })
}

/// `{"ranges":[{"client","start","end"}],"deletes":[client]}`, UTF-8 JSON.
///
/// # Safety
/// As [`cgw_merge`], for one slice.
#[no_mangle]
pub unsafe extern "C" fn cgw_client_ranges(update: CgwSlice, out: *mut CgwBuffer) -> i32 {
    run(out, || {
        let (ranges, deleting) = crate::client_ranges(borrow(&update)?)?;
        Ok(crate::to_json_ranges(&ranges, &deleting).into_bytes())
    })
}

/// `meta` as JSON, UTF-8.
///
/// # Safety
/// As [`cgw_merge`], for one slice.
#[no_mangle]
pub unsafe extern "C" fn cgw_meta(update: CgwSlice, out: *mut CgwBuffer) -> i32 {
    run(out, || {
        crate::meta_json(borrow(&update)?).map(String::into_bytes)
    })
}

/// The library's version, for the worker's log. Never fails.
#[no_mangle]
pub extern "C" fn cgw_version(out: *mut CgwBuffer) -> i32 {
    run(out, || Ok(env!("CARGO_PKG_VERSION").as_bytes().to_vec()))
}

#[doc(hidden)]
pub fn empty_buffer() -> CgwBuffer {
    CgwBuffer::EMPTY
}

/// Validates `update` on top of `state` against a policy given as JSON:
/// `{"clients":[u64],"elements":[string],"maxBytes":n,"blockIds":bool}`. Writes
/// `{"problems":[string]}`.
///
/// # Safety
/// As [`cgw_merge`], for three slices.
#[no_mangle]
pub unsafe extern "C" fn cgw_validate(
    state: CgwSlice,
    update: CgwSlice,
    policy: CgwSlice,
    out: *mut CgwBuffer,
) -> i32 {
    run(out, || {
        let policy: serde_json::Value = serde_json::from_slice(borrow(&policy)?)
            .map_err(|e| YdocError::Decode(format!("policy: {e}")))?;
        let policy = crate::Policy {
            clients: policy["clients"]
                .as_array()
                .map(|a| a.iter().filter_map(|c| c.as_u64()).collect())
                .unwrap_or_default(),
            elements: policy["elements"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|e| e.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default(),
            max_bytes: policy["maxBytes"].as_u64().unwrap_or(0) as usize,
            block_ids: policy["blockIds"].as_bool().unwrap_or(false),
        };
        let problems = crate::validate(borrow(&state)?, borrow(&update)?, &policy)?;
        Ok(serde_json::json!({ "problems": problems })
            .to_string()
            .into_bytes())
    })
}
