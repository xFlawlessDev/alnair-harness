//! Explicit inheritance keeps captured CLI pipes out of a detached daemon.

use std::fs::File;
use std::os::windows::ffi::OsStrExt as _;
use std::os::windows::io::{AsRawHandle as _, FromRawHandle as _, OwnedHandle};
use std::os::windows::process::ExitStatusExt as _;
use std::process::ExitStatus;

use anyhow::Result;
use windows::Win32::Foundation::{
    DUPLICATE_SAME_ACCESS, DuplicateHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows::Win32::System::Threading::*;
use windows::core::{PCWSTR, PWSTR};

use crate::service::ServiceConfig;

pub(crate) struct Child(OwnedHandle);

impl Child {
    fn handle(&self) -> HANDLE {
        HANDLE(self.0.as_raw_handle())
    }

    pub(crate) fn try_wait(&mut self) -> Result<Option<ExitStatus>> {
        // The owned process handle remains valid for both calls.
        unsafe {
            match WaitForSingleObject(self.handle(), 0) {
                WAIT_TIMEOUT => Ok(None),
                WAIT_OBJECT_0 => {
                    let mut code = 0;
                    GetExitCodeProcess(self.handle(), &mut code)?;
                    Ok(Some(ExitStatus::from_raw(code)))
                }
                _ => Err(std::io::Error::last_os_error().into()),
            }
        }
    }

    pub(crate) fn wait(&mut self) -> Result<ExitStatus> {
        unsafe {
            if WaitForSingleObject(self.handle(), INFINITE) != WAIT_OBJECT_0 {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        self.try_wait()?
            .ok_or_else(|| anyhow::anyhow!("process did not exit"))
    }

    pub(crate) fn kill(&mut self) -> Result<()> {
        // Only used for the child we just created when startup times out.
        unsafe { TerminateProcess(self.handle(), 1)? };
        Ok(())
    }
}

struct Attributes {
    _storage: Vec<usize>,
    list: LPPROC_THREAD_ATTRIBUTE_LIST,
}

impl Drop for Attributes {
    fn drop(&mut self) {
        unsafe { DeleteProcThreadAttributeList(self.list) };
    }
}

fn inheritable(file: &File) -> Result<OwnedHandle> {
    let mut handle = HANDLE::default();
    unsafe {
        DuplicateHandle(
            GetCurrentProcess(),
            HANDLE(file.as_raw_handle()),
            GetCurrentProcess(),
            &mut handle,
            0,
            true,
            DUPLICATE_SAME_ACCESS,
        )?;
        Ok(OwnedHandle::from_raw_handle(handle.0))
    }
}

// Windows CRT quoting: backslashes are doubled before a quote or the closing quote.
fn quoted(argument: &std::ffi::OsStr) -> Vec<u16> {
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for unit in argument.encode_wide() {
        if unit == b'\\' as u16 {
            slashes += 1;
        } else {
            result.extend(std::iter::repeat_n(
                b'\\' as u16,
                slashes * if unit == b'"' as u16 { 2 } else { 1 },
            ));
            if unit == b'"' as u16 {
                result.push(b'\\' as u16);
            }
            result.push(unit);
            slashes = 0;
        }
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    result
}

pub(crate) fn spawn(config: &ServiceConfig, log: File) -> Result<Child> {
    let executable = std::env::current_exe()?;
    let mut arguments = vec![
        executable.into_os_string(),
        "web".into(),
        "--serve-service".into(),
        "--bind".into(),
        config.bind.to_string().into(),
    ];
    if let Some(url) = &config.public_url {
        arguments.extend(["--public-url".into(), url.into()]);
    }
    let mut command = Vec::new();
    for argument in &arguments {
        if !command.is_empty() {
            command.push(b' ' as u16);
        }
        command.extend(quoted(argument));
    }
    command.push(0);
    let null = File::options().read(true).write(true).open("NUL")?;
    let null = inheritable(&null)?;
    let log = inheritable(&log)?;
    let handles = [HANDLE(null.as_raw_handle()), HANDLE(log.as_raw_handle())];
    // All buffers and inheritable handles outlive CreateProcessW. The attribute
    // storage is usize-aligned and deleted before its allocation is released.
    unsafe {
        let mut size = 0;
        let _sizing = InitializeProcThreadAttributeList(None, 1, None, &mut size);
        anyhow::ensure!(size > 0, "could not size process attribute list");
        let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
        let list = LPPROC_THREAD_ATTRIBUTE_LIST(storage.as_mut_ptr().cast());
        InitializeProcThreadAttributeList(Some(list), 1, None, &mut size)?;
        let attributes = Attributes {
            _storage: storage,
            list,
        };
        UpdateProcThreadAttribute(
            attributes.list,
            0,
            PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
            Some(handles.as_ptr().cast()),
            size_of_val(&handles),
            None,
            None,
        )?;
        let mut startup = STARTUPINFOEXW::default();
        startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = handles[0];
        startup.StartupInfo.hStdOutput = handles[0];
        startup.StartupInfo.hStdError = handles[1];
        startup.lpAttributeList = attributes.list;
        let mut process = PROCESS_INFORMATION::default();
        CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(command.as_mut_ptr())),
            None,
            None,
            true,
            DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | EXTENDED_STARTUPINFO_PRESENT,
            None,
            PCWSTR::null(),
            &startup.StartupInfo,
            &mut process,
        )?;
        let _thread = OwnedHandle::from_raw_handle(process.hThread.0);
        Ok(Child(OwnedHandle::from_raw_handle(process.hProcess.0)))
    }
}

#[cfg(test)]
mod tests {
    use super::quoted;

    #[test]
    fn command_arguments_preserve_spaces_quotes_and_trailing_backslashes() {
        for (argument, expected) in [
            (
                r"C:\Program Files\Alnair\alnair.exe",
                r#""C:\Program Files\Alnair\alnair.exe""#,
            ),
            (r"C:\path with spaces\", r#""C:\path with spaces\\""#),
            ("a\"b", "\"a\\\"b\""),
            ("", "\"\""),
        ] {
            assert_eq!(
                String::from_utf16(&quoted(argument.as_ref())).unwrap(),
                expected
            );
        }
    }
}
