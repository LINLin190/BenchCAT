#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};

const COMMAND_REGISTRY: &str =
    include_str!("../../../src/ethercat_debug_tool/protocol/commands.json");
type PendingResult = Result<Value, Value>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Lifecycle {
    Starting,
    Ready,
    Busy,
    Stalled,
    Stopping,
    Exited,
}
impl Lifecycle {
    fn label(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Busy => "busy",
            Self::Stalled => "stalled",
            Self::Stopping => "stopping",
            Self::Exited => "exited",
        }
    }
}

#[derive(Deserialize)]
struct Registry {
    protocol_version: u64,
    limits: Limits,
    commands: HashMap<String, CommandSpec>,
}
#[derive(Deserialize)]
struct Limits {
    max_frame_bytes: usize,
}
#[derive(Deserialize)]
struct CommandSpec {
    timeout_ms: u64,
    mutating: bool,
}

fn append_log(path: &Path, line: &str) {
    if path.metadata().is_ok_and(|m| m.len() >= 1_048_576) {
        let backup = path.with_file_name("python-bridge.log.1");
        let _ = fs::remove_file(&backup);
        let _ = fs::rename(path, backup);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

fn bridge_error(code: &str, message: String, method: Option<&str>, unknown: bool) -> Value {
    json!({"code":code,"message":message,"category":"transport","recoverable":false,
        "session_invalidated":true,"operation_result":if unknown {"unknown"} else {"failed"},"method":method})
}

fn snapshot_with_generation(
    snapshot: &Value,
    session_id: u64,
    generation: u64,
) -> Result<Value, Value> {
    let mut snapshot = snapshot.as_object().cloned().ok_or_else(|| {
        bridge_error(
            "PROTOCOL",
            "桥接响应缺少完整 Master 快照".into(),
            None,
            false,
        )
    })?;
    let snapshot_session = snapshot
        .get("session_id")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            bridge_error(
                "PROTOCOL",
                "Master 快照缺少有效 session_id".into(),
                None,
                false,
            )
        })?;
    if snapshot_session != session_id {
        return Err(bridge_error(
            "PROTOCOL",
            "响应 session_id 与 Master 快照不一致".into(),
            None,
            false,
        ));
    }
    if snapshot.get("revision").and_then(Value::as_u64).is_none() {
        return Err(bridge_error(
            "PROTOCOL",
            "Master 快照缺少有效 revision".into(),
            None,
            false,
        ));
    }
    let complete = snapshot.get("mode").is_some_and(Value::is_string)
        && snapshot.get("phase").is_some_and(Value::is_string)
        && snapshot
            .get("adapter")
            .is_some_and(|value| value.is_null() || value.is_string())
        && snapshot.get("connected").is_some_and(Value::is_boolean)
        && snapshot.get("cycle_running").is_some_and(Value::is_boolean)
        && snapshot.get("slaves").is_some_and(Value::is_array)
        && snapshot
            .get("last_error")
            .is_some_and(|value| value.is_null() || value.is_string());
    if !complete {
        return Err(bridge_error(
            "PROTOCOL",
            "Master 快照字段不完整或类型无效".into(),
            None,
            false,
        ));
    }
    snapshot.insert("host_generation".into(), json!(generation));
    Ok(Value::Object(snapshot))
}

fn decode_bridge_response(message: &Value, generation: u64) -> PendingResult {
    if message.get("ok").and_then(Value::as_bool) == Some(true) {
        let session_id = message
            .get("session_id")
            .and_then(Value::as_u64)
            .ok_or_else(|| {
                bridge_error(
                    "PROTOCOL",
                    "桥接响应缺少有效 session_id".into(),
                    None,
                    false,
                )
            })?;
        let snapshot = snapshot_with_generation(
            message.get("snapshot").unwrap_or(&Value::Null),
            session_id,
            generation,
        )?;
        Ok(json!({
            "result": message.get("result").cloned().unwrap_or(Value::Null),
            "host_generation": generation,
            "session_id": session_id,
            "snapshot": snapshot,
        }))
    } else {
        let mut error = message
            .get("error")
            .cloned()
            .unwrap_or_else(|| bridge_error("PROTOCOL", "未知桥接错误".into(), None, false));
        if let Some(object) = error.as_object_mut() {
            object.insert("host_generation".into(), json!(generation));
            if let Some(session_id) = object.get("session_id").and_then(Value::as_u64) {
                match snapshot_with_generation(
                    object.get("snapshot").unwrap_or(&Value::Null),
                    session_id,
                    generation,
                ) {
                    Ok(snapshot) => {
                        object.insert("snapshot".into(), snapshot);
                    }
                    Err(protocol_error) => return Err(protocol_error),
                }
            }
        }
        Err(error)
    }
}

#[derive(Clone, Debug)]
struct BridgeFault {
    generation: u64,
    reason: String,
}

fn generation_is_current(current: &AtomicU64, observed: u64) -> bool {
    current.load(Ordering::Acquire) == observed
}

fn activate_next_generation(next: &AtomicU64, current: &AtomicU64) -> u64 {
    let generation = next.fetch_add(1, Ordering::AcqRel);
    current.store(generation, Ordering::Release);
    generation
}

#[cfg(windows)]
struct SingleInstanceGuard(usize);

#[cfg(windows)]
impl Drop for SingleInstanceGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(windows)]
fn acquire_single_instance() -> Result<Option<SingleInstanceGuard>, String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
    use windows_sys::Win32::System::Threading::CreateMutexW;

    let name: Vec<u16> = "Local\\BenchCAT.com.benchcat.app"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        return Err(format!(
            "无法创建单实例互斥锁：{}",
            std::io::Error::last_os_error()
        ));
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        unsafe { CloseHandle(handle) };
        return Ok(None);
    }
    Ok(Some(SingleInstanceGuard(handle as usize)))
}

#[cfg(windows)]
fn bring_existing_instance_to_front() -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        FindWindowW, IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE,
    };

    let title: Vec<u16> = "BenchCAT"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let window = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
    if window.is_null() {
        return false;
    }
    if unsafe { IsIconic(window) } != 0 {
        unsafe { ShowWindow(window, SW_RESTORE) };
    }
    unsafe { SetForegroundWindow(window) };
    true
}

#[cfg(not(windows))]
fn bring_existing_instance_to_front() -> bool {
    false
}

#[cfg(not(windows))]
struct SingleInstanceGuard;

#[cfg(not(windows))]
fn acquire_single_instance() -> Result<Option<SingleInstanceGuard>, String> {
    Ok(Some(SingleInstanceGuard))
}

