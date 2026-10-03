"""Per-application audio capture on Windows 10 2004+ / Windows 11.

Uses the WASAPI *process loopback* virtual device
(ActivateAudioInterfaceAsync + AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK)
to record only what one app (and its child processes) plays – e.g. only the
other person's voice in WhatsApp, not your music or notification sounds.

Implemented with plain ctypes (no compiled helper) so it ships inside the EXE.
"""

from __future__ import annotations

import ctypes
import logging
import sys
import threading
import uuid
from ctypes import POINTER, Structure, byref, c_int, c_int64, c_long, c_uint32, c_ulong, c_ushort, c_void_p

import numpy as np

log = logging.getLogger(__name__)

if sys.platform == "win32":  # pragma: no cover - Windows only
    from ctypes import WINFUNCTYPE, wintypes

    HRESULT = c_long
else:  # allow import (and unit tests of pure helpers) on other platforms
    WINFUNCTYPE = ctypes.CFUNCTYPE
    HRESULT = c_long


class GUID(Structure):
    _fields_ = [("Data1", c_ulong), ("Data2", c_ushort), ("Data3", c_ushort), ("Data4", ctypes.c_ubyte * 8)]

    @classmethod
    def from_str(cls, s: str) -> "GUID":
        return cls.from_buffer_copy(uuid.UUID(s).bytes_le)

    def matches(self, other: "GUID") -> bool:
        return bytes(self) == bytes(other)


IID_IUnknown = GUID.from_str("00000000-0000-0000-C000-000000000046")
IID_IAgileObject = GUID.from_str("94ea2b94-e9cc-49e0-c0ff-ee64ca8f5b90")
IID_IActivateAudioInterfaceCompletionHandler = GUID.from_str("41D949AB-9862-444A-80F6-C261334DA5EB")
IID_IAudioClient = GUID.from_str("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2")
IID_IAudioCaptureClient = GUID.from_str("C8ADBD64-E71E-48a0-A4DE-185C395CD317")

VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK = "VAD\\Process_Loopback"
AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0
VT_BLOB = 65
AUDCLNT_SHAREMODE_SHARED = 0
AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000
AUDCLNT_STREAMFLAGS_EVENTCALLBACK = 0x00040000
AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM = 0x80000000
AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY = 0x08000000
AUDCLNT_BUFFERFLAGS_SILENT = 0x2
WAVE_FORMAT_PCM = 1
S_OK = 0
E_NOINTERFACE = -2147467262  # 0x80004002


class AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS(Structure):
    _fields_ = [("TargetProcessId", c_uint32), ("ProcessLoopbackMode", c_int)]


class AUDIOCLIENT_ACTIVATION_PARAMS(Structure):
    _fields_ = [("ActivationType", c_int), ("ProcessLoopbackParams", AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS)]


class BLOB(Structure):
    _fields_ = [("cbSize", c_ulong), ("pBlobData", c_void_p)]


class PROPVARIANT(Structure):
    _fields_ = [("vt", c_ushort), ("wReserved1", c_ushort), ("wReserved2", c_ushort),
                ("wReserved3", c_ushort), ("blob", BLOB)]


class WAVEFORMATEX(Structure):
    _pack_ = 1
    _fields_ = [("wFormatTag", c_ushort), ("nChannels", c_ushort), ("nSamplesPerSec", c_uint32),
                ("nAvgBytesPerSec", c_uint32), ("nBlockAlign", c_ushort), ("wBitsPerSample", c_ushort),
                ("cbSize", c_ushort)]


def _check(hr: int, what: str) -> int:
    if hr < 0:
        raise OSError(f"{what} failed: HRESULT 0x{hr & 0xFFFFFFFF:08X}")
    return hr


def _method(obj: c_void_p, index: int, *argtypes):
    """Return a callable for the COM vtable slot `index` of interface pointer `obj`."""
    vtbl = ctypes.cast(obj, POINTER(POINTER(c_void_p)))[0]
    proto = WINFUNCTYPE(HRESULT, c_void_p, *argtypes)
    fn = proto(vtbl[index])
    return lambda *args: fn(obj, *args)


