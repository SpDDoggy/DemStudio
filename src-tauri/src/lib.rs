use dem_core::{
    CoreFile, DemDataset, FileBackedDataset, RenderedGeoTiff, SampledTerrain, SamplingOptions,
    WindowSamplingOptions,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Response;
use tauri::State;

#[derive(Default)]
struct CoreState {
    datasets: Mutex<HashMap<String, Arc<StoredDataset>>>,
    requests: Mutex<HashMap<String, ActiveRequest>>,
    next_id: AtomicU64,
}

enum StoredDataset {
    Memory(DemDataset),
    FileBacked(FileBackedDataset),
}

#[derive(Clone)]
struct ActiveRequest {
    dataset_id: String,
    cancelled: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ParsedDemResponse {
    #[serde(flatten)]
    dataset: DemDataset,
    core_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseDemRequest {
    name: String,
    bytes: Vec<u8>,
    #[serde(default)]
    companions: Vec<CoreFile>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParseDemPathRequest {
    path: String,
    #[serde(default)]
    companion_paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleDemRequest {
    core_id: String,
    max_dimension: usize,
    no_data_fill: String,
    smooth_steps: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SampleDemWindowRequest {
    core_id: String,
    x: usize,
    y: usize,
    width: usize,
    height: usize,
    #[serde(default)]
    output_cols: Option<usize>,
    #[serde(default)]
    output_rows: Option<usize>,
    #[serde(default)]
    max_dimension: Option<usize>,
    no_data_fill: String,
    smooth_steps: usize,
    #[serde(default)]
    request_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CoreStats {
    dataset_count: usize,
    file_backed_count: usize,
    chunk_cache_hits: u64,
    chunk_cache_misses: u64,
    chunk_cache_evictions: u64,
    chunk_cache_decoded_chunks: u64,
    chunk_cache_resident_bytes: usize,
    chunk_cache_capacity_bytes: usize,
}

fn read_heightmap_bytes(path: &Path) -> Result<Vec<u8>, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        .ok_or_else(|| "高度图缺少可识别的文件扩展名".to_string())?;
    if !matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "webp") {
        return Err(format!("不支持从最近文件读取 .{extension} 高度图"));
    }
    if !path.is_file() {
        return Err(format!("高度图文件不存在或不可访问：{}", path.display()));
    }
    std::fs::read(path).map_err(|error| format!("无法读取高度图 {}：{error}", path.display()))
}

#[tauri::command]
fn read_heightmap_path(path: String) -> Result<Response, String> {
    read_heightmap_bytes(&PathBuf::from(path)).map(Response::new)
}

fn register_dataset(dataset: StoredDataset, state: &CoreState) -> ParsedDemResponse {
    let id = format!("dem-{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1);
    let metadata = match &dataset {
        StoredDataset::Memory(dataset) => dataset.metadata_only(),
        StoredDataset::FileBacked(dataset) => dataset.metadata.metadata_only(),
    };
    state
        .datasets
        .lock()
        .expect("DEM Core state lock poisoned")
        .insert(id.clone(), Arc::new(dataset));
    ParsedDemResponse {
        dataset: metadata,
        core_id: id,
    }
}

fn lookup_dataset(core_id: &str, state: &CoreState) -> Result<Arc<StoredDataset>, String> {
    state
        .datasets
        .lock()
        .map_err(|_| "DEM Core 状态不可用".to_string())?
        .get(core_id)
        .cloned()
        .ok_or_else(|| "DEM Core 数据集已失效".to_string())
}

fn register_request(
    request_id: Option<&str>,
    dataset_id: &str,
    cancelled: Arc<AtomicBool>,
    state: &CoreState,
) -> Result<(), String> {
    let Some(request_id) = request_id.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "DEM Core 请求状态不可用".to_string())?;
    if let Some(previous) = requests.insert(
        request_id.to_string(),
        ActiveRequest {
            dataset_id: dataset_id.to_string(),
            cancelled,
        },
    ) {
        previous.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

fn finish_request(
    request_id: Option<&str>,
    cancelled: &Arc<AtomicBool>,
    state: &CoreState,
) -> Result<(), String> {
    let Some(request_id) = request_id.filter(|value| !value.is_empty()) else {
        return Ok(());
    };
    let mut requests = state
        .requests
        .lock()
        .map_err(|_| "DEM Core 请求状态不可用".to_string())?;
    if requests
        .get(request_id)
        .map(|active| Arc::ptr_eq(&active.cancelled, cancelled))
        .unwrap_or(false)
    {
        requests.remove(request_id);
    }
    Ok(())
}

fn cancel_registered_request(request_id: &str, state: &CoreState) -> Result<bool, String> {
    if request_id.is_empty() {
        return Ok(false);
    }
    let requests = state
        .requests
        .lock()
        .map_err(|_| "DEM Core 请求状态不可用".to_string())?;
    let Some(request) = requests.get(request_id) else {
        return Ok(false);
    };
    request.cancelled.store(true, Ordering::Relaxed);
    Ok(true)
}

#[tauri::command]
fn parse_dem(
    request: ParseDemRequest,
    state: State<'_, CoreState>,
) -> Result<ParsedDemResponse, String> {
    let dataset = dem_core::parse(&request.name, &request.bytes, &request.companions)
        .map_err(|error| error.to_string())?;
    Ok(register_dataset(StoredDataset::Memory(dataset), &state))
}

#[tauri::command]
fn parse_dem_path(
    request: ParseDemPathRequest,
    state: State<'_, CoreState>,
) -> Result<ParsedDemResponse, String> {
    let path = std::path::PathBuf::from(&request.path);
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "无法读取 DEM 文件名".to_string())?;
    let companions = request
        .companion_paths
        .iter()
        .map(|value| {
            let path = std::path::PathBuf::from(value);
            let name = path
                .file_name()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "无法读取侧车文件名".to_string())?
                .to_string();
            let bytes =
                std::fs::read(&path).map_err(|error| format!("无法读取侧车文件：{error}"))?;
            Ok(CoreFile { name, bytes })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let dataset = if matches!(extension.as_str(), "tif" | "tiff") {
        StoredDataset::FileBacked(
            dem_core::open_geotiff_path(&path, name, &companions)
                .map_err(|error| error.to_string())?,
        )
    } else {
        let bytes = std::fs::read(&path).map_err(|error| format!("无法读取 DEM 文件：{error}"))?;
        StoredDataset::Memory(
            dem_core::parse(name, &bytes, &companions).map_err(|error| error.to_string())?,
        )
    };
    Ok(register_dataset(dataset, &state))
}

#[tauri::command]
async fn sample_dem(
    request: SampleDemRequest,
    state: State<'_, CoreState>,
) -> Result<SampledTerrain, String> {
    let dataset = lookup_dataset(&request.core_id, &state)?;
    let options = SamplingOptions {
        max_dimension: request.max_dimension,
        no_data_fill: request.no_data_fill,
        smooth_steps: request.smooth_steps,
    };
    tauri::async_runtime::spawn_blocking(move || match dataset.as_ref() {
        StoredDataset::Memory(dataset) => dem_core::sample_dataset(dataset, &options),
        StoredDataset::FileBacked(dataset) => dem_core::sample_file_dataset(dataset, &options),
    })
    .await
    .map_err(|error| format!("DEM Core 后台任务失败：{error}"))?
    .map_err(|error| error.to_string())
}

fn encode_sample_binary(sample: SampledTerrain) -> Result<Response, String> {
    let cols = u32::try_from(sample.cols).map_err(|_| "DEM 采样列数溢出".to_string())?;
    let rows = u32::try_from(sample.rows).map_err(|_| "DEM 采样行数溢出".to_string())?;
    let value_count = sample
        .cols
        .checked_mul(sample.rows)
        .ok_or_else(|| "DEM 采样像元数溢出".to_string())?;
    if sample.heights.len() != value_count || sample.valid_mask.len() != value_count {
        return Err("DEM 采样高程或有效性掩膜长度不一致".to_string());
    }
    let payload_bytes = sample
        .heights
        .len()
        .checked_mul(std::mem::size_of::<f32>())
        .and_then(|value| value.checked_add(sample.valid_mask.len()))
        .and_then(|value| value.checked_add(20))
        .ok_or_else(|| "DEM 二进制采样大小溢出".to_string())?;
    let mut bytes = Vec::with_capacity(payload_bytes);
    bytes.extend_from_slice(b"DMT3");
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&20u16.to_le_bytes());
    bytes.extend_from_slice(&cols.to_le_bytes());
    bytes.extend_from_slice(&rows.to_le_bytes());
    bytes.extend_from_slice(
        &u32::try_from(sample.valid_mask.len())
            .map_err(|_| "DEM 掩膜长度溢出".to_string())?
            .to_le_bytes(),
    );
    for value in sample.heights {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    bytes.extend_from_slice(&sample.valid_mask);
    Ok(Response::new(bytes))
}

#[tauri::command]
async fn sample_dem_binary(
    request: SampleDemRequest,
    state: State<'_, CoreState>,
) -> Result<Response, String> {
    let dataset = lookup_dataset(&request.core_id, &state)?;
    let options = SamplingOptions {
        max_dimension: request.max_dimension,
        no_data_fill: request.no_data_fill,
        smooth_steps: request.smooth_steps,
    };
    let sample = tauri::async_runtime::spawn_blocking(move || match dataset.as_ref() {
        StoredDataset::Memory(dataset) => dem_core::sample_dataset(dataset, &options),
        StoredDataset::FileBacked(dataset) => dem_core::sample_file_dataset(dataset, &options),
    })
    .await
    .map_err(|error| format!("DEM Core 后台任务失败：{error}"))?
    .map_err(|error| error.to_string())?;
    encode_sample_binary(sample)
}

#[tauri::command]
async fn sample_dem_window_binary(
    request: SampleDemWindowRequest,
    state: State<'_, CoreState>,
) -> Result<Response, String> {
    let dataset = lookup_dataset(&request.core_id, &state)?;
    let core_id = request.core_id.clone();
    let request_id = request.request_id.clone();
    let options = WindowSamplingOptions {
        source_x: request.x,
        source_y: request.y,
        source_width: request.width,
        source_height: request.height,
        output_width: request.output_cols,
        output_height: request.output_rows,
        max_dimension: request.max_dimension,
        no_data_fill: request.no_data_fill,
        smooth_steps: request.smooth_steps,
    };
    let cancelled = Arc::new(AtomicBool::new(false));
    register_request(
        request_id.as_deref(),
        &core_id,
        Arc::clone(&cancelled),
        &state,
    )?;
    let task_cancelled = Arc::clone(&cancelled);
    let task = tauri::async_runtime::spawn_blocking(move || match dataset.as_ref() {
        StoredDataset::Memory(dataset) => dem_core::sample_dataset_window_cancellable(
            dataset,
            &options,
            Some(task_cancelled.as_ref()),
        ),
        StoredDataset::FileBacked(dataset) => dem_core::sample_file_window_cancellable(
            dataset,
            &options,
            Some(task_cancelled.as_ref()),
        ),
    })
    .await;
    finish_request(request_id.as_deref(), &cancelled, &state)?;
    let sample = task
        .map_err(|error| format!("DEM Core 后台任务失败：{error}"))?
        .map_err(|error| error.to_string())?;
    encode_sample_binary(sample)
}

#[tauri::command]
async fn sample_dem_overview_binary(
    request: SampleDemRequest,
    state: State<'_, CoreState>,
) -> Result<Response, String> {
    let dataset = lookup_dataset(&request.core_id, &state)?;
    let options = SamplingOptions {
        max_dimension: request.max_dimension,
        no_data_fill: request.no_data_fill,
        smooth_steps: request.smooth_steps,
    };
    let sample = tauri::async_runtime::spawn_blocking(move || match dataset.as_ref() {
        StoredDataset::Memory(dataset) => dem_core::sample_dataset(dataset, &options),
        StoredDataset::FileBacked(dataset) => dem_core::sample_file_overview(dataset, &options),
    })
    .await
    .map_err(|error| format!("DEM Core 后台任务失败：{error}"))?
    .map_err(|error| error.to_string())?;
    encode_sample_binary(sample)
}

#[tauri::command]
fn release_dem(core_id: String, state: State<'_, CoreState>) -> Result<bool, String> {
    let removed = state
        .datasets
        .lock()
        .map_err(|_| "DEM Core 状态不可用".to_string())?
        .remove(&core_id)
        .is_some();
    let requests = state
        .requests
        .lock()
        .map_err(|_| "DEM Core 请求状态不可用".to_string())?;
    for request in requests.values() {
        if request.dataset_id == core_id {
            request.cancelled.store(true, Ordering::Relaxed);
        }
    }
    Ok(removed)
}

#[tauri::command]
fn cancel_dem_request(request_id: String, state: State<'_, CoreState>) -> Result<bool, String> {
    cancel_registered_request(&request_id, &state)
}

#[tauri::command]
fn core_stats(state: State<'_, CoreState>) -> Result<CoreStats, String> {
    let datasets = state
        .datasets
        .lock()
        .map_err(|_| "DEM Core 状态不可用".to_string())?;
    let mut stats = CoreStats {
        dataset_count: datasets.len(),
        file_backed_count: 0,
        chunk_cache_hits: 0,
        chunk_cache_misses: 0,
        chunk_cache_evictions: 0,
        chunk_cache_decoded_chunks: 0,
        chunk_cache_resident_bytes: 0,
        chunk_cache_capacity_bytes: 0,
    };
    for dataset in datasets.values() {
        let StoredDataset::FileBacked(dataset) = dataset.as_ref() else {
            continue;
        };
        stats.file_backed_count += 1;
        let cache = dataset.cache_stats().map_err(|error| error.to_string())?;
        stats.chunk_cache_hits = stats.chunk_cache_hits.saturating_add(cache.hits);
        stats.chunk_cache_misses = stats.chunk_cache_misses.saturating_add(cache.misses);
        stats.chunk_cache_evictions = stats.chunk_cache_evictions.saturating_add(cache.evictions);
        stats.chunk_cache_decoded_chunks = stats
            .chunk_cache_decoded_chunks
            .saturating_add(cache.decoded_chunks);
        stats.chunk_cache_resident_bytes = stats
            .chunk_cache_resident_bytes
            .saturating_add(cache.resident_bytes);
        stats.chunk_cache_capacity_bytes = stats
            .chunk_cache_capacity_bytes
            .saturating_add(cache.max_bytes);
    }
    Ok(stats)
}

#[tauri::command]
fn encode_geotiff(request: RenderedGeoTiff) -> Result<Vec<u8>, String> {
    dem_core::encode_rendered_geotiff(&request).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(CoreState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            parse_dem,
            parse_dem_path,
            sample_dem,
            sample_dem_binary,
            sample_dem_window_binary,
            read_heightmap_path,
            sample_dem_overview_binary,
            cancel_dem_request,
            release_dem,
            core_stats,
            encode_geotiff
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DEM Studio");
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_registered_request, lookup_dataset, read_heightmap_bytes, register_dataset,
        register_request, CoreState, StoredDataset,
    };
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;

    #[test]
    fn heightmap_reader_is_path_scoped_and_extension_limited() {
        let unique = format!(
            "dem-studio-heightmap-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        let png_path = std::env::temp_dir().join(format!("{unique}.png"));
        let asc_path = std::env::temp_dir().join(format!("{unique}.asc"));
        std::fs::write(&png_path, [0x89, b'P', b'N', b'G']).unwrap();
        std::fs::write(&asc_path, b"ncols 1").unwrap();
        assert_eq!(
            read_heightmap_bytes(&png_path).unwrap(),
            vec![0x89, b'P', b'N', b'G']
        );
        assert!(read_heightmap_bytes(&asc_path)
            .unwrap_err()
            .contains("不支持"));
        let _ = std::fs::remove_file(png_path);
        let _ = std::fs::remove_file(asc_path);
    }

    #[test]
    fn dataset_lookup_releases_the_registry_lock_before_work() {
        let state = CoreState::default();
        let dataset =
            dem_core::parse("lock.asc", b"ncols 2\nnrows 2\ncellsize 1\n1 2\n3 4\n", &[]).unwrap();
        let registered = register_dataset(StoredDataset::Memory(dataset), &state);
        let retained = lookup_dataset(&registered.core_id, &state).unwrap();
        assert!(state.datasets.try_lock().is_ok());
        assert!(Arc::strong_count(&retained) >= 2);
    }

    #[test]
    fn duplicate_request_id_cancels_the_previous_token() {
        let state = CoreState::default();
        let first = Arc::new(AtomicBool::new(false));
        let second = Arc::new(AtomicBool::new(false));
        register_request(Some("focus"), "dem-1", Arc::clone(&first), &state).unwrap();
        register_request(Some("focus"), "dem-1", Arc::clone(&second), &state).unwrap();
        assert!(first.load(Ordering::Relaxed));
        assert!(!second.load(Ordering::Relaxed));
    }

    #[test]
    fn explicit_request_cancellation_sets_the_registered_token() {
        let state = CoreState::default();
        let cancelled = Arc::new(AtomicBool::new(false));
        register_request(Some("cancel-me"), "dem-1", Arc::clone(&cancelled), &state).unwrap();
        assert!(cancel_registered_request("cancel-me", &state).unwrap());
        assert!(cancelled.load(Ordering::Relaxed));
        assert!(!cancel_registered_request("missing", &state).unwrap());
    }
}