fn acquire_single_instance_or_activate() -> Result<Option<SingleInstanceGuard>, String> {
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        match acquire_single_instance()? {
            Some(guard) => return Ok(Some(guard)),
            None if bring_existing_instance_to_front() => return Ok(None),
            None if Instant::now() >= deadline => {
                return Err("旧实例仍在退出且未能释放单实例锁，请稍后重试".into())
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    }
}

#[cfg(windows)]
fn show_startup_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let title: Vec<u16> = "BenchCAT"
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect();
    let message: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            message.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        )
    };
}

#[cfg(not(windows))]
fn show_startup_error(message: &str) {
    eprintln!("{message}");
}

fn bridge_process_command(_app: &tauri::AppHandle) -> Result<Command, String> {
    if let Some(executable) = std::env::var_os("BENCHCAT_BRIDGE_EXECUTABLE") {
        let executable = PathBuf::from(executable);
        if !executable.is_file() {
            return Err(format!("指定的通信核心不存在：{}", executable.display()));
        }
        return Ok(Command::new(executable));
    }

    #[cfg(debug_assertions)]
    {
        let python = std::env::var("BENCHCAT_PYTHON").unwrap_or_else(|_| "python".into());
        let mut command = Command::new(python);
        let mut paths = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src")];
        if let Some(existing) = std::env::var_os("PYTHONPATH") {
            paths.extend(std::env::split_paths(&existing));
        }
        let python_path = std::env::join_paths(paths).map_err(|error| error.to_string())?;
        command
            .env("PYTHONPATH", python_path)
            .args(["-u", "-m", "ethercat_debug_tool.bridge"]);
        return Ok(command);
    }

    #[cfg(not(debug_assertions))]
    {
        let executable = _app
            .path()
            .resolve(
                "bridge/benchcat-bridge.exe",
                tauri::path::BaseDirectory::Resource,
            )
            .map_err(|error| format!("无法定位随包通信核心：{error}"))?;
        if !executable.is_file() {
            return Err(format!(
                "安装不完整：缺少通信核心 {}。请重新安装完整安装包",
                executable.display()
            ));
        }
        Ok(Command::new(executable))
    }
}

fn terminate_and_reap(child: &Arc<Mutex<Child>>) {
    if let Ok(mut process) = child.lock() {
        if process.try_wait().ok().flatten().is_none() {
            let _ = process.kill();
        }
        let _ = process.wait();
    }
}

#[cfg(windows)]
struct JobHandle(usize);

#[cfg(windows)]
impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(windows)]
fn assign_kill_on_close_job(child: &Child) -> Result<JobHandle, String> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!(
            "无法创建桥接进程 Job Object：{}",
            std::io::Error::last_os_error()
        ));
    }
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    let assigned = configured != 0
        && unsafe { AssignProcessToJobObject(job, child.as_raw_handle() as _) } != 0;
    if !assigned {
        let error = std::io::Error::last_os_error();
        unsafe { CloseHandle(job) };
        return Err(format!("无法监管 Python 桥接子进程：{error}"));
    }
    Ok(JobHandle(job as usize))
}

#[cfg(test)]
fn read_frame(reader: &mut File, max: usize) -> std::io::Result<Value> {
    let mut raw = [0_u8; 4];
    reader.read_exact(&mut raw)?;
    let size = u32::from_le_bytes(raw) as usize;
    if size > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bridge frame too large",
        ));
    }
    let mut payload = vec![0; size];
    reader.read_exact(&mut payload)?;
    serde_json::from_slice(&payload).map_err(std::io::Error::other)
}

fn encode_frame(value: &Value, max: usize) -> std::io::Result<Vec<u8>> {
    let payload = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    if payload.len() > max {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "bridge frame too large",
        ));
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}

fn write_encoded_frame(writer: &mut File, frame: &[u8]) -> std::io::Result<()> {
    writer.write_all(frame)?;
    writer.flush()
}

#[cfg(test)]
fn write_frame(writer: &mut File, value: &Value, max: usize) -> std::io::Result<()> {
    write_encoded_frame(writer, &encode_frame(value, max)?)
}

#[cfg(windows)]
fn pipe_available(pipe: &File) -> std::io::Result<usize> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::System::Pipes::PeekNamedPipe;

    let mut available = 0_u32;
    let succeeded = unsafe {
        PeekNamedPipe(
            pipe.as_raw_handle() as _,
            std::ptr::null_mut(),
            0,
            std::ptr::null_mut(),
            &mut available,
            std::ptr::null_mut(),
        )
    };
    if succeeded == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(available as usize)
    }
}

#[cfg(not(windows))]
fn pipe_available(_pipe: &File) -> std::io::Result<usize> {
    Ok(65_536)
}

struct IncrementalFrameReader {
    buffer: Vec<u8>,
    frames: VecDeque<Value>,
    max: usize,
}

impl IncrementalFrameReader {
    fn new(max: usize) -> Self {
        Self {
            buffer: Vec::new(),
            frames: VecDeque::new(),
            max,
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> std::io::Result<()> {
        self.buffer.extend_from_slice(bytes);
        loop {
            if self.buffer.len() < 4 {
                return Ok(());
            }
            let size = u32::from_le_bytes(self.buffer[..4].try_into().unwrap()) as usize;
            if size > self.max {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "bridge frame too large",
                ));
            }
            let frame_size = 4 + size;
            if self.buffer.len() < frame_size {
                return Ok(());
            }
            let value = serde_json::from_slice(&self.buffer[4..frame_size])
                .map_err(std::io::Error::other)?;
            self.buffer.drain(..frame_size);
            self.frames.push_back(value);
        }
    }

    fn read_next(&mut self, reader: &mut File) -> std::io::Result<Value> {
        if let Some(frame) = self.frames.pop_front() {
            return Ok(frame);
        }
        loop {
            let available = match pipe_available(reader) {
                Ok(available) => available,
                Err(error) if !self.buffer.is_empty() => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        format!("bridge closed with a truncated frame: {error}"),
                    ));
                }
                Err(error) => return Err(error),
            };
            if available == 0 {
                std::thread::sleep(Duration::from_millis(5));
                continue;
            }
            let mut chunk = vec![0_u8; available.min(65_536)];
            let count = reader.read(&mut chunk)?;
            if count == 0 {
                return Err(std::io::Error::new(
                    if self.buffer.is_empty() {
                        std::io::ErrorKind::BrokenPipe
                    } else {
                        std::io::ErrorKind::UnexpectedEof
                    },
                    "bridge pipe closed while reading a frame",
                ));
            }
            self.feed(&chunk[..count])?;
            if let Some(frame) = self.frames.pop_front() {
                return Ok(frame);
            }
        }
    }
}