def _release(obj: c_void_p) -> None:
    if obj:
        vtbl = ctypes.cast(obj, POINTER(POINTER(c_void_p)))[0]
        WINFUNCTYPE(c_ulong, c_void_p)(vtbl[2])(obj)


# ------------------------------------------------------------- completion handler (COM object)
QI_T = WINFUNCTYPE(HRESULT, c_void_p, POINTER(GUID), POINTER(c_void_p))
REF_T = WINFUNCTYPE(c_ulong, c_void_p)
DONE_T = WINFUNCTYPE(HRESULT, c_void_p, c_void_p)


class _HandlerVtbl(Structure):
    _fields_ = [("QueryInterface", QI_T), ("AddRef", REF_T), ("Release", REF_T), ("ActivateCompleted", DONE_T)]


class _HandlerObj(Structure):
    _fields_ = [("lpVtbl", POINTER(_HandlerVtbl))]


class _CompletionHandler:
    """Minimal free-threaded IActivateAudioInterfaceCompletionHandler."""

    def __init__(self):
        self.done = threading.Event()
        self.hr = 0
        self.audio_client = c_void_p()
        self._refs = 1
        self._qi = QI_T(self._query_interface)
        self._addref = REF_T(self._add_ref)
        self._release = REF_T(self._release_ref)
        self._completed = DONE_T(self._activate_completed)
        self._vtbl = _HandlerVtbl(self._qi, self._addref, self._release, self._completed)
        self.obj = _HandlerObj(ctypes.pointer(self._vtbl))
        self.ptr = ctypes.cast(ctypes.pointer(self.obj), c_void_p)

    def _query_interface(self, this, riid, ppv):
        iid = riid.contents
        if (iid.matches(IID_IUnknown) or iid.matches(IID_IActivateAudioInterfaceCompletionHandler)
                or iid.matches(IID_IAgileObject)):
            ppv[0] = this
            self._refs += 1
            return S_OK
        ppv[0] = None
        return E_NOINTERFACE

    def _add_ref(self, this):
        self._refs += 1
        return self._refs

    def _release_ref(self, this):
        self._refs = max(0, self._refs - 1)
        return self._refs  # Python owns the memory; kept alive by the capture object

    def _activate_completed(self, this, operation):
        try:
            hr_activate = HRESULT()
            punk = c_void_p()
            get_result = _method(c_void_p(operation), 3, POINTER(HRESULT), POINTER(c_void_p))
            hr = get_result(byref(hr_activate), byref(punk))
            self.hr = hr if hr < 0 else hr_activate.value
            if self.hr >= 0:
                self.audio_client = punk
        except Exception as e:  # noqa: BLE001
            log.exception("ActivateCompleted: %s", e)
            self.hr = -1
        finally:
            self.done.set()
        return S_OK


