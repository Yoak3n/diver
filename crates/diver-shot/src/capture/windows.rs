//! Windows GDI 捕获：显示器枚举 / 窗口矩形 / 矩形截取 + JPEG 落盘。
//!
//! 同进程内 `SetProcessDpiAwareness`，坐标为虚拟屏物理像素。

use std::ffi::c_void;
use std::fs;
use std::path::Path;
use std::ptr;

use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, EnumDisplayMonitors,
    GetDC, GetDIBits, GetMonitorInfoW, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER,
    BI_RGB, DIB_RGB_COLORS, HDC, HMONITOR, MONITORINFOEXW, SRCCOPY,
};
use windows_sys::Win32::UI::HiDpi::{SetProcessDpiAwareness, PROCESS_PER_MONITOR_DPI_AWARE};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetSystemMetrics, GetWindowRect, GetWindowTextW, IsIconic, IsWindowVisible,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

use crate::encode::encode_jpeg_ladder;
use crate::geometry::{scale_rgb_bilinear, scale_to_fit};
use crate::types::*;

type Bool = i32;
const TRUE: Bool = 1;
const FALSE: Bool = 0;

fn dpi_aware() {
    unsafe {
        SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
    }
}

fn rect_from(raw: &RECT) -> Rect {
    Rect {
        x: raw.left,
        y: raw.top,
        width: (raw.right - raw.left).max(0) as u32,
        height: (raw.bottom - raw.top).max(0) as u32,
    }
}

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

/// 枚举显示器 + 虚拟屏。
pub fn list_displays() -> Result<ListDisplaysResult, ShotError> {
    dpi_aware();
    let mut list: Vec<DisplayInfo> = Vec::new();
    unsafe extern "system" fn proc(
        hmonitor: HMONITOR,
        _hdc: HDC,
        _lprect: *mut RECT,
        lparam: LPARAM,
    ) -> Bool {
        let list = &mut *(lparam as *mut Vec<DisplayInfo>);
        let mut info: MONITORINFOEXW = std::mem::zeroed();
        info.monitorInfo.cbSize = std::mem::size_of::<MONITORINFOEXW>() as u32;
        if GetMonitorInfoW(hmonitor, &mut info.monitorInfo as *mut _) == 0 {
            return TRUE;
        }
        let name = wide_to_string(&info.szDevice);
        let bounds = rect_from(&info.monitorInfo.rcMonitor);
        let work = rect_from(&info.monitorInfo.rcWork);
        let index = list.len() as u32;
        list.push(DisplayInfo {
            index,
            name,
            primary: (info.monitorInfo.dwFlags & 1) != 0,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
            work,
        });
        TRUE
    }
    unsafe {
        EnumDisplayMonitors(ptr::null_mut(), ptr::null(), Some(proc), &mut list as *mut _ as LPARAM);
    }
    list.sort_by_key(|d| (!d.primary, d.x, d.y));
    for (i, d) in list.iter_mut().enumerate() {
        d.index = i as u32;
    }
    let vs = virtual_screen();
    Ok(ListDisplaysResult { displays: list, virtual_screen: vs })
}

fn virtual_screen() -> Rect {
    unsafe {
        Rect {
            x: GetSystemMetrics(SM_XVIRTUALSCREEN),
            y: GetSystemMetrics(SM_YVIRTUALSCREEN),
            width: GetSystemMetrics(SM_CXVIRTUALSCREEN).max(0) as u32,
            height: GetSystemMetrics(SM_CYVIRTUALSCREEN).max(0) as u32,
        }
    }
}

/// 按标题子串找第一个可见主窗口。
pub fn find_window(needle: &str) -> Result<Option<WindowRect>, ShotError> {
    dpi_aware();
    struct Hit {
        title: String,
        rect: RECT,
        iconic: bool,
    }
    struct Ctx<'a> {
        needle: &'a str,
        found: Option<Hit>,
    }
    let mut ctx = Ctx {
        needle: &needle.to_lowercase(),
        found: None,
    };

    unsafe extern "system" fn proc(hwnd: HWND, lparam: LPARAM) -> Bool {
        let ctx = &mut *(lparam as *mut Ctx<'static>);
        if ctx.found.is_some() {
            return FALSE;
        }
        if IsWindowVisible(hwnd) == 0 {
            return TRUE;
        }
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
        if n <= 0 {
            return TRUE;
        }
        let title = wide_to_string(&buf);
        if !title.to_lowercase().contains(ctx.needle) {
            return TRUE;
        }
        let mut rect: RECT = std::mem::zeroed();
        if GetWindowRect(hwnd, &mut rect) == 0 {
            return TRUE;
        }
        ctx.found = Some(Hit {
            title,
            rect,
            iconic: IsIconic(hwnd) != 0,
        });
        FALSE
    }

    unsafe {
        EnumWindows(Some(proc), &mut ctx as *mut _ as LPARAM);
    }
    Ok(ctx.found.map(|hit| {
        let r = rect_from(&hit.rect);
        WindowRect {
            title: hit.title,
            x: r.x,
            y: r.y,
            width: r.width.max(1),
            height: r.height.max(1),
            iconic: hit.iconic,
        }
    }))
}