fn spawn_log_reader<R: Read + Send + 'static>(
    source: R,
    label: &'static str,
    tail: Arc<Mutex<VecDeque<String>>>,
    path: Option<PathBuf>,
    app: tauri::AppHandle,
    generation: u64,
    generation_gate: Arc<AtomicU64>,
) {
    std::thread::spawn(move || {
        for line in BufReader::new(source).lines().map_while(Result::ok) {
            if label == "stderr" {
                if let Ok(mut lines) = tail.lock() {
                    if lines.len() == 40 {
                        lines.pop_front();
                    }
                    lines.push_back(line.clone());
                }
            }
            if let Some(path) = &path {
                append_log(path, &format!("{label}: {line}"));
            }
            if generation_is_current(&generation_gate, generation) {
                let _ = app.emit("bridge-log", format!("{label}: {line}"));
            }
        }
    });
}

#[cfg(windows)]
#[derive(Clone, Copy)]
enum PipeDirection {
    HostWrites,
    HostReads,
}

#[cfg(windows)]
fn create_pipe(
    name: &str,
    direction: PipeDirection,
) -> Result<windows_sys::Win32::Foundation::HANDLE, String> {
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_INBOUND, PIPE_ACCESS_OUTBOUND,
    };
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_READMODE_BYTE, PIPE_TYPE_BYTE, PIPE_WAIT,
    };
    let wide: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
    let handle = unsafe {
        CreateNamedPipeW(
            wide.as_ptr(),
            match direction {
                PipeDirection::HostWrites => PIPE_ACCESS_OUTBOUND,
                PipeDirection::HostReads => PIPE_ACCESS_INBOUND,
            } | FILE_FLAG_FIRST_PIPE_INSTANCE,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
            1,
            65_536,
            65_536,
            0,
            std::ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        Err(format!(
            "无法创建桥接 Named Pipe：{}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(handle)
    }
}

enum WriterCommand {
    Frame(Vec<u8>),
    Stop,
}

struct PendingRequest {
    sender: mpsc::SyncSender<PendingResult>,
    method: String,
    mutating: bool,
}

struct Bridge {
    generation: u64,
    child: Arc<Mutex<Child>>,
    request_tx: mpsc::SyncSender<WriterCommand>,
    pending: Arc<Mutex<HashMap<u64, PendingRequest>>>,
    lifecycle: Arc<Mutex<Lifecycle>>,
    last_request: Arc<Mutex<Option<(u64, String, bool)>>>,
    registry: Registry,
    next_id: AtomicU64,
    #[cfg(windows)]
    _job: JobHandle,
}

impl Bridge {
    fn spawn(
        app: tauri::AppHandle,
        generation: u64,
        fault_tx: mpsc::Sender<BridgeFault>,
        generation_gate: Arc<AtomicU64>,
    ) -> Result<Arc<Self>, String> {
        let registry: Registry =
            serde_json::from_str(COMMAND_REGISTRY).map_err(|e| format!("命令注册表无效：{e}"))?;
        #[cfg(not(windows))]
        {
            let _ = app;
            Err("Named Pipe transport requires Windows".into())
        }
        #[cfg(windows)]
        {
            use std::os::windows::io::FromRawHandle;
            use windows_sys::Win32::Foundation::{
                CloseHandle, GetLastError, ERROR_PIPE_CONNECTED, HANDLE,
            };
            use windows_sys::Win32::System::Pipes::ConnectNamedPipe;
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let request_pipe_name = format!(
                r"\\.\pipe\benchcat-request-{}-{nonce}",
                std::process::id()
            );
            let response_pipe_name = format!(
                r"\\.\pipe\benchcat-response-{}-{nonce}",
                std::process::id()
            );
            let mut command = bridge_process_command(&app)?;
            let request_handle = create_pipe(&request_pipe_name, PipeDirection::HostWrites)?;
            let response_handle = match create_pipe(&response_pipe_name, PipeDirection::HostReads) {
                Ok(handle) => handle,
                Err(error) => {
                    unsafe { CloseHandle(request_handle) };
                    return Err(error);
                }
            };
            command
                .env("BENCHCAT_REQUEST_PIPE", &request_pipe_name)
                .env("BENCHCAT_RESPONSE_PIPE", &response_pipe_name)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(error) => {
                    unsafe {
                        CloseHandle(request_handle);
                        CloseHandle(response_handle);
                    }
                    return Err(format!("无法启动 Python EtherCAT 桥接进程：{error}"));
                }
            };
            let job = match assign_kill_on_close_job(&child) {
                Ok(job) => job,
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    unsafe {
                        CloseHandle(request_handle);
                        CloseHandle(response_handle);
                    }
                    return Err(error);
                }
            };
            let Some(stdout) = child.stdout.take() else {
                let _ = child.kill();
                let _ = child.wait();
                unsafe {
                    CloseHandle(request_handle);
                    CloseHandle(response_handle);
                }
                return Err("无法读取桥接 stdout 日志".into());
            };
            let Some(mut stderr) = child.stderr.take() else {
                let _ = child.kill();
                let _ = child.wait();
                unsafe {
                    CloseHandle(request_handle);
                    CloseHandle(response_handle);
                }
                return Err("无法读取桥接 stderr 日志".into());
            };
            let (connect_tx, connect_rx) = mpsc::sync_channel(2);
            for raw_handle in [request_handle as usize, response_handle as usize] {
                let connect_tx = connect_tx.clone();
                std::thread::spawn(move || {
                    let handle = raw_handle as HANDLE;
                    let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
                    let result =
                        connected != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
                    let _ = connect_tx.send(result);
                });
            }
            drop(connect_tx);
            let connect_deadline = Instant::now() + Duration::from_secs(10);
            let mut connected_count = 0;
            let mut connect_error = None;
            while connected_count < 2 && Instant::now() < connect_deadline {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let mut detail = String::new();
                        let _ = stderr.read_to_string(&mut detail);
                        let detail = detail.trim();
                        connect_error = Some(if detail.is_empty() {
                            format!("通信核心在连接 Named Pipe 前已退出（{status}）")
                        } else {
                            format!("通信核心在连接 Named Pipe 前已退出（{status}）：{detail}")
                        });
                        break;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        connect_error = Some(format!("无法检查通信核心启动状态：{error}"));
                        break;
                    }
                }
                let remaining = connect_deadline.saturating_duration_since(Instant::now());
                match connect_rx.recv_timeout(remaining.min(Duration::from_millis(50))) {
                    Ok(true) => connected_count += 1,
                    Ok(false) => {
                        connect_error = Some("通信核心连接 Named Pipe 失败".into());
                        break;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        connect_error = Some("通信核心 Named Pipe 连接线程意外结束".into());
                        break;
                    }
                }
            }
            if connected_count != 2 {
                if child.try_wait().ok().flatten().is_none() {
                    let _ = child.kill();
                }
                let _ = child.wait();
                unsafe {
                    CloseHandle(request_handle);
                    CloseHandle(response_handle);
                }
                return Err(connect_error
                    .unwrap_or_else(|| "通信核心未在 10 秒内连接两条 Named Pipe".into()));
            }
            let request_pipe = unsafe { File::from_raw_handle(request_handle as _) };
            let response_pipe = unsafe { File::from_raw_handle(response_handle as _) };
            let child = Arc::new(Mutex::new(child));
            let pending: Arc<Mutex<HashMap<u64, PendingRequest>>> =
                Arc::new(Mutex::new(HashMap::new()));
            let lifecycle = Arc::new(Mutex::new(Lifecycle::Starting));
            let last_request: Arc<Mutex<Option<(u64, String, bool)>>> = Arc::new(Mutex::new(None));
            let stderr_tail = Arc::new(Mutex::new(VecDeque::<String>::with_capacity(40)));
            let log_path = app.path().app_log_dir().ok().map(|dir| {
                let _ = fs::create_dir_all(&dir);
                dir.join("python-bridge.log")
            });

            let (request_tx, request_rx) = mpsc::sync_channel::<WriterCommand>(64);
            let writer_fault_tx = fault_tx.clone();
            std::thread::spawn(move || {
                let mut writer = request_pipe;
                while let Ok(command) = request_rx.recv() {
                    match command {
                        WriterCommand::Frame(frame) => {
                            if let Err(error) = write_encoded_frame(&mut writer, &frame) {
                                let _ = writer_fault_tx.send(BridgeFault {
                                    generation,
                                    reason: format!("Named Pipe 请求写入失败：{error}"),
                                });
                                break;
                            }
                        }
                        WriterCommand::Stop => break,
                    }
                }
            });

            let rp = Arc::clone(&pending);
            let rl = Arc::clone(&lifecycle);
            let rr = Arc::clone(&last_request);
            let rc = Arc::clone(&child);
            let rt = Arc::clone(&stderr_tail);
            let ra = app.clone();
            let rlog = log_path.clone();
            let max = registry.limits.max_frame_bytes;
            let reader_fault_tx = fault_tx.clone();
            let reader_generation_gate = Arc::clone(&generation_gate);
            std::thread::spawn(move || {
                let mut reader = response_pipe;
                let mut frame_reader = IncrementalFrameReader::new(max);
                let reason = loop {
                    match frame_reader.read_next(&mut reader) {
                        Ok(msg) => match msg.get("type").and_then(Value::as_str) {
                            Some("accepted") => {
                                if let Ok(mut s) = rl.lock() {
                                    *s = Lifecycle::Busy
                                }
                            }
                            Some("response") => {
                                let id = msg.get("id").and_then(Value::as_u64).unwrap_or(0);
                                let (tx, still_busy) = rp
                                    .lock()
                                    .map(|mut p| {
                                        let request = p.remove(&id);
                                        (request, !p.is_empty())
                                    })
                                    .unwrap_or((None, false));
                                if let Some(pending_request) = tx {
                                    let result = decode_bridge_response(&msg, generation);
                                    let protocol_fault = result
                                        .as_ref()
                                        .err()
                                        .filter(|error| {
                                            error.get("code").and_then(Value::as_str)
                                                == Some("PROTOCOL")
                                        })
                                        .and_then(|error| error.get("message"))
                                        .and_then(Value::as_str)
                                        .map(str::to_owned);
                                    let _ = pending_request.sender.send(result);
                                    if let Some(reason) = protocol_fault {
                                        let _ = reader_fault_tx
                                            .send(BridgeFault { generation, reason });
                                    }
                                }
                                if let Ok(mut s) = rl.lock() {
                                    if *s != Lifecycle::Stalled {
                                        *s = if still_busy {
                                            Lifecycle::Busy
                                        } else {
                                            Lifecycle::Ready
                                        }
                                    }
                                }
                            }
                            Some("event") => {
                                let mut payload =
                                    msg.get("payload").cloned().unwrap_or(Value::Null);
                                if let Some(object) = payload.as_object_mut() {
                                    object.insert("host_generation".into(), json!(generation));
                                    if object.get("kind").and_then(Value::as_str)
                                        == Some("bus_snapshot")
                                    {
                                        if let Some(snapshot) =
                                            object.get_mut("data").and_then(Value::as_object_mut)
                                        {
                                            snapshot.insert(
                                                "host_generation".into(),
                                                json!(generation),
                                            );
                                        }
                                    }
                                }
                                let kind = payload.get("kind").and_then(Value::as_str);
                                // Heartbeat is telemetry only. It cannot prove that
                                // the native-call Worker is making progress.
                                if kind == Some("ready") {
                                    if let Ok(mut s) = rl.lock() {
                                        if *s == Lifecycle::Starting {
                                            *s = Lifecycle::Ready
                                        }
                                    }
                                }
                                if kind == Some("worker_stalled") {
                                    if let Ok(mut s) = rl.lock() {
                                        *s = Lifecycle::Stalled
                                    }
                                    let reason = payload
                                        .get("data")
                                        .and_then(|data| data.get("reason"))
                                        .and_then(Value::as_str)
                                        .filter(|value| !value.is_empty())
                                        .unwrap_or("Python Worker 报告不可取消的原生调用超时")
                                        .to_owned();
                                    let _ =
                                        reader_fault_tx.send(BridgeFault { generation, reason });
                                }
                                if generation_is_current(&reader_generation_gate, generation) {
                                    let _ = ra.emit("bridge-event", payload);
                                }
                            }
                            _ if generation_is_current(&reader_generation_gate, generation) => {
                                let _ = ra.emit("bridge-log", msg);
                            }
                            _ => {}
                        },
                        Err(e) => break format!("Named Pipe 读取失败：{e}"),
                    }
                };
                if let Ok(mut s) = rl.lock() {
                    *s = Lifecycle::Exited
                }
                let code = rc
                    .lock()
                    .ok()
                    .and_then(|mut c| c.try_wait().ok().flatten())
                    .and_then(|s| s.code());
                let last = rr.lock().ok().and_then(|v| v.clone());
                let tail = rt
                    .lock()
                    .map(|v| v.iter().cloned().collect::<Vec<_>>().join("\n"))
                    .unwrap_or_default();
                let message = code.map_or_else(
                    || format!("Python EtherCAT 通信核心已断开：{reason}"),
                    |c| format!("Python EtherCAT 通信核心已退出（退出码 {c}）"),
                );
                if let Some(path) = &rlog {
                    append_log(path, &format!("BRIDGE EXIT: {message}; last={last:?}"))
                }
                if let Ok(mut p) = rp.lock() {
                    for (_, request) in p.drain() {
                        let _ = request.sender.send(Err(bridge_error(
                            "PROCESS_EXITED",
                            message.clone(),
                            Some(&request.method),
                            request.mutating,
                        )));
                    }
                }
                if generation_is_current(&reader_generation_gate, generation) {
                    let _=ra.emit("bridge-exited",json!({"message":message,"reason":reason,"exit_code":code,"stderr_tail":tail,"log_path":rlog.map(|p|p.display().to_string()),"last_request_id":last.as_ref().map(|v|v.0),"last_method":last.as_ref().map(|v|v.1.clone()),"host_generation":generation}));
                }
                let _ = reader_fault_tx.send(BridgeFault {
                    generation,
                    reason: message,
                });
            });
            spawn_log_reader(
                stdout,
                "stdout",
                Arc::clone(&stderr_tail),
                log_path.clone(),
                app.clone(),
                generation,
                Arc::clone(&generation_gate),
            );
            spawn_log_reader(
                stderr,
                "stderr",
                Arc::clone(&stderr_tail),
                log_path.clone(),
                app.clone(),
                generation,
                Arc::clone(&generation_gate),
            );
            Ok(Arc::new(Self {
                generation,
                child,
                request_tx,
                pending,
                lifecycle,
                last_request,
                registry,
                next_id: AtomicU64::new(1),
                _job: job,
            }))
        }
    }

    fn request(&self, method: String, params: Value, session_id: Option<u64>) -> PendingResult {
        self.request_with_deadline(method, params, session_id, None, 2_000)
    }

    fn request_with_deadline(
        &self,
        method: String,
        params: Value,
        session_id: Option<u64>,
        timeout_override_ms: Option<u64>,
        host_grace_ms: u64,
    ) -> PendingResult {
        let (registered_timeout_ms, mutating) = self
            .registry
            .commands
            .get(&method)
            .map(|spec| (spec.timeout_ms, spec.mutating))
            .ok_or_else(|| {
                bridge_error(
                    "VALIDATION",
                    format!("未注册命令：{method}"),
                    Some(&method),
                    false,
                )
            })?;
        let timeout_ms = timeout_override_ms.unwrap_or(registered_timeout_ms);
        let created_at_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let deadline_at_ms = created_at_ms.saturating_add(timeout_ms);
        let state = self
            .lifecycle
            .lock()
            .map(|v| *v)
            .unwrap_or(Lifecycle::Exited);
        if matches!(
            state,
            Lifecycle::Exited | Lifecycle::Stopping | Lifecycle::Stalled
        ) {
            return Err(bridge_error(
                "BRIDGE_UNAVAILABLE",
                format!("通信核心状态：{}", state.label()),
                Some(&method),
                mutating,
            ));
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::sync_channel(1);
        let request = json!({"protocol":self.registry.protocol_version,"type":"request","id":id,"method":method,"params":params,"deadline_ms":timeout_ms,"deadline_at_ms":deadline_at_ms,"session_id":session_id});
        let frame =
            encode_frame(&request, self.registry.limits.max_frame_bytes).map_err(|error| {
                bridge_error(
                    "TRANSPORT_WRITE",
                    format!("无法编码桥接请求：{error}"),
                    Some(&method),
                    mutating,
                )
            })?;
        self.pending
            .lock()
            .map_err(|_| bridge_error("INTERNAL", "请求表损坏".into(), Some(&method), mutating))?
            .insert(
                id,
                PendingRequest {
                    sender: tx,
                    method: method.clone(),
                    mutating,
                },
            );
        if let Ok(mut last) = self.last_request.lock() {
            *last = Some((id, method.clone(), mutating))
        }
        if let Err(error) = self.request_tx.try_send(WriterCommand::Frame(frame)) {
            if let Ok(mut p) = self.pending.lock() {
                p.remove(&id);
            }
            self.force_terminate("桥接请求无法进入发送队列");
            return Err(bridge_error(
                "REQUEST_QUEUE",
                format!("桥接请求无法进入发送队列：{error}"),
                Some(&method),
                mutating,
            ));
        }
        let host_deadline_ms = deadline_at_ms.saturating_add(host_grace_ms);
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        match rx.recv_timeout(Duration::from_millis(
            host_deadline_ms.saturating_sub(now_ms),
        )) {
            Ok(v) => v,
            Err(e) => {
                if let Ok(mut p) = self.pending.lock() {
                    p.remove(&id);
                }
                self.force_terminate(&format!("命令 {method} 超过 Host deadline"));
                Err(bridge_error(
                    "HOST_TIMEOUT",
                    format!("桥接请求超时：{e}"),
                    Some(&method),
                    mutating,
                ))
            }
        }
    }

    fn force_terminate(&self, reason: &str) {
        if let Ok(mut state) = self.lifecycle.lock() {
            if !matches!(*state, Lifecycle::Exited | Lifecycle::Stopping) {
                *state = Lifecycle::Stalled;
            }
        }
        if let Ok(mut pending) = self.pending.lock() {
            for (_, request) in pending.drain() {
                let _ = request.sender.send(Err(bridge_error(
                    "PROCESS_TERMINATED",
                    reason.to_owned(),
                    Some(&request.method),
                    request.mutating,
                )));
            }
        }
        terminate_and_reap(&self.child);
        let _ = self.request_tx.try_send(WriterCommand::Stop);
    }

    fn shutdown(&self) {
        let state = self
            .lifecycle
            .lock()
            .map(|v| *v)
            .unwrap_or(Lifecycle::Exited);
        if !matches!(state, Lifecycle::Exited | Lifecycle::Stalled) {
            let _ = self.request_with_deadline(
                "shutdown".into(),
                Value::Object(Default::default()),
                None,
                Some(2_000),
                0,
            );
        }
        if let Ok(mut s) = self.lifecycle.lock() {
            *s = Lifecycle::Stopping
        }
        for _ in 0..100 {
            if self
                .child
                .lock()
                .ok()
                .and_then(|mut c| c.try_wait().ok().flatten())
                .is_some()
            {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        self.force_terminate("应用退出时通信核心未能安全停止");
    }
}

struct BridgeSupervisor {
    app: tauri::AppHandle,
    current: Mutex<Option<Arc<Bridge>>>,
    next_generation: AtomicU64,
    current_generation: Arc<AtomicU64>,
    fault_tx: mpsc::Sender<BridgeFault>,
    restart_lock: Mutex<()>,
    last_spawn_error: Mutex<Option<String>>,
    stopped: AtomicBool,
}

impl BridgeSupervisor {
    fn new(app: tauri::AppHandle) -> Arc<Self> {
        let (fault_tx, fault_rx) = mpsc::channel();
        // Generation zero means no Python process has been admitted yet.  In
        // particular, constructing the Tauri application never waits for
        // Python, Npcap, or a Named Pipe handshake.
        let current_generation = Arc::new(AtomicU64::new(0));
        let supervisor = Arc::new(Self {
            app,
            current: Mutex::new(None),
            next_generation: AtomicU64::new(1),
            current_generation,
            fault_tx,
            restart_lock: Mutex::new(()),
            last_spawn_error: Mutex::new(None),
            stopped: AtomicBool::new(false),
        });
        let weak: Weak<Self> = Arc::downgrade(&supervisor);
        std::thread::spawn(move || loop {
            let Some(supervisor) = weak.upgrade() else {
                break;
            };
            if supervisor.stopped.load(Ordering::Acquire) {
                break;
            }
            supervisor.ensure_bridge("通信核心后台启动/重试");
            match fault_rx.recv_timeout(Duration::from_secs(2)) {
                Ok(fault) => {
                    supervisor.restart_generation(fault.generation, &fault.reason);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        });
        supervisor
    }

    fn bridge(&self) -> Option<Arc<Bridge>> {
        self.current
            .lock()
            .ok()
            .and_then(|bridge| bridge.as_ref().map(Arc::clone))
    }

    fn ensure_bridge(&self, reason: &str) {
        if self.stopped.load(Ordering::Acquire) || self.bridge().is_some() {
            return;
        }
        self.spawn_replacement(None, reason);
    }

    fn restart_generation(&self, failed_generation: u64, reason: &str) {
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        let Some(old) = self.bridge() else {
            return;
        };
        if old.generation != failed_generation {
            return;
        }
        self.spawn_replacement(Some(old), reason);
    }

    fn spawn_replacement(&self, old: Option<Arc<Bridge>>, reason: &str) {
        let Ok(_restart) = self.restart_lock.lock() else {
            return;
        };
        if self.stopped.load(Ordering::Acquire) {
            return;
        }
        let previous_generation = old.as_ref().map(|bridge| bridge.generation);
        if let Some(expected) = previous_generation {
            if self.bridge().as_ref().map(|bridge| bridge.generation) != Some(expected) {
                return;
            }
        } else if self.bridge().is_some() {
            return;
        }
        // This wait is the single-Master invariant: a replacement is never
        // spawned until the previous process has been terminated and reaped.
        if let Some(old) = old {
            old.force_terminate(reason);
            if let Ok(mut current) = self.current.lock() {
                if current.as_ref().map(|bridge| bridge.generation) == Some(old.generation) {
                    *current = None;
                }
            }
        }
        let generation = activate_next_generation(&self.next_generation, &self.current_generation);
        match Bridge::spawn(
            self.app.clone(),
            generation,
            self.fault_tx.clone(),
            Arc::clone(&self.current_generation),
        ) {
            Ok(replacement) => {
                if self.stopped.load(Ordering::Acquire) {
                    replacement.force_terminate("应用已退出，放弃后台启动的通信核心");
                    return;
                }
                *self
                    .current
                    .lock()
                    .expect("bridge supervisor lock poisoned") = Some(replacement);
                if let Ok(mut last_error) = self.last_spawn_error.lock() {
                    *last_error = None;
                }
                let _ = self.app.emit(
                    "bridge-restarted",
                    json!({
                        "previous_generation": previous_generation,
                        "host_generation": generation,
                        "reason": reason,
                    }),
                );
            }
            Err(error) => {
                if let Ok(mut last_error) = self.last_spawn_error.lock() {
                    *last_error = Some(error.clone());
                }
                if let Ok(log_dir) = self.app.path().app_log_dir() {
                    let _ = fs::create_dir_all(&log_dir);
                    append_log(
                        &log_dir.join("python-bridge.log"),
                        &format!("BRIDGE START FAILED: {error}"),
                    );
                }
                let _ = self.app.emit(
                    "bridge-restart-failed",
                    json!({
                        "previous_generation": previous_generation,
                        "host_generation": generation,
                        "reason": reason,
                        "message": error,
                    }),
                );
            }
        }
    }

    fn request(&self, method: String, params: Value, session_id: Option<u64>) -> PendingResult {
        let Some(bridge) = self.bridge() else {
            let message = self
                .last_spawn_error
                .lock()
                .ok()
                .and_then(|error| error.clone())
                .map(|error| format!("通信核心启动失败：{error}"))
                .unwrap_or_else(|| "通信核心正在后台启动；界面仍可使用，请稍后重试".into());
            return Err(bridge_error(
                "BRIDGE_STARTING",
                message,
                Some(&method),
                false,
            ));
        };
        let unavailable = bridge
            .lifecycle
            .lock()
            .map(|state| matches!(*state, Lifecycle::Exited | Lifecycle::Stalled))
            .unwrap_or(true);
        if unavailable {
            let _ = self.fault_tx.send(BridgeFault {
                generation: bridge.generation,
                reason: "请求到达时旧通信核心不可用".into(),
            });
            return Err(bridge_error(
                "BRIDGE_UNAVAILABLE",
                "通信核心不可用，监督器正在后台重建".into(),
                Some(&method),
                false,
            ));
        }
        let result = bridge.request(method.clone(), params, session_id);
        let timed_out = result
            .as_ref()
            .err()
            .and_then(|error| error.get("code"))
            .and_then(Value::as_str)
            == Some("HOST_TIMEOUT");
        if timed_out {
            // Bridge::request has already terminated and reaped the process.
            // Its pipe reader reports BridgeFault to the supervisor thread,
            // allowing this caller to receive the terminal timeout without
            // waiting for the replacement process handshake.
            return result;
        }
        if result.is_ok()
            && self.bridge().as_ref().map(|current| current.generation) != Some(bridge.generation)
        {
            let mutating = bridge
                .registry
                .commands
                .get(&method)
                .is_some_and(|spec| spec.mutating);
            return Err(bridge_error(
                "GENERATION_SUPERSEDED",
                "旧通信核心的迟到结果已丢弃".into(),
                Some(&method),
                mutating,
            ));
        }
        result
    }

    fn shutdown(&self) {
        if self.stopped.swap(true, Ordering::AcqRel) {
            return;
        }
        let Ok(_restart) = self.restart_lock.lock() else {
            return;
        };
        if let Some(bridge) = self.bridge() {
            bridge.shutdown();
        }
    }
}

struct BridgeState(Arc<BridgeSupervisor>);
#[tauri::command]
async fn bridge_request(
    state: State<'_, BridgeState>,
    method: String,
    params: Value,
    session_id: Option<u64>,
) -> Result<Value, Value> {
    let supervisor = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || supervisor.request(method, params, session_id))
        .await
        .map_err(|e| bridge_error("HOST_TASK", format!("桥接任务失败：{e}"), None, false))?
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(&path);
    if !target.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    let arg = if target.is_file() {
        format!("/select,{}", target.display())
    } else {
        target.display().to_string()
    };
    Command::new("explorer.exe")
        .arg(arg)
        .spawn()
        .map_err(|e| format!("无法打开资源管理器：{e}"))?;
    Ok(())
}
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    const ALLOWED: [&str; 2] = [
        "https://github.com/LINLin190/BenchCAT",
        "https://github.com/LINLin190/BenchCAT/issues",
    ];
    if !ALLOWED.contains(&url.as_str()) {
        return Err("不允许打开该外部链接".into());
    }
    Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(&url)
        .spawn()
        .map_err(|e| format!("无法打开外部链接：{e}"))?;
    Ok(())
}

fn preferred_window_size(work_width: f64, work_height: f64) -> tauri::LogicalSize<f64> {
    const PREFERRED_WIDTH: f64 = 1600.0;
    const PREFERRED_HEIGHT: f64 = 1200.0;
    const MIN_WIDTH: f64 = 960.0;
    const MIN_HEIGHT: f64 = 600.0;
    const EDGE_MARGIN: f64 = 32.0;

    let available_width = (work_width - EDGE_MARGIN).max(MIN_WIDTH).min(work_width);
    let available_height = (work_height - EDGE_MARGIN).max(MIN_HEIGHT).min(work_height);
    tauri::LogicalSize::new(
        PREFERRED_WIDTH.min(available_width),
        PREFERRED_HEIGHT.min(available_height),
    )
}

fn configure_main_window(app: &tauri::App) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    if let Some(monitor) = monitor {
        let scale_factor = monitor.scale_factor();
        let work_area = monitor.work_area();
        let logical_work_area = work_area.size.to_logical::<f64>(scale_factor);
        let size = preferred_window_size(logical_work_area.width, logical_work_area.height);
        let physical_size = size.to_physical::<u32>(scale_factor);
        let x = work_area.position.x
            + ((work_area.size.width.saturating_sub(physical_size.width)) / 2) as i32;
        let y = work_area.position.y
            + ((work_area.size.height.saturating_sub(physical_size.height)) / 2) as i32;
        let _ = window.set_min_size(Some(tauri::LogicalSize::new(
            960.0_f64.min(size.width),
            600.0_f64.min(size.height),
        )));
        let _ = window.set_size(size);
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = window.show();
}

fn main() {
    let _single_instance = match acquire_single_instance_or_activate() {
        Ok(Some(guard)) => guard,
        Ok(None) => {
            return;
        }
        Err(error) => {
            show_startup_error(&error);
            return;
        }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            configure_main_window(app);
            let supervisor = BridgeSupervisor::new(app.handle().clone());
            app.manage(BridgeState(supervisor));
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let app = window.app_handle().clone();
                let supervisor = window
                    .try_state::<BridgeState>()
                    .map(|state| Arc::clone(&state.0));
                std::thread::spawn(move || {
                    if let Some(supervisor) = supervisor {
                        supervisor.shutdown();
                    }
                    app.exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            bridge_request,
            reveal_path,
            open_external
        ])
        .build(tauri::generate_context!())
        .expect("failed to build BenchCAT")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app.try_state::<BridgeState>() {
                    state.0.shutdown();
                }
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_round_trip() {
        let path = std::env::temp_dir().join(format!("ec-frame-{}.bin", std::process::id()));
        let mut w = File::create(&path).unwrap();
        write_frame(&mut w, &json!({"type":"heartbeat"}), 1024).unwrap();
        drop(w);
        let mut r = File::open(&path).unwrap();
        assert_eq!(read_frame(&mut r, 1024).unwrap()["type"], "heartbeat");
        let _ = fs::remove_file(path);
    }

    #[test]
    fn preferred_window_size_uses_target_when_work_area_is_large_enough() {
        assert_eq!(
            preferred_window_size(2560.0, 1400.0),
            tauri::LogicalSize::new(1600.0, 1200.0)
        );
    }

    #[test]
    fn preferred_window_size_fits_a_smaller_work_area() {
        assert_eq!(
            preferred_window_size(1366.0, 728.0),
            tauri::LogicalSize::new(1334.0, 696.0)
        );
    }

    #[test]
    fn preferred_window_size_never_exceeds_a_tiny_work_area() {
        assert_eq!(
            preferred_window_size(800.0, 480.0),
            tauri::LogicalSize::new(800.0, 480.0)
        );
    }

    #[test]
    fn truncated_frame_is_a_transport_failure() {
        let path = std::env::temp_dir().join(format!("ec-truncated-{}.bin", std::process::id()));
        fs::write(&path, [10_u8, 0, 0, 0, b'{']).unwrap();
        let mut reader = File::open(&path).unwrap();
        assert_eq!(
            read_frame(&mut reader, 1024).unwrap_err().kind(),
            std::io::ErrorKind::UnexpectedEof
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn incremental_reader_waits_for_a_complete_frame_and_keeps_following_frames() {
        let first = encode_frame(&json!({"id": 1}), 1024).unwrap();
        let second = encode_frame(&json!({"id": 2}), 1024).unwrap();
        let mut reader = IncrementalFrameReader::new(1024);

        reader.feed(&first[..3]).unwrap();
        assert!(reader.frames.is_empty());
        reader.feed(&first[3..]).unwrap();
        reader.feed(&second).unwrap();

        assert_eq!(reader.frames.pop_front().unwrap()["id"], 1);
        assert_eq!(reader.frames.pop_front().unwrap()["id"], 2);
    }

    #[test]
    fn transport_exit_marks_only_writes_unknown() {
        let read = bridge_error(
            "PROCESS_EXITED",
            "lost".into(),
            Some("register_read"),
            false,
        );
        let write = bridge_error("PROCESS_EXITED", "lost".into(), Some("eeprom_flash"), true);
        assert_eq!(read["operation_result"], "failed");
        assert_eq!(write["operation_result"], "unknown");
    }

    #[test]
    fn successful_bridge_response_preserves_atomic_snapshot_envelope() {
        let message = json!({
            "type": "response",
            "ok": true,
            "result": {"connected": true},
            "session_id": 4,
            "snapshot": {
                "mode": "real",
                "phase": "adapter_open",
                "adapter": "npcap0",
                "connected": true,
                "cycle_running": false,
                "session_id": 4,
                "revision": 7,
                "slaves": [],
                "last_error": null
            }
        });

        let envelope = decode_bridge_response(&message, 9).unwrap();

        assert_eq!(envelope["result"]["connected"], true);
        assert_eq!(envelope["host_generation"], 9);
        assert_eq!(envelope["session_id"], 4);
        assert_eq!(envelope["snapshot"]["host_generation"], 9);
        assert_eq!(envelope["snapshot"]["revision"], 7);
    }

    #[test]
    fn bridge_response_rejects_a_mismatched_snapshot_session() {
        let message = json!({
            "type": "response",
            "ok": true,
            "result": {},
            "session_id": 4,
            "snapshot": {
                "mode": "real",
                "phase": "adapter_open",
                "adapter": "npcap0",
                "connected": true,
                "cycle_running": false,
                "slaves": [],
                "session_id": 3,
                "revision": 7,
                "last_error": null
            }
        });

        let error = decode_bridge_response(&message, 9).unwrap_err();

        assert_eq!(error["code"], "PROTOCOL");
        assert!(error["message"].as_str().unwrap().contains("不一致"));
    }

    #[test]
    fn mutating_deadline_timeout_remains_unknown() {
        let timeout = bridge_error(
            "HOST_TIMEOUT",
            "deadline".into(),
            Some("eeprom_flash"),
            true,
        );
        assert_eq!(timeout["operation_result"], "unknown");
    }

    #[test]
    fn generation_gate_suppresses_old_engine_events() {
        let generation = AtomicU64::new(4);
        assert!(generation_is_current(&generation, 4));
        generation.store(5, Ordering::Release);
        assert!(!generation_is_current(&generation, 4));
        assert!(generation_is_current(&generation, 5));
    }

    #[test]
    fn automatic_rebuild_activates_a_new_host_generation() {
        let next = AtomicU64::new(2);
        let current = AtomicU64::new(1);
        assert_eq!(activate_next_generation(&next, &current), 2);
        assert_eq!(current.load(Ordering::Acquire), 2);
        assert_eq!(next.load(Ordering::Acquire), 3);
        assert!(!generation_is_current(&current, 1));
    }

    #[test]
    fn deadline_termination_prevents_late_child_side_effect() {
        let sentinel = std::env::temp_dir().join(format!("ec-late-{}.txt", std::process::id()));
        let _ = fs::remove_file(&sentinel);
        let child = Command::new("python")
            .args([
                "-c",
                "import os,pathlib,time;time.sleep(.4);pathlib.Path(os.environ['SENTINEL']).write_text('late')",
            ])
            .env("SENTINEL", &sentinel)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let child = Arc::new(Mutex::new(child));
        terminate_and_reap(&child);
        std::thread::sleep(Duration::from_millis(500));
        assert!(
            !sentinel.exists(),
            "terminated generation performed a late side effect"
        );
    }

    #[cfg(windows)]
    #[test]
    fn closing_job_object_terminates_owned_python_child() {
        let mut child = Command::new("python")
            .args(["-c", "import time; time.sleep(30)"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let job = assign_kill_on_close_job(&child).unwrap();
        drop(job);
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline && child.try_wait().unwrap().is_none() {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(child.try_wait().unwrap().is_some());
    }

    #[cfg(windows)]
    #[test]
    fn python_and_rust_exchange_a_named_pipe_frame() {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_PIPE_CONNECTED};
        use windows_sys::Win32::System::Pipes::ConnectNamedPipe;

        let name = format!(r"\\.\pipe\ec-frame-test-{}", std::process::id());
        let handle = create_pipe(&name, PipeDirection::HostReads).unwrap();
        let script = "import json,os,struct; p=open(os.environ['PIPE'],'wb',buffering=0); b=json.dumps({'type':'heartbeat'}).encode(); p.write(struct.pack('<I',len(b))+b); p.close()";
        let mut child = Command::new("python")
            .args(["-c", script])
            .env("PIPE", &name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let connected = unsafe { ConnectNamedPipe(handle, std::ptr::null_mut()) };
        assert!(connected != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED);
        let mut pipe = unsafe { File::from_raw_handle(handle as _) };
        assert_eq!(read_frame(&mut pipe, 1024).unwrap()["type"], "heartbeat");
        assert!(child.wait().unwrap().success());
    }

    #[cfg(windows)]
    #[test]
    fn separate_request_and_response_pipes_exchange_a_frame() {
        use std::os::windows::io::FromRawHandle;
        use windows_sys::Win32::Foundation::{GetLastError, ERROR_PIPE_CONNECTED};
        use windows_sys::Win32::System::Pipes::ConnectNamedPipe;

        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let request_name = format!(r"\\.\pipe\ec-request-test-{}-{nonce}", std::process::id());
        let response_name = format!(r"\\.\pipe\ec-response-test-{}-{nonce}", std::process::id());
        let request_handle = create_pipe(&request_name, PipeDirection::HostWrites).unwrap();
        let response_handle = create_pipe(&response_name, PipeDirection::HostReads).unwrap();
        let script = "import json,os,struct; r=open(os.environ['REQUEST'],'rb',buffering=0); w=open(os.environ['RESPONSE'],'wb',buffering=0); n=struct.unpack('<I',r.read(4))[0]; q=json.loads(r.read(n)); b=json.dumps({'type':'response','id':q['id']}).encode(); w.write(struct.pack('<I',len(b))+b); r.close(); w.close()";
        let mut child = Command::new("python")
            .args(["-c", script])
            .env("REQUEST", &request_name)
            .env("RESPONSE", &response_name)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let connected = unsafe { ConnectNamedPipe(request_handle, std::ptr::null_mut()) };
        assert!(connected != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED);
        let connected = unsafe { ConnectNamedPipe(response_handle, std::ptr::null_mut()) };
        assert!(connected != 0 || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED);
        let mut request_pipe = unsafe { File::from_raw_handle(request_handle as _) };
        let mut response_pipe = unsafe { File::from_raw_handle(response_handle as _) };
        write_frame(&mut request_pipe, &json!({"type":"request","id":7}), 1024).unwrap();
        let mut reader = IncrementalFrameReader::new(1024);
        let response = reader.read_next(&mut response_pipe).unwrap();
        assert_eq!(response["id"], 7);
        assert!(child.wait().unwrap().success());
    }
}