# ------------------------------------------------------------- capture
class ProcessLoopbackCapture:
    """Capture one process tree. `on_audio(float32_mono, sample_rate)` gets ~10 ms blocks."""

    def __init__(self, pid: int, on_audio, sample_rate: int = 16000):
        if sys.platform != "win32":
            raise OSError("Per-app capture requires Windows 10 (2004) or newer")
        self.pid = pid
        self.on_audio = on_audio
        self.rate = sample_rate
        self.channels = 1
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.error: str | None = None
        self._started = threading.Event()

    def start(self, timeout: float = 5.0) -> None:
        self._thread = threading.Thread(target=self._run, daemon=True, name=f"proc-loopback-{self.pid}")
        self._thread.start()
        self._started.wait(timeout)
        if self.error:
            raise OSError(self.error)

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

    def _activate(self) -> c_void_p:
        params = AUDIOCLIENT_ACTIVATION_PARAMS()
        params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK
        params.ProcessLoopbackParams.TargetProcessId = self.pid
        params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
        pv = PROPVARIANT()
        pv.vt = VT_BLOB
        pv.blob.cbSize = ctypes.sizeof(params)
        pv.blob.pBlobData = ctypes.cast(ctypes.pointer(params), c_void_p)

        handler = _CompletionHandler()
        self._handler = handler  # keep callbacks alive
        op = c_void_p()
        mmdevapi = ctypes.WinDLL("Mmdevapi")
        fn = mmdevapi.ActivateAudioInterfaceAsync
        fn.restype = HRESULT
        fn.argtypes = [wintypes.LPCWSTR, POINTER(GUID), POINTER(PROPVARIANT), c_void_p, POINTER(c_void_p)]
        _check(fn(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, byref(IID_IAudioClient), byref(pv),
                  handler.ptr, byref(op)), "ActivateAudioInterfaceAsync")
        if not handler.done.wait(5.0):
            raise OSError("audio activation timed out")
        _release(op)
        _check(handler.hr, "process loopback activation")
        return handler.audio_client

    def _run(self) -> None:  # pragma: no cover - Windows only
        ole32 = ctypes.WinDLL("ole32")
        kernel32 = ctypes.WinDLL("kernel32")
        kernel32.CreateEventW.restype = c_void_p
        kernel32.CreateEventW.argtypes = [c_void_p, ctypes.c_bool, ctypes.c_bool, c_void_p]
        kernel32.WaitForSingleObject.argtypes = [c_void_p, c_uint32]
        kernel32.CloseHandle.argtypes = [c_void_p]
        ole32.CoInitializeEx(None, 0)  # COINIT_MULTITHREADED
        client = capture = None
        event = None
        try:
            client = self._activate()
            fmt = None
            last_err = None
            for rate, ch in ((self.rate, 1), (48000, 2), (44100, 2)):
                fmt = WAVEFORMATEX(WAVE_FORMAT_PCM, ch, rate, rate * ch * 2, ch * 2, 16, 0)
                init = _method(client, 3, c_int, c_uint32, c_int64, c_int64, POINTER(WAVEFORMATEX), c_void_p)
                hr = init(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                          | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                          200_000, 0, byref(fmt), None)
                if hr >= 0:
                    self.rate, self.channels = rate, ch
                    break
                last_err = hr
            else:
                _check(last_err or -1, "IAudioClient::Initialize")
            event = kernel32.CreateEventW(None, False, False, None)
            _check(_method(client, 13, c_void_p)(event), "SetEventHandle")
            cap = c_void_p()
            _check(_method(client, 14, POINTER(GUID), POINTER(c_void_p))(byref(IID_IAudioCaptureClient),
                                                                         byref(cap)), "GetService")
            capture = cap
            _check(_method(client, 10)(), "Start")
            self._started.set()

            get_buffer = _method(capture, 3, POINTER(c_void_p), POINTER(c_uint32), POINTER(c_uint32),
                                 c_void_p, c_void_p)
            release_buffer = _method(capture, 4, c_uint32)
            next_packet = _method(capture, 5, POINTER(c_uint32))
            block_align = self.channels * 2
            while not self._stop.is_set():
                kernel32.WaitForSingleObject(event, 100)
                size = c_uint32()
                _check(next_packet(byref(size)), "GetNextPacketSize")
                while size.value:
                    data, frames, flags = c_void_p(), c_uint32(), c_uint32()
                    _check(get_buffer(byref(data), byref(frames), byref(flags), None, None), "GetBuffer")
                    n = frames.value
                    if flags.value & AUDCLNT_BUFFERFLAGS_SILENT or not data.value:
                        pcm = np.zeros(n * self.channels, dtype=np.int16)
                    else:
                        pcm = np.frombuffer(ctypes.string_at(data.value, n * block_align), dtype="<i2").copy()
                    release_buffer(n)
                    x = pcm.astype(np.float32) / 32768.0
                    if self.channels > 1:
                        x = x.reshape(-1, self.channels).mean(axis=1)
                    self.on_audio(x, self.rate)
                    _check(next_packet(byref(size)), "GetNextPacketSize")
            _method(client, 11)()  # Stop
        except Exception as e:  # noqa: BLE001
            self.error = str(e)
            log.warning("process loopback for pid %s failed: %s", self.pid, e)
        finally:
            self._started.set()
            _release(capture)
            _release(client)
            if event:
                kernel32.CloseHandle(event)
            ole32.CoUninitialize()
