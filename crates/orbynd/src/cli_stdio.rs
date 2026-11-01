//! Detached Windows services must not retain their launcher's original pipes.
use std::{io, os::windows::io::AsRawHandle};
use windows_sys::Win32::Foundation::{
    HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
};

pub fn detach_standard_streams() -> io::Result<()> {
    let input = io::stdin();
    let output = io::stdout();
    let error = io::stderr();
    for handle in [
        input.as_raw_handle(),
        output.as_raw_handle(),
        error.as_raw_handle(),
    ] {
        // SAFETY: each handle is borrowed from a live standard stream. This
        // changes only its inheritance flag, without closing or redirecting it.
        unsafe {
            clear_inheritance(handle)?;
        }
    }
    Ok(())
}

/// The caller keeps a valid handle alive throughout this call; absent console
/// handles are allowed when the CLI itself was launched without a console.
unsafe fn clear_inheritance(handle: HANDLE) -> io::Result<()> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Ok(());
    }
    // SAFETY: the caller owns the handle lifetime. The flag mask is documented
    // for SetHandleInformation, and changing inheritance preserves read/write.
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use windows_sys::Win32::Foundation::GetHandleInformation;

    #[test]
    fn detaching_a_borrowed_handle_preserves_its_contents_and_owner() {
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
        let path = std::env::temp_dir().join(format!("orbyn-stdio-{}", orbyn_core::util::new_id()));
        // Declared before File so unwinding closes the handle before cleanup.
        let _cleanup = Cleanup(path.clone());
        let mut file = std::fs::File::options()
            .create_new(true)
            .write(true)
            .open(&path)
            .unwrap();
        let handle = file.as_raw_handle();
        // SAFETY: file owns this handle until the end of the test. Both APIs
        // operate only on its inheritance flags, not on file ownership.
        unsafe {
            assert_ne!(
                SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT),
                0
            );
            let mut flags = 0;
            assert_ne!(GetHandleInformation(handle, &mut flags), 0);
            assert_ne!(flags & HANDLE_FLAG_INHERIT, 0);
            clear_inheritance(handle).unwrap();
            assert_ne!(GetHandleInformation(handle, &mut flags), 0);
            assert_eq!(flags & HANDLE_FLAG_INHERIT, 0);
        }
        file.write_all(b"still writable").unwrap();
        drop(file);
        assert_eq!(std::fs::read(path).unwrap(), b"still writable");
    }
}