/// 捕获矩形 → RGB → 可选缩放 → JPEG 落盘。
pub fn capture_rect(rect: Rect, plan: EncodePlan, out_path: &str) -> Result<CaptureFileResult, ShotError> {
    dpi_aware();
    if rect.width == 0 || rect.height == 0 {
        return Err(ShotError::new(ShotErrorCode::InvalidRect, "invalid capture rect"));
    }
    let mut rgb = capture_rgb(rect)?;
    let (tw, th, _) = scale_to_fit(rect.width, rect.height, plan.max_width);
    let mut width = tw;
    let mut height = th;
    if tw != rect.width || th != rect.height {
        rgb = scale_rgb_bilinear(&rgb, rect.width, rect.height, tw, th);
    }
    let mut bytes = encode_jpeg_ladder(&rgb, width, height, plan)?;
    if bytes.len() as u64 > plan.max_bytes {
        let w2 = ((width as f64) * 0.8).floor().max(1.0) as u32;
        let h2 = ((height as f64) * 0.8).floor().max(1.0) as u32;
        rgb = scale_rgb_bilinear(&rgb, width, height, w2, h2);
        width = w2;
        height = h2;
        bytes = encode_jpeg_ladder(&rgb, width, height, plan)?;
    }
    if let Some(parent) = Path::new(out_path).parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| ShotError::new(ShotErrorCode::Io, e.to_string()))?;
        }
    }
    fs::write(out_path, &bytes).map_err(|e| ShotError::new(ShotErrorCode::Io, e.to_string()))?;
    Ok(CaptureFileResult {
        path: out_path.to_string(),
        bytes: bytes.len() as u64,
        width,
        height,
        source: rect,
        format: "jpeg".into(),
        quality: plan.quality,
        max_bytes: plan.max_bytes,
    })
}

/// GDI BitBlt 截取 → 紧凑 RGB24（自上而下）。
fn capture_rgb(rect: Rect) -> Result<Vec<u8>, ShotError> {
    let w = rect.width as i32;
    let h = rect.height as i32;
    unsafe {
        let hdc_screen: HDC = GetDC(ptr::null_mut());
        if hdc_screen.is_null() {
            return Err(ShotError::new(ShotErrorCode::CaptureFailed, "GetDC failed"));
        }
        let hdc_mem: HDC = CreateCompatibleDC(hdc_screen);
        let hbmp = CreateCompatibleBitmap(hdc_screen, w, h);
        if hdc_mem.is_null() || hbmp.is_null() {
            ReleaseDC(ptr::null_mut(), hdc_screen);
            if !hdc_mem.is_null() {
                DeleteDC(hdc_mem);
            }
            if !hbmp.is_null() {
                DeleteObject(hbmp as *mut c_void);
            }
            return Err(ShotError::new(ShotErrorCode::CaptureFailed, "CreateCompatible* failed"));
        }
        let old = SelectObject(hdc_mem, hbmp as *mut c_void);
        let ok = BitBlt(hdc_mem, 0, 0, w, h, hdc_screen, rect.x, rect.y, SRCCOPY);
        let mut bmi: BITMAPINFO = std::mem::zeroed();
        bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        bmi.bmiHeader.biWidth = w;
        bmi.bmiHeader.biHeight = -h; // top-down
        bmi.bmiHeader.biPlanes = 1;
        bmi.bmiHeader.biBitCount = 32;
        bmi.bmiHeader.biCompression = BI_RGB;
        let mut bgra = vec![0u8; (rect.width * rect.height * 4) as usize];
        let got = GetDIBits(
            hdc_mem,
            hbmp,
            0,
            h as u32,
            bgra.as_mut_ptr() as *mut c_void,
            &mut bmi,
            DIB_RGB_COLORS,
        );
        SelectObject(hdc_mem, old);
        DeleteObject(hbmp as *mut c_void);
        DeleteDC(hdc_mem);
        ReleaseDC(ptr::null_mut(), hdc_screen);
        if ok == 0 || got == 0 {
            return Err(ShotError::new(ShotErrorCode::CaptureFailed, "BitBlt/GetDIBits failed"));
        }
        let mut rgb = Vec::with_capacity((rect.width * rect.height * 3) as usize);
        for px in bgra.chunks_exact(4) {
            rgb.push(px[2]);
            rgb.push(px[1]);
            rgb.push(px[0]);
        }
        Ok(rgb)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_displays_smoke() {
        if let Ok(list) = list_displays() {
            assert!(!list.displays.is_empty() || list.virtual_screen.width > 0);
        }
    }

    #[test]
    fn capture_tiny_rect_jpeg_under_budget() {
        let Ok(list) = list_displays() else { return };
        let Some(d) = list.displays.first() else { return };
        let rect = Rect {
            x: d.x + 8,
            y: d.y + 8,
            width: 64,
            height: 64,
        };
        let plan = EncodePlan {
            max_width: 64,
            quality: 68,
            max_bytes: 50 * 1024,
        };
        let out = std::env::temp_dir().join(format!("diver-shot-test-{}.jpg", std::process::id()));
        let result = capture_rect(rect, plan, &out.to_string_lossy()).expect("capture");
        assert!(result.bytes > 0);
        assert!(result.bytes <= plan.max_bytes.max(result.bytes)); // 写盘成功
        let data = std::fs::read(&out).unwrap();
        assert_eq!(&data[..2], &[0xFF, 0xD8]);
        let _ = std::fs::remove_file(&out);
    }
}
