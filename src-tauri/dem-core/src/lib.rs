use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::collections::{HashMap, VecDeque};
use std::ffi::OsString;
use std::fs::File;
use std::io::{BufReader, Cursor, Read, Seek};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use thiserror::Error;
use tiff::decoder::{ChunkType, Decoder, DecodingResult};
use tiff::encoder::{colortype::RGBA8, TiffEncoder};
use tiff::tags::Tag;

const MAX_CELL_COUNT: usize = 100_000_000;
const MAX_FILE_BACKED_CELL_COUNT: u64 = 1_000_000_000;
const MAX_STATS_CHUNKS: u32 = 36;
const MAX_STATS_GRID_SIDE: u32 = 6;
const MAX_EMBEDDED_OVERVIEW_SIDE: u32 = 1024;
const DISPLAY_OVERVIEW_SIDE: u32 = 128;
const MAX_AUX_XML_BYTES: u64 = 16 * 1024 * 1024;
// Two concurrent tile decoders plus the WebView/GPU copies dominate the real-TIFF
// peak. A 64 MiB decoded-block cache retains locality without breaking the
// 1.5 GiB process-tree release gate on 30k x 18k rasters.
const DEFAULT_CHUNK_CACHE_BYTES: usize = 64 * 1024 * 1024;

#[cfg(windows)]
fn trim_process_working_set_after_overview() {
    use std::ffi::c_void;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetCurrentProcess() -> *mut c_void;
        fn SetProcessWorkingSetSize(
            process: *mut c_void,
            minimum_working_set_size: usize,
            maximum_working_set_size: usize,
        ) -> i32;
    }
    // The exact overview build temporarily touches a large number of TIFF pages.
    // They are no longer part of the active render set; ask Windows to reclaim
    // those resident pages before tiled LOD requests begin.
    unsafe {
        let process = GetCurrentProcess();
        let _ = SetProcessWorkingSetSize(process, usize::MAX, usize::MAX);
    }
}

#[cfg(not(windows))]
fn trim_process_working_set_after_overview() {}

#[derive(Debug, Error)]
pub enum DemError {
    #[error("不支持的 DEM 格式：{0}")]
    UnsupportedFormat(String),
    #[error("DEM 数据无效：{0}")]
    InvalidData(String),
    #[error("GeoTIFF 解码失败：{0}")]
    Tiff(String),
    #[error("DEM 请求已取消")]
    Cancelled,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoreFile {
    pub name: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DemDataset {
    pub name: String,
    #[serde(rename = "type")]
    pub dataset_type: String,
    pub width: usize,
    pub height: usize,
    // Keep authoritative elevations in f64 until normalization. Converting raw
    // U32/I64/F64 samples to f32 here collapses distinct elevations before the
    // renderer ever sees them.
    pub data: Vec<Option<f64>>,
    pub no_data: Option<f64>,
    pub min: f64,
    pub max: f64,
    pub no_data_count: usize,
    pub statistics_approximate: bool,
    pub geo: Option<GeoMetadata>,
    pub engine: &'static str,
}

impl DemDataset {
    pub fn metadata_only(&self) -> Self {
        Self {
            name: self.name.clone(),
            dataset_type: self.dataset_type.clone(),
            width: self.width,
            height: self.height,
            data: Vec::new(),
            no_data: self.no_data,
            min: self.min,
            max: self.max,
            no_data_count: self.no_data_count,
            statistics_approximate: self.statistics_approximate,
            geo: self.geo.clone(),
            engine: self.engine,
        }
    }
}

#[derive(Debug, Clone)]
pub struct FileBackedDataset {
    pub metadata: DemDataset,
    pub path: PathBuf,
    pub overview: SampledTerrain,
    overview_sources: Arc<Vec<FileRasterSource>>,
    chunk_cache: Arc<Mutex<ChunkCache>>,
}

#[derive(Debug, Clone)]
struct FileRasterSource {
    path: PathBuf,
    image_index: usize,
    width: usize,
    height: usize,
    cache_namespace: u32,
}

#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileCacheStats {
    pub hits: u64,
    pub misses: u64,
    pub evictions: u64,
    pub decoded_chunks: u64,
    pub resident_bytes: usize,
    pub max_bytes: usize,
}

#[derive(Debug)]
struct ChunkCache {
    entries: HashMap<u64, Arc<ChunkSamples>>,
    recency: VecDeque<u64>,
    stats: FileCacheStats,
}

impl ChunkCache {
    fn new(max_bytes: usize) -> Self {
        Self {
            entries: HashMap::new(),
            recency: VecDeque::new(),
            stats: FileCacheStats {
                max_bytes,
                ..FileCacheStats::default()
            },
        }
    }

    fn touch(&mut self, chunk_key: u64) {
        if let Some(position) = self.recency.iter().position(|value| *value == chunk_key) {
            self.recency.remove(position);
        }
        self.recency.push_back(chunk_key);
    }

    fn get(&mut self, chunk_key: u64) -> Option<Arc<ChunkSamples>> {
        let chunk = self.entries.get(&chunk_key).cloned();
        if chunk.is_some() {
            self.stats.hits = self.stats.hits.saturating_add(1);
            self.touch(chunk_key);
        } else {
            self.stats.misses = self.stats.misses.saturating_add(1);
        }
        chunk
    }

    fn insert(&mut self, chunk_key: u64, chunk: Arc<ChunkSamples>) {
        self.stats.decoded_chunks = self.stats.decoded_chunks.saturating_add(1);
        let chunk_bytes = chunk.byte_len();
        if chunk_bytes > self.stats.max_bytes {
            return;
        }
        if let Some(existing) = self.entries.remove(&chunk_key) {
            self.stats.resident_bytes = self
                .stats
                .resident_bytes
                .saturating_sub(existing.byte_len());
        }
        self.touch(chunk_key);
        self.stats.resident_bytes = self.stats.resident_bytes.saturating_add(chunk_bytes);
        self.entries.insert(chunk_key, chunk);
        while self.stats.resident_bytes > self.stats.max_bytes {
            let Some(evicted_index) = self.recency.pop_front() else {
                break;
            };
            if let Some(evicted) = self.entries.remove(&evicted_index) {
                self.stats.resident_bytes =
                    self.stats.resident_bytes.saturating_sub(evicted.byte_len());
                self.stats.evictions = self.stats.evictions.saturating_add(1);
            }
        }
    }
}

impl FileBackedDataset {
    pub fn cache_stats(&self) -> Result<FileCacheStats, DemError> {
        self.chunk_cache
            .lock()
            .map(|cache| cache.stats)
            .map_err(|_| DemError::InvalidData("GeoTIFF 分块缓存状态不可用".into()))
    }
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GeoMetadata {
    pub crs: Option<String>,
    pub crs_code: Option<u32>,
    pub crs_kind: Option<String>,
    pub crs_method: Option<String>,
    pub crs_wkt: Option<String>,
    pub geo_transform: Option<[f64; 6]>,
    pub geo_transform_method: Option<String>,
    pub bbox: Option<GeoBounds>,
    pub unit: String,
    pub projected_crs: Option<u32>,
    pub geographic_crs: Option<u32>,
    pub vertical_crs: Option<u32>,
    pub raster_type: Option<u16>,
    pub geo_keys: BTreeMap<String, Value>,
    pub source_geo_tiff_tags: Value,
    pub image_index: usize,
    pub image_count: usize,
    pub source_file: String,
    pub source_format: String,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub struct GeoBounds {
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SamplingOptions {
    pub max_dimension: usize,
    pub no_data_fill: String,
    pub smooth_steps: usize,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowSamplingOptions {
    pub source_x: usize,
    pub source_y: usize,
    pub source_width: usize,
    pub source_height: usize,
    #[serde(default)]
    pub output_width: Option<usize>,
    #[serde(default)]
    pub output_height: Option<usize>,
    #[serde(default)]
    pub max_dimension: Option<usize>,
    pub no_data_fill: String,
    pub smooth_steps: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct SampledTerrain {
    pub cols: usize,
    pub rows: usize,
    pub heights: Vec<f32>,
    pub valid_mask: Vec<u8>,
    pub engine: &'static str,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedGeoTiff {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
    pub geo_transform: [f64; 6],
    #[serde(default)]
    pub geo_key_directory: Vec<u16>,
    #[serde(default)]
    pub geo_double_params: Vec<f64>,
    pub geo_ascii_params: Option<String>,
    pub embed_crs: bool,
}

pub fn parse(name: &str, bytes: &[u8], companions: &[CoreFile]) -> Result<DemDataset, DemError> {
    let extension = name
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();

    match extension.as_str() {
        "asc" => parse_asc(name, bytes),
        "hgt" => parse_hgt(name, bytes),
        "tif" | "tiff" => parse_geotiff(name, bytes, companions),
        other => Err(DemError::UnsupportedFormat(other.to_string())),
    }
}

pub fn sample_dataset(
    dataset: &DemDataset,
    options: &SamplingOptions,
) -> Result<SampledTerrain, DemError> {
    sample_dataset_cancellable(dataset, options, None)
}

pub fn sample_dataset_cancellable(
    dataset: &DemDataset,
    options: &SamplingOptions,
    cancelled: Option<&AtomicBool>,
) -> Result<SampledTerrain, DemError> {
    check_cancelled(cancelled)?;
    let safe_max = options.max_dimension.clamp(2, 4096);
    let scale = (safe_max as f64 / dataset.width as f64)
        .min(safe_max as f64 / dataset.height as f64)
        .min(1.0);
    let cols = ((dataset.width as f64 * scale).round() as usize).max(2);
    let rows = ((dataset.height as f64 * scale).round() as usize).max(2);
    checked_cell_count(cols, rows)?;
    let range = (dataset.max - dataset.min).max(f64::EPSILON);
    let mut heights = vec![0.0f32; cols * rows];
    let mut valid_mask = vec![0u8; cols * rows];

    for y in 0..rows {
        check_cancelled(cancelled)?;
        let source_y_f =
            (y as f64 / (rows - 1) as f64) * (dataset.height - 1) as f64;
        let footprint_y = dataset.height as f64 / rows as f64;
        for x in 0..cols {
            let source_x_f =
                (x as f64 / (cols - 1) as f64) * (dataset.width - 1) as f64;
            let footprint_x = dataset.width as f64 / cols as f64;
            let source_x = source_x_f.round() as usize;
            let source_y = source_y_f.round() as usize;
            let value = filtered_memory_value(
                dataset,
                source_x_f,
                source_y_f,
                footprint_x,
                footprint_y,
            );
            valid_mask[y * cols + x] = u8::from(value.is_some());
            let normalized = match value {
                Some(value) => ((value - dataset.min) / range) as f32,
                None if options.no_data_fill == "middle" => 0.5,
                None if options.no_data_fill == "nearest" => {
                    nearest_height(dataset, source_x, source_y, range)
                }
                None => 0.0,
            };
            heights[y * cols + x] = normalized.clamp(0.0, 1.0);
        }
    }

    Ok(SampledTerrain {
        cols,
        rows,
        heights,
        valid_mask,
        engine: "rust-dem-core",
    })
}

pub fn sample_dataset_window(
    dataset: &DemDataset,
    options: &WindowSamplingOptions,
) -> Result<SampledTerrain, DemError> {
    sample_dataset_window_cancellable(dataset, options, None)
}

pub fn sample_dataset_window_cancellable(
    dataset: &DemDataset,
    options: &WindowSamplingOptions,
    cancelled: Option<&AtomicBool>,
) -> Result<SampledTerrain, DemError> {
    check_cancelled(cancelled)?;
    let (cols, rows) = validate_window_options(dataset.width, dataset.height, options)?;
    let range = (dataset.max - dataset.min).max(f64::EPSILON);
    let mut heights = vec![0.0f32; cols * rows];
    let mut valid_mask = vec![0u8; cols * rows];

    for y in 0..rows {
        check_cancelled(cancelled)?;
        let source_y_f =
            window_source_coordinate_f64(options.source_y, options.source_height, y, rows);
        let footprint_y = options.source_height as f64 / rows as f64;
        for x in 0..cols {
            let source_x_f =
                window_source_coordinate_f64(options.source_x, options.source_width, x, cols);
            let footprint_x = options.source_width as f64 / cols as f64;
            let source_x = source_x_f.round() as usize;
            let source_y = source_y_f.round() as usize;
            let value = filtered_memory_value(
                dataset,
                source_x_f,
                source_y_f,
                footprint_x,
                footprint_y,
            );
            valid_mask[y * cols + x] = u8::from(value.is_some());
            let normalized = match value {
                Some(value) => ((value - dataset.min) / range) as f32,
                None if options.no_data_fill == "middle" => 0.5,
                None if options.no_data_fill == "nearest" => {
                    nearest_height(dataset, source_x, source_y, range)
                }
                None => 0.0,
            };
            heights[y * cols + x] = normalized.clamp(0.0, 1.0);
        }
    }

    Ok(SampledTerrain {
        cols,
        rows,
        heights,
        valid_mask,
        engine: "rust-dem-core-window",
    })
}

fn sampled_terrain_from_raw(
    cols: usize,
    rows: usize,
    values: Vec<f64>,
    no_data: Option<f64>,
    minimum: f64,
    range: f64,
    engine: &'static str,
) -> SampledTerrain {
    let valid_mask = values
        .iter()
        .map(|value| u8::from(!is_nodata(*value, no_data)))
        .collect();
    let heights = values
        .into_iter()
        .map(|value| {
            if is_nodata(value, no_data) {
                0.0
            } else {
                (((value - minimum) / range) as f32).clamp(0.0, 1.0)
            }
        })
        .collect();
    SampledTerrain {
        cols,
        rows,
        heights,
        valid_mask,
        engine,
    }
}

fn read_embedded_display_overview<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    source_width: u32,
    source_height: u32,
    include_current_image: bool,
) -> Result<Option<(u32, u32, Vec<f64>)>, DemError> {
    let scale = (DISPLAY_OVERVIEW_SIDE as f64 / source_width as f64)
        .min(DISPLAY_OVERVIEW_SIDE as f64 / source_height as f64);
    let target_width = ((source_width as f64 * scale).round() as u32).max(2);
    let target_height = ((source_height as f64 * scale).round() as u32).max(2);
    let source_aspect = source_width as f64 / source_height.max(1) as f64;
    let mut candidates = Vec::new();
    let mut image_index = usize::from(!include_current_image);
    while decoder.seek_to_image(image_index).is_ok() {
        let (width, height) = decoder
            .dimensions()
            .map_err(|error| DemError::Tiff(error.to_string()))?;
        let aspect = width as f64 / height.max(1) as f64;
        let aspect_error = ((aspect / source_aspect) - 1.0).abs();
        if width >= 2
            && height >= 2
            && width <= MAX_EMBEDDED_OVERVIEW_SIDE
            && height <= MAX_EMBEDDED_OVERVIEW_SIDE
            && aspect_error <= 0.03
        {
            candidates.push((image_index, width, height));
        }
        image_index += 1;
    }
    let selected = candidates
        .iter()
        .filter(|(_, width, height)| *width >= target_width && *height >= target_height)
        .min_by_key(|(_, width, height)| u64::from(*width) * u64::from(*height))
        .or_else(|| {
            candidates
                .iter()
                .max_by_key(|(_, width, height)| u64::from(*width) * u64::from(*height))
        })
        .copied();
    let Some((selected_index, width, height)) = selected else {
        decoder
            .seek_to_image(0)
            .map_err(|error| DemError::Tiff(error.to_string()))?;
        return Ok(None);
    };
    decoder
        .seek_to_image(selected_index)
        .map_err(|error| DemError::Tiff(error.to_string()))?;
    let decoded = decoder
        .read_image()
        .map_err(|error| DemError::Tiff(error.to_string()))?;
    let all_values = decoding_result_to_f64(decoded);
    let pixel_count = width as usize * height as usize;
    if all_values.len() < pixel_count {
        return Err(DemError::InvalidData(format!(
            "GeoTIFF 内置概览样本不足：需要 {pixel_count}，实际 {}",
            all_values.len()
        )));
    }
    let samples_per_pixel = (all_values.len() / pixel_count.max(1)).max(1);
    let values = all_values
        .into_iter()
        .step_by(samples_per_pixel)
        .take(pixel_count)
        .collect::<Vec<_>>();
    decoder
        .seek_to_image(0)
        .map_err(|error| DemError::Tiff(error.to_string()))?;
    Ok(Some((width, height, values)))
}

fn appended_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = OsString::from(path.as_os_str());
    value.push(suffix);
    PathBuf::from(value)
}

fn companion_gdal_statistic(path: &Path, companions: &[CoreFile], name: &str) -> Option<f64> {
    let explicit = companions
        .iter()
        .filter(|file| file.name.to_ascii_lowercase().ends_with(".aux.xml"))
        .find_map(|file| {
            let metadata = String::from_utf8_lossy(&file.bytes);
            parse_gdal_pam_number(&metadata, name)
        });
    if explicit.is_some() {
        return explicit;
    }
    let aux_path = appended_sidecar_path(path, ".aux.xml");
    let metadata = std::fs::metadata(&aux_path).ok()?;
    if !metadata.is_file() || metadata.len() > MAX_AUX_XML_BYTES {
        return None;
    }
    let contents = std::fs::read_to_string(aux_path).ok()?;
    parse_gdal_pam_number(&contents, name)
}

fn parse_gdal_pam_number(metadata: &str, name: &str) -> Option<f64> {
    let marker = format!("key=\"{name}\"");
    let marker_index = metadata.find(&marker)?;
    let value_start = metadata[marker_index..].find('>')? + marker_index + 1;
    let value_end = metadata[value_start..].find('<')? + value_start;
    metadata[value_start..value_end]
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn companion_display_overview(
    path: &Path,
    companions: &[CoreFile],
    source_width: u32,
    source_height: u32,
) -> Result<Option<(u32, u32, Vec<f64>)>, DemError> {
    if let Some(file) = companions
        .iter()
        .find(|file| file.name.to_ascii_lowercase().ends_with(".ovr"))
    {
        let Ok(mut decoder) = Decoder::new(Cursor::new(file.bytes.as_slice())) else {
            return Ok(None);
        };
        return Ok(
            read_embedded_display_overview(&mut decoder, source_width, source_height, true)
                .unwrap_or(None),
        );
    }
    let overview_path = appended_sidecar_path(path, ".ovr");
    if !overview_path.is_file() {
        return Ok(None);
    }
    let Ok(file) = File::open(&overview_path) else {
        return Ok(None);
    };
    let Ok(mut decoder) = Decoder::new(BufReader::new(file)) else {
        return Ok(None);
    };
    Ok(
        read_embedded_display_overview(&mut decoder, source_width, source_height, true)
            .unwrap_or(None),
    )
}

fn discover_external_overview_sources(
    path: &Path,
    source_width: u32,
    source_height: u32,
) -> Vec<FileRasterSource> {
    let overview_path = appended_sidecar_path(path, ".ovr");
    let Ok(file) = File::open(&overview_path) else {
        return Vec::new();
    };
    let Ok(mut decoder) = Decoder::new(BufReader::new(file)) else {
        return Vec::new();
    };
    let source_aspect = source_width as f64 / source_height.max(1) as f64;
    let mut sources = Vec::new();
    let mut image_index = 0usize;
    while decoder.seek_to_image(image_index).is_ok() {
        let Ok((width, height)) = decoder.dimensions() else {
            break;
        };
        let aspect = width as f64 / height.max(1) as f64;
        let aspect_error = ((aspect / source_aspect) - 1.0).abs();
        if width >= 2
            && height >= 2
            && width < source_width
            && height < source_height
            && aspect_error <= 0.03
        {
            sources.push(FileRasterSource {
                path: overview_path.clone(),
                image_index,
                width: width as usize,
                height: height as usize,
                cache_namespace: u32::try_from(image_index)
                    .unwrap_or(u32::MAX - 1)
                    .saturating_add(1),
            });
        }
        image_index += 1;
    }
    sources.sort_by_key(|source| source.width.saturating_mul(source.height));
    sources
}

fn mapped_window_sample_span(
    source_length: usize,
    source_dimension: usize,
    raster_dimension: usize,
) -> f64 {
    if source_dimension <= 1 || raster_dimension <= 1 || source_length <= 1 {
        return 1.0;
    }
    let scale = (raster_dimension - 1) as f64 / (source_dimension - 1) as f64;
    (source_length - 1) as f64 * scale + 1.0
}

fn select_window_raster_source(
    dataset: &FileBackedDataset,
    options: &WindowSamplingOptions,
    cols: usize,
    rows: usize,
) -> FileRasterSource {
    dataset
        .overview_sources
        .iter()
        .filter(|source| {
            mapped_window_sample_span(
                options.source_width,
                dataset.metadata.width,
                source.width,
            ) >= cols as f64
                && mapped_window_sample_span(
                    options.source_height,
                    dataset.metadata.height,
                    source.height,
                ) >= rows as f64
        })
        .min_by_key(|source| source.width.saturating_mul(source.height))
        .cloned()
        .unwrap_or_else(|| FileRasterSource {
            path: dataset.path.clone(),
            image_index: 0,
            width: dataset.metadata.width,
            height: dataset.metadata.height,
            cache_namespace: 0,
        })
}

fn main_raster_source(dataset: &FileBackedDataset) -> FileRasterSource {
    FileRasterSource {
        path: dataset.path.clone(),
        image_index: 0,
        width: dataset.metadata.width,
        height: dataset.metadata.height,
        cache_namespace: 0,
    }
}

fn open_raster_decoder(
    source: &FileRasterSource,
) -> Result<Decoder<BufReader<File>>, DemError> {
    let file = File::open(&source.path)
        .map_err(|error| DemError::InvalidData(format!("无法打开 GeoTIFF 栅格源：{error}")))?;
    let mut decoder =
        Decoder::new(BufReader::new(file)).map_err(|error| DemError::Tiff(error.to_string()))?;
    decoder
        .seek_to_image(source.image_index)
        .map_err(|error| DemError::Tiff(error.to_string()))?;
    let dimensions = decoder
        .dimensions()
        .map_err(|error| DemError::Tiff(error.to_string()))?;
    if dimensions != (source.width as u32, source.height as u32) {
        return Err(DemError::InvalidData(format!(
            "GeoTIFF 栅格源尺寸已变化：预期 {} × {}，实际 {} × {}",
            source.width, source.height, dimensions.0, dimensions.1
        )));
    }
    Ok(decoder)
}

fn map_source_coordinate(value: f64, source_dimension: usize, raster_dimension: usize) -> f64 {
    if source_dimension <= 1 || raster_dimension <= 1 {
        return 0.0;
    }
    value * (raster_dimension - 1) as f64 / (source_dimension - 1) as f64
}

pub fn open_geotiff_path(
    path: &Path,
    name: &str,
    companions: &[CoreFile],
) -> Result<FileBackedDataset, DemError> {
    let file = File::open(path)
        .map_err(|error| DemError::InvalidData(format!("无法打开 GeoTIFF：{error}")))?;
    let mut decoder =
        Decoder::new(BufReader::new(file)).map_err(|error| DemError::Tiff(error.to_string()))?;
    let header = read_geotiff_header(name, &mut decoder, companions)?;
    checked_file_backed_cell_count(header.width, header.height)?;

    let chunk_count = spatial_chunk_count(&mut decoder, header.width, header.height)?;
    let (chunk_width, chunk_height) = decoder.chunk_dimensions();
    let chunks_across = header.width.div_ceil(chunk_width);
    let chunks_down = header.height.div_ceil(chunk_height);
    let stats_cols = chunks_across.clamp(1, MAX_STATS_GRID_SIDE);
    let stats_rows = chunks_down.clamp(1, MAX_STATS_GRID_SIDE);
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut no_data_count = 0usize;
    let stats_chunk_count = (stats_cols * stats_rows).min(MAX_STATS_CHUNKS);
    let mut sampled_pixels = 0usize;
    let mut overview_raw = Vec::with_capacity(stats_chunk_count as usize);
    for overview_y in 0..stats_rows {
        let chunk_y = if stats_rows <= 1 {
            0
        } else {
            overview_y * (chunks_down - 1) / (stats_rows - 1)
        };
        for overview_x in 0..stats_cols {
            let chunk_x = if stats_cols <= 1 {
                0
            } else {
                overview_x * (chunks_across - 1) / (stats_cols - 1)
            };
            let chunk_index = chunk_y * chunks_across + chunk_x;
            let (data_width, data_height) = decoder.chunk_data_dimensions(chunk_index);
            let pixel_count = data_width as usize * data_height as usize;
            sampled_pixels += pixel_count;
            let decoded = decoder
                .read_chunk(chunk_index)
                .map_err(|error| DemError::Tiff(error.to_string()))?;
            let values = decoding_result_to_f64(decoded);
            let samples_per_pixel = (values.len() / pixel_count.max(1)).max(1);
            let center_index = ((data_height as usize / 2) * data_width as usize
                + data_width as usize / 2)
                * samples_per_pixel;
            let center = values.get(center_index).copied().unwrap_or(f64::NAN);
            overview_raw.push(center);
            for value in values
                .into_iter()
                .step_by(samples_per_pixel)
                .take(pixel_count)
            {
                if is_nodata(value, header.no_data) {
                    no_data_count += 1;
                } else {
                    min = min.min(value);
                    max = max.max(value);
                }
            }
        }
    }
    let display_overview =
        companion_display_overview(path, companions, header.width, header.height)?.or(
            read_embedded_display_overview(&mut decoder, header.width, header.height, false)?,
        );
    let trusted_minimum = companion_gdal_statistic(path, companions, "STATISTICS_MINIMUM")
        .or(header.statistics_minimum);
    let trusted_maximum = companion_gdal_statistic(path, companions, "STATISTICS_MAXIMUM")
        .or(header.statistics_maximum);
    if let (Some(stat_min), Some(stat_max)) = (trusted_minimum, trusted_maximum) {
        if stat_min.is_finite() && stat_max.is_finite() && stat_max > stat_min {
            min = stat_min;
            max = stat_max;
        }
    }
    if (!min.is_finite() || !max.is_finite()) && display_overview.is_some() {
        for value in display_overview
            .as_ref()
            .into_iter()
            .flat_map(|(_, _, values)| values.iter().copied())
        {
            if !is_nodata(value, header.no_data) {
                min = min.min(value);
                max = max.max(value);
            }
        }
    }
    if !min.is_finite() || !max.is_finite() {
        return Err(DemError::InvalidData("没有检测到有效高程值".into()));
    }
    let total_pixels = u64::from(header.width) * u64::from(header.height);
    let estimated_no_data_count = if let Some((_, _, values)) = display_overview.as_ref() {
        let invalid = values
            .iter()
            .filter(|value| is_nodata(**value, header.no_data))
            .count();
        ((invalid as f64 / values.len().max(1) as f64) * total_pixels as f64)
            .round()
            .min(total_pixels as f64) as usize
    } else if sampled_pixels == 0 {
        0
    } else {
        ((no_data_count as f64 / sampled_pixels as f64) * total_pixels as f64)
            .round()
            .min(total_pixels as f64) as usize
    };
    let range = (max - min).max(f64::EPSILON);
    let overview = if let Some((cols, rows, values)) = display_overview {
        sampled_terrain_from_raw(
            cols as usize,
            rows as usize,
            values,
            header.no_data,
            min,
            range,
            "rust-dem-core-v2-pyramid-overview",
        )
    } else {
        sampled_terrain_from_raw(
            stats_cols as usize,
            stats_rows as usize,
            overview_raw,
            header.no_data,
            min,
            range,
            "rust-dem-core-v2-stats-fallback",
        )
    };
    let overview_sources =
        discover_external_overview_sources(path, header.width, header.height);

    Ok(FileBackedDataset {
        metadata: DemDataset {
            name: name.to_string(),
            dataset_type: "GeoTIFF".into(),
            width: header.width as usize,
            height: header.height as usize,
            data: Vec::new(),
            no_data: header.no_data,
            min,
            max,
            no_data_count: estimated_no_data_count,
            statistics_approximate: chunk_count > stats_chunk_count,
            geo: Some(header.geo),
            engine: "rust-dem-core-v2",
        },
        path: path.to_path_buf(),
        overview,
        overview_sources: Arc::new(overview_sources),
        chunk_cache: Arc::new(Mutex::new(ChunkCache::new(DEFAULT_CHUNK_CACHE_BYTES))),
    })
}

pub fn sample_file_dataset(
    dataset: &FileBackedDataset,
    options: &SamplingOptions,
) -> Result<SampledTerrain, DemError> {
    sample_file_dataset_cancellable(dataset, options, None)
}

pub fn sample_file_dataset_cancellable(
    dataset: &FileBackedDataset,
    options: &SamplingOptions,
    cancelled: Option<&AtomicBool>,
) -> Result<SampledTerrain, DemError> {
    check_cancelled(cancelled)?;
    let safe_max = options.max_dimension.clamp(2, 4096);
    let width = dataset.metadata.width;
    let height = dataset.metadata.height;
    let scale = (safe_max as f64 / width as f64)
        .min(safe_max as f64 / height as f64)
        .min(1.0);
    let cols = ((width as f64 * scale).round() as usize).max(2);
    let rows = ((height as f64 * scale).round() as usize).max(2);
    checked_cell_count(cols, rows)?;

    let file = File::open(&dataset.path)
        .map_err(|error| DemError::InvalidData(format!("无法重新打开 GeoTIFF：{error}")))?;
    let mut decoder =
        Decoder::new(BufReader::new(file)).map_err(|error| DemError::Tiff(error.to_string()))?;
    let (chunk_width, chunk_height) = decoder.chunk_dimensions();
    let chunks_across = dataset.metadata.width.div_ceil(chunk_width as usize);
    let spatial_chunks = spatial_chunk_count(
        &mut decoder,
        dataset.metadata.width as u32,
        dataset.metadata.height as u32,
    )?;
    let mut cache = HashMap::<u64, Arc<ChunkSamples>>::new();
    let mut active_chunk_row = usize::MAX;
    let range = (dataset.metadata.max - dataset.metadata.min).max(f64::EPSILON);
    let mut heights = vec![0.0f32; cols * rows];
    let mut valid_mask = vec![0u8; cols * rows];

    for y in 0..rows {
        check_cancelled(cancelled)?;
        let source_y_f =
            (y as f64 / (rows - 1) as f64) * (dataset.metadata.height - 1) as f64;
        let source_y = source_y_f.round() as usize;
        let footprint_y = dataset.metadata.height as f64 / rows as f64;
        let chunk_row = source_y / chunk_height as usize;
        if chunk_row != active_chunk_row {
            cache.clear();
            active_chunk_row = chunk_row;
        }
        for x in 0..cols {
            let source_x_f =
                (x as f64 / (cols - 1) as f64) * (dataset.metadata.width - 1) as f64;
            let source_x = source_x_f.round() as usize;
            let footprint_x = dataset.metadata.width as f64 / cols as f64;
            let value = read_filtered_file_value(
                &mut decoder,
                dataset,
                &mut cache,
                0,
                dataset.metadata.width,
                dataset.metadata.height,
                source_x_f,
                source_y_f,
                footprint_x,
                footprint_y,
                chunk_width as usize,
                chunk_height as usize,
                chunks_across,
                spatial_chunks,
                cancelled,
            )?;
            valid_mask[y * cols + x] = u8::from(!is_nodata(value, dataset.metadata.no_data));
            let normalized = if !is_nodata(value, dataset.metadata.no_data) {
                ((value - dataset.metadata.min) / range) as f32
            } else if options.no_data_fill == "middle" {
                0.5
            } else if options.no_data_fill == "nearest" {
                nearest_file_height(
                    &mut decoder,
                    &mut cache,
                    dataset,
                    0,
                    dataset.metadata.width,
                    dataset.metadata.height,
                    source_x,
                    source_y,
                    chunk_width as usize,
                    chunk_height as usize,
                    chunks_across,
                    spatial_chunks,
                    range,
                    cancelled,
                )?
            } else {
                0.0
            };
            heights[y * cols + x] = normalized.clamp(0.0, 1.0);
        }
    }

    Ok(SampledTerrain {
        cols,
        rows,
        heights,
        valid_mask,
        engine: "rust-dem-core-v2",
    })
}

pub fn sample_file_window(
    dataset: &FileBackedDataset,
    options: &WindowSamplingOptions,
) -> Result<SampledTerrain, DemError> {
    sample_file_window_cancellable(dataset, options, None)
}

pub fn sample_file_window_cancellable(
    dataset: &FileBackedDataset,
    options: &WindowSamplingOptions,
    cancelled: Option<&AtomicBool>,
) -> Result<SampledTerrain, DemError> {
    check_cancelled(cancelled)?;
    let (cols, rows) =
        validate_window_options(dataset.metadata.width, dataset.metadata.height, options)?;
    let selected_source = select_window_raster_source(dataset, options, cols, rows);
    let (raster_source, mut decoder) = match open_raster_decoder(&selected_source) {
        Ok(decoder) => (selected_source, decoder),
        Err(_) if selected_source.cache_namespace != 0 => {
            let fallback = main_raster_source(dataset);
            let decoder = open_raster_decoder(&fallback)?;
            (fallback, decoder)
        }
        Err(error) => return Err(error),
    };
    let (chunk_width, chunk_height) = decoder.chunk_dimensions();
    let chunks_across = raster_source.width.div_ceil(chunk_width as usize);
    let spatial_chunks = spatial_chunk_count(
        &mut decoder,
        raster_source.width as u32,
        raster_source.height as u32,
    )?;
    let mut cache = HashMap::<u64, Arc<ChunkSamples>>::new();
    let range = (dataset.metadata.max - dataset.metadata.min).max(f64::EPSILON);
    let mut heights = vec![0.0f32; cols * rows];
    let mut valid_mask = vec![0u8; cols * rows];
    let scale_x = if dataset.metadata.width <= 1 {
        0.0
    } else {
        (raster_source.width - 1) as f64 / (dataset.metadata.width - 1) as f64
    };
    let scale_y = if dataset.metadata.height <= 1 {
        0.0
    } else {
        (raster_source.height - 1) as f64 / (dataset.metadata.height - 1) as f64
    };

    for y in 0..rows {
        check_cancelled(cancelled)?;
        let main_source_y_f =
            window_source_coordinate_f64(options.source_y, options.source_height, y, rows);
        let source_y_f = map_source_coordinate(
            main_source_y_f,
            dataset.metadata.height,
            raster_source.height,
        );
        let source_y = source_y_f.round() as usize;
        let footprint_y = (options.source_height as f64 / rows as f64) * scale_y;
        for x in 0..cols {
            let main_source_x_f =
                window_source_coordinate_f64(options.source_x, options.source_width, x, cols);
            let source_x_f = map_source_coordinate(
                main_source_x_f,
                dataset.metadata.width,
                raster_source.width,
            );
            let source_x = source_x_f.round() as usize;
            let footprint_x = (options.source_width as f64 / cols as f64) * scale_x;
            let value = read_filtered_file_value(
                &mut decoder,
                dataset,
                &mut cache,
                raster_source.cache_namespace,
                raster_source.width,
                raster_source.height,
                source_x_f,
                source_y_f,
                footprint_x,
                footprint_y,
                chunk_width as usize,
                chunk_height as usize,
                chunks_across,
                spatial_chunks,
                cancelled,
            )?;
            valid_mask[y * cols + x] = u8::from(!is_nodata(value, dataset.metadata.no_data));
            let normalized = if !is_nodata(value, dataset.metadata.no_data) {
                ((value - dataset.metadata.min) / range) as f32
            } else if options.no_data_fill == "middle" {
                0.5
            } else if options.no_data_fill == "nearest" {
                nearest_file_height(
                    &mut decoder,
                    &mut cache,
                    dataset,
                    raster_source.cache_namespace,
                    raster_source.width,
                    raster_source.height,
                    source_x,
                    source_y,
                    chunk_width as usize,
                    chunk_height as usize,
                    chunks_across,
                    spatial_chunks,
                    range,
                    cancelled,
                )?
            } else {
                0.0
            };
            heights[y * cols + x] = normalized.clamp(0.0, 1.0);
        }
    }

    Ok(SampledTerrain {
        cols,
        rows,
        heights,
        valid_mask,
        engine: "rust-dem-core-v2-window",
    })
}

fn validate_window_options(
    dataset_width: usize,
    dataset_height: usize,
    options: &WindowSamplingOptions,
) -> Result<(usize, usize), DemError> {
    if options.source_width == 0 || options.source_height == 0 {
        return Err(DemError::InvalidData("DEM 源窗口宽高必须大于 0".into()));
    }
    let source_right = options
        .source_x
        .checked_add(options.source_width)
        .ok_or_else(|| DemError::InvalidData("DEM 源窗口横向范围溢出".into()))?;
    let source_bottom = options
        .source_y
        .checked_add(options.source_height)
        .ok_or_else(|| DemError::InvalidData("DEM 源窗口纵向范围溢出".into()))?;
    if source_right > dataset_width || source_bottom > dataset_height {
        return Err(DemError::InvalidData(format!(
            "DEM 源窗口越界：数据集 {dataset_width}x{dataset_height}，窗口 ({}, {}) {}x{}",
            options.source_x, options.source_y, options.source_width, options.source_height
        )));
    }

    let dimensions = match (options.output_width, options.output_height) {
        (Some(cols), Some(rows)) => (cols.clamp(2, 4096), rows.clamp(2, 4096)),
        (None, None) => {
            let safe_max = options.max_dimension.unwrap_or(512).clamp(2, 4096);
            let scale = (safe_max as f64 / options.source_width as f64)
                .min(safe_max as f64 / options.source_height as f64)
                .min(1.0);
            (
                ((options.source_width as f64 * scale).round() as usize).max(2),
                ((options.source_height as f64 * scale).round() as usize).max(2),
            )
        }
        _ => return Err(DemError::InvalidData("DEM 窗口输出宽高必须同时提供".into())),
    };
    checked_cell_count(dimensions.0, dimensions.1)?;
    Ok(dimensions)
}

fn window_source_coordinate_f64(
    source_offset: usize,
    source_length: usize,
    output_index: usize,
    output_length: usize,
) -> f64 {
    source_offset as f64
        + (output_index as f64 / (output_length - 1) as f64) * (source_length - 1) as f64
}

fn anti_alias_taps(footprint: f64) -> usize {
    if footprint <= 1.25 {
        1
    } else {
        // Preserve exact cell coverage for common LOD ratios; an odd cap avoids
        // phase-locking to checker/stripe patterns at very large ratios.
        footprint.ceil().clamp(2.0, 9.0) as usize
    }
}

fn filtered_memory_value(
    dataset: &DemDataset,
    center_x: f64,
    center_y: f64,
    footprint_x: f64,
    footprint_y: f64,
) -> Option<f64> {
    let taps_x = anti_alias_taps(footprint_x);
    let taps_y = anti_alias_taps(footprint_y);
    let mut sum = 0.0f64;
    let mut count = 0usize;
    let mut sampled_coordinates = Vec::with_capacity(taps_x * taps_y);
    for tap_y in 0..taps_y {
        let sample_y = if taps_y == 1 {
            center_y
        } else {
            center_y - footprint_y * 0.5
                + footprint_y * (tap_y as f64 + 0.5) / taps_y as f64
        };
        let y = sample_y
            .round()
            .clamp(0.0, dataset.height.saturating_sub(1) as f64) as usize;
        for tap_x in 0..taps_x {
            let sample_x = if taps_x == 1 {
                center_x
            } else {
                center_x - footprint_x * 0.5
                    + footprint_x * (tap_x as f64 + 0.5) / taps_x as f64
            };
            let x = sample_x
                .round()
                .clamp(0.0, dataset.width.saturating_sub(1) as f64) as usize;
            if sampled_coordinates.contains(&(x, y)) {
                continue;
            }
            sampled_coordinates.push((x, y));
            if let Some(value) = dataset.data[y * dataset.width + x] {
                sum += value;
                count += 1;
            }
        }
    }
    (count > 0).then_some(sum / count as f64)
}

pub fn sample_file_overview(
    dataset: &FileBackedDataset,
    options: &SamplingOptions,
) -> Result<SampledTerrain, DemError> {
    sample_file_overview_cancellable(dataset, options, None)
}

pub fn sample_file_overview_cancellable(
    dataset: &FileBackedDataset,
    options: &SamplingOptions,
    cancelled: Option<&AtomicBool>,
) -> Result<SampledTerrain, DemError> {
    check_cancelled(cancelled)?;
    if dataset.overview.cols < 2
        || dataset.overview.rows < 2
        || dataset.metadata.width <= 4096 && dataset.metadata.height <= 4096
    {
        return sample_file_dataset_cancellable(dataset, options, cancelled);
    }
    let max_dimension = options.max_dimension.clamp(2, 128);
    let scale = (max_dimension as f64 / dataset.metadata.width as f64)
        .min(max_dimension as f64 / dataset.metadata.height as f64);
    let cols = ((dataset.metadata.width as f64 * scale).round() as usize).max(2);
    let rows = ((dataset.metadata.height as f64 * scale).round() as usize).max(2);
    let valid_mask = resample_mask(
        &dataset.overview.valid_mask,
        dataset.overview.cols,
        dataset.overview.rows,
        cols,
        rows,
    );
    let heights = resample_heights(
        &dataset.overview.heights,
        &dataset.overview.valid_mask,
        dataset.overview.cols,
        dataset.overview.rows,
        cols,
        rows,
    );
    let sampled = SampledTerrain {
        cols,
        rows,
        heights,
        valid_mask,
        engine: dataset.overview.engine,
    };
    trim_process_working_set_after_overview();
    Ok(sampled)
}

fn resample_heights(
    source: &[f32],
    valid_mask: &[u8],
    source_cols: usize,
    source_rows: usize,
    cols: usize,
    rows: usize,
) -> Vec<f32> {
    let mut output = vec![0.0; cols * rows];
    for y in 0..rows {
        let source_y = y as f64 * (source_rows - 1) as f64 / (rows - 1) as f64;
        let y0 = source_y.floor() as usize;
        let y1 = (y0 + 1).min(source_rows - 1);
        let fy = (source_y - y0 as f64) as f32;
        for x in 0..cols {
            let source_x = x as f64 * (source_cols - 1) as f64 / (cols - 1) as f64;
            let x0 = source_x.floor() as usize;
            let x1 = (x0 + 1).min(source_cols - 1);
            let fx = (source_x - x0 as f64) as f32;
            let samples = [
                (y0 * source_cols + x0, (1.0 - fx) * (1.0 - fy)),
                (y0 * source_cols + x1, fx * (1.0 - fy)),
                (y1 * source_cols + x0, (1.0 - fx) * fy),
                (y1 * source_cols + x1, fx * fy),
            ];
            let mut weighted_sum = 0.0f32;
            let mut weight_sum = 0.0f32;
            for (index, weight) in samples {
                if valid_mask.get(index).copied().unwrap_or(0) != 0 {
                    weighted_sum += source[index] * weight;
                    weight_sum += weight;
                }
            }
            output[y * cols + x] = if weight_sum > f32::EPSILON {
                weighted_sum / weight_sum
            } else {
                0.0
            };
        }
    }
    output
}

fn resample_mask(
    source: &[u8],
    source_cols: usize,
    source_rows: usize,
    cols: usize,
    rows: usize,
) -> Vec<u8> {
    let mut output = vec![0u8; cols * rows];
    if source.len() != source_cols.saturating_mul(source_rows)
        || source_cols == 0
        || source_rows == 0
    {
        output.fill(1);
        return output;
    }
    for y in 0..rows {
        let source_y = if rows <= 1 {
            0
        } else {
            ((y as f64 / (rows - 1) as f64) * (source_rows - 1) as f64).round() as usize
        };
        for x in 0..cols {
            let source_x = if cols <= 1 {
                0
            } else {
                ((x as f64 / (cols - 1) as f64) * (source_cols - 1) as f64).round() as usize
            };
            output[y * cols + x] = source[source_y * source_cols + source_x];
        }
    }
    output
}

#[derive(Debug)]
struct ChunkSamples {
    width: usize,
    height: usize,
    values: Vec<f64>,
    samples_per_pixel: usize,
}

impl ChunkSamples {
    fn byte_len(&self) -> usize {
        self.values.len().saturating_mul(std::mem::size_of::<f64>())
    }
}

fn spatial_chunk_count<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    width: u32,
    height: u32,
) -> Result<u32, DemError> {
    let (chunk_width, chunk_height) = decoder.chunk_dimensions();
    let across = width.div_ceil(chunk_width);
    let down = height.div_ceil(chunk_height);
    let spatial = across
        .checked_mul(down)
        .ok_or_else(|| DemError::InvalidData("GeoTIFF 分块数量溢出".into()))?;
    let available = match decoder.get_chunk_type() {
        ChunkType::Strip => decoder.strip_count(),
        ChunkType::Tile => decoder.tile_count(),
    }
    .map_err(|error| DemError::Tiff(error.to_string()))?;
    if available < spatial {
        return Err(DemError::InvalidData(format!(
            "GeoTIFF 分块不足：需要 {spatial}，实际 {available}"
        )));
    }
    Ok(spatial)
}

#[allow(clippy::too_many_arguments)]
fn read_file_value<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    dataset: &FileBackedDataset,
    cache: &mut HashMap<u64, Arc<ChunkSamples>>,
    cache_namespace: u32,
    x: usize,
    y: usize,
    chunk_width: usize,
    chunk_height: usize,
    chunks_across: usize,
    spatial_chunks: u32,
    cancelled: Option<&AtomicBool>,
) -> Result<f64, DemError> {
    check_cancelled(cancelled)?;
    let chunk_index = ((y / chunk_height) * chunks_across + (x / chunk_width)) as u32;
    if chunk_index >= spatial_chunks {
        return Err(DemError::InvalidData("GeoTIFF 分块索引越界".into()));
    }
    let chunk_key = (u64::from(cache_namespace) << 32) | u64::from(chunk_index);
    if let std::collections::hash_map::Entry::Vacant(entry) = cache.entry(chunk_key) {
        let cached = dataset
            .chunk_cache
            .lock()
            .map_err(|_| DemError::InvalidData("GeoTIFF 分块缓存状态不可用".into()))?
            .get(chunk_key);
        let chunk = if let Some(cached) = cached {
            cached
        } else {
            check_cancelled(cancelled)?;
            let (width, height) = decoder.chunk_data_dimensions(chunk_index);
            let pixel_count = width as usize * height as usize;
            let decoded = decoder
                .read_chunk(chunk_index)
                .map_err(|error| DemError::Tiff(error.to_string()))?;
            check_cancelled(cancelled)?;
            let values = decoding_result_to_f64(decoded);
            let samples_per_pixel = (values.len() / pixel_count.max(1)).max(1);
            let chunk = Arc::new(ChunkSamples {
                width: width as usize,
                height: height as usize,
                values,
                samples_per_pixel,
            });
            dataset
                .chunk_cache
                .lock()
                .map_err(|_| DemError::InvalidData("GeoTIFF 分块缓存状态不可用".into()))?
                .insert(chunk_key, Arc::clone(&chunk));
            chunk
        };
        entry.insert(chunk);
    }
    let chunk = cache
        .get(&chunk_key)
        .ok_or_else(|| DemError::InvalidData("GeoTIFF 分块缓存不可用".into()))?;
    let local_x = x % chunk_width;
    let local_y = y % chunk_height;
    if local_x >= chunk.width || local_y >= chunk.height {
        return Err(DemError::InvalidData("GeoTIFF 分块像元索引越界".into()));
    }
    let index = (local_y * chunk.width + local_x) * chunk.samples_per_pixel;
    chunk
        .values
        .get(index)
        .copied()
        .ok_or_else(|| DemError::InvalidData("GeoTIFF 分块样本不足".into()))
}

#[allow(clippy::too_many_arguments)]
fn read_filtered_file_value<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    dataset: &FileBackedDataset,
    cache: &mut HashMap<u64, Arc<ChunkSamples>>,
    cache_namespace: u32,
    raster_width: usize,
    raster_height: usize,
    center_x: f64,
    center_y: f64,
    footprint_x: f64,
    footprint_y: f64,
    chunk_width: usize,
    chunk_height: usize,
    chunks_across: usize,
    spatial_chunks: u32,
    cancelled: Option<&AtomicBool>,
) -> Result<f64, DemError> {
    let taps_x = anti_alias_taps(footprint_x);
    let taps_y = anti_alias_taps(footprint_y);
    let mut sum = 0.0f64;
    let mut count = 0usize;
    let mut sampled_coordinates = Vec::with_capacity(taps_x * taps_y);
    for tap_y in 0..taps_y {
        let sample_y = if taps_y == 1 {
            center_y
        } else {
            center_y - footprint_y * 0.5
                + footprint_y * (tap_y as f64 + 0.5) / taps_y as f64
        };
        let y = sample_y
            .round()
            .clamp(0.0, raster_height.saturating_sub(1) as f64)
            as usize;
        for tap_x in 0..taps_x {
            let sample_x = if taps_x == 1 {
                center_x
            } else {
                center_x - footprint_x * 0.5
                    + footprint_x * (tap_x as f64 + 0.5) / taps_x as f64
            };
            let x = sample_x
                .round()
                .clamp(0.0, raster_width.saturating_sub(1) as f64)
                as usize;
            if sampled_coordinates.contains(&(x, y)) {
                continue;
            }
            sampled_coordinates.push((x, y));
            let value = read_file_value(
                decoder,
                dataset,
                cache,
                cache_namespace,
                x,
                y,
                chunk_width,
                chunk_height,
                chunks_across,
                spatial_chunks,
                cancelled,
            )?;
            if !is_nodata(value, dataset.metadata.no_data) {
                sum += value;
                count += 1;
            }
        }
    }
    Ok(if count > 0 {
        sum / count as f64
    } else {
        dataset.metadata.no_data.unwrap_or(f64::NAN)
    })
}

#[allow(clippy::too_many_arguments)]
fn nearest_file_height<R: Read + Seek>(
    decoder: &mut Decoder<R>,
    cache: &mut HashMap<u64, Arc<ChunkSamples>>,
    dataset: &FileBackedDataset,
    cache_namespace: u32,
    raster_width: usize,
    raster_height: usize,
    source_x: usize,
    source_y: usize,
    chunk_width: usize,
    chunk_height: usize,
    chunks_across: usize,
    spatial_chunks: u32,
    range: f64,
    cancelled: Option<&AtomicBool>,
) -> Result<f32, DemError> {
    for radius in 1..=16isize {
        check_cancelled(cancelled)?;
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                let x = source_x as isize + dx;
                let y = source_y as isize + dy;
                if x < 0
                    || y < 0
                    || x >= raster_width as isize
                    || y >= raster_height as isize
                {
                    continue;
                }
                let value = read_file_value(
                    decoder,
                    dataset,
                    cache,
                    cache_namespace,
                    x as usize,
                    y as usize,
                    chunk_width,
                    chunk_height,
                    chunks_across,
                    spatial_chunks,
                    cancelled,
                )?;
                if !is_nodata(value, dataset.metadata.no_data) {
                    return Ok((((value - dataset.metadata.min) / range) as f32).clamp(0.0, 1.0));
                }
            }
        }
    }
    Ok(0.0)
}

fn check_cancelled(cancelled: Option<&AtomicBool>) -> Result<(), DemError> {
    if cancelled
        .map(|flag| flag.load(Ordering::Relaxed))
        .unwrap_or(false)
    {
        Err(DemError::Cancelled)
    } else {
        Ok(())
    }
}

fn is_nodata(value: f64, no_data: Option<f64>) -> bool {
    !value.is_finite()
        || no_data
            .map(|sentinel| (value - sentinel).abs() < 1e-8)
            .unwrap_or(false)
}

fn checked_file_backed_cell_count(width: u32, height: u32) -> Result<u64, DemError> {
    let count = u64::from(width)
        .checked_mul(u64::from(height))
        .ok_or_else(|| DemError::InvalidData("栅格尺寸溢出".into()))?;
    if count == 0 || count > MAX_FILE_BACKED_CELL_COUNT {
        return Err(DemError::InvalidData(format!(
            "文件后备栅格单元数量超出限制：{count}"
        )));
    }
    Ok(count)
}

pub fn encode_rendered_geotiff(request: &RenderedGeoTiff) -> Result<Vec<u8>, DemError> {
    let pixel_count = checked_cell_count(request.width as usize, request.height as usize)?;
    if request.rgba.len() != pixel_count * 4 {
        return Err(DemError::InvalidData(format!(
            "RGBA 像素数量无效：需要 {}，实际 {}",
            pixel_count * 4,
            request.rgba.len()
        )));
    }

    let [x0, px, rx, y0, ry, py] = request.geo_transform;
    if !request.geo_transform.iter().all(|value| value.is_finite()) {
        return Err(DemError::InvalidData("GeoTIFF 地理变换无效".into()));
    }
    let model_transformation = [
        px, rx, 0.0, x0, ry, py, 0.0, y0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
    ];

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut encoder =
            TiffEncoder::new(&mut cursor).map_err(|error| DemError::Tiff(error.to_string()))?;
        let mut image = encoder
            .new_image::<RGBA8>(request.width, request.height)
            .map_err(|error| DemError::Tiff(error.to_string()))?;
        image
            .encoder()
            .write_tag(Tag::Software, "DEM Studio Rust Core")
            .map_err(|error| DemError::Tiff(error.to_string()))?;
        image
            .encoder()
            .write_tag(Tag::ModelTransformationTag, model_transformation.as_slice())
            .map_err(|error| DemError::Tiff(error.to_string()))?;
        if request.embed_crs {
            if !request.geo_key_directory.is_empty() {
                image
                    .encoder()
                    .write_tag(
                        Tag::GeoKeyDirectoryTag,
                        request.geo_key_directory.as_slice(),
                    )
                    .map_err(|error| DemError::Tiff(error.to_string()))?;
            }
            if !request.geo_double_params.is_empty() {
                image
                    .encoder()
                    .write_tag(
                        Tag::GeoDoubleParamsTag,
                        request.geo_double_params.as_slice(),
                    )
                    .map_err(|error| DemError::Tiff(error.to_string()))?;
            }
            if let Some(ascii) = request.geo_ascii_params.as_deref() {
                image
                    .encoder()
                    .write_tag(Tag::GeoAsciiParamsTag, ascii)
                    .map_err(|error| DemError::Tiff(error.to_string()))?;
            }
        }
        image
            .write_data(&request.rgba)
            .map_err(|error| DemError::Tiff(error.to_string()))?;
    }
    Ok(cursor.into_inner())
}

fn nearest_height(dataset: &DemDataset, source_x: usize, source_y: usize, range: f64) -> f32 {
    for radius in 1..=16isize {
        for dy in -radius..=radius {
            for dx in -radius..=radius {
                let x = source_x as isize + dx;
                let y = source_y as isize + dy;
                if x < 0 || y < 0 || x >= dataset.width as isize || y >= dataset.height as isize {
                    continue;
                }
                if let Some(value) = dataset.data[y as usize * dataset.width + x as usize] {
                    return (((value as f64 - dataset.min) / range) as f32).clamp(0.0, 1.0);
                }
            }
        }
    }
    0.0
}

fn checked_cell_count(width: usize, height: usize) -> Result<usize, DemError> {
    let count = width
        .checked_mul(height)
        .ok_or_else(|| DemError::InvalidData("栅格尺寸溢出".into()))?;
    if count == 0 || count > MAX_CELL_COUNT {
        return Err(DemError::InvalidData(format!(
            "栅格单元数量超出限制：{count}"
        )));
    }
    Ok(count)
}

fn finish_dataset(
    name: &str,
    dataset_type: &str,
    width: usize,
    height: usize,
    values: impl IntoIterator<Item = f64>,
    no_data: Option<f64>,
    geo: Option<GeoMetadata>,
) -> Result<DemDataset, DemError> {
    let cell_count = checked_cell_count(width, height)?;
    let mut data = Vec::with_capacity(cell_count);
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    let mut no_data_count = 0usize;

    for value in values.into_iter().take(cell_count) {
        let invalid = !value.is_finite()
            || no_data
                .map(|sentinel| (value - sentinel).abs() < 1e-8)
                .unwrap_or(false);
        if invalid {
            data.push(None);
            no_data_count += 1;
        } else {
            min = min.min(value);
            max = max.max(value);
            data.push(Some(value));
        }
    }

    if data.len() != cell_count {
        return Err(DemError::InvalidData(format!(
            "高程数据不足：需要 {cell_count}，实际 {}",
            data.len()
        )));
    }
    if !min.is_finite() || !max.is_finite() {
        return Err(DemError::InvalidData("没有检测到有效高程值".into()));
    }

    Ok(DemDataset {
        name: name.to_string(),
        dataset_type: dataset_type.to_string(),
        width,
        height,
        data,
        no_data,
        min,
        max,
        no_data_count,
        statistics_approximate: false,
        geo,
        engine: "rust-dem-core",
    })
}

fn parse_asc(name: &str, bytes: &[u8]) -> Result<DemDataset, DemError> {
    let text = std::str::from_utf8(bytes)
        .map_err(|_| DemError::InvalidData("ASC 必须是 UTF-8 或 ASCII 文本".into()))?;
    let lines: Vec<&str> = text.lines().collect();
    let mut header = BTreeMap::<String, f64>::new();
    let mut data_start = 0usize;

    for (index, line) in lines.iter().take(12).enumerate() {
        let mut parts = line.split_whitespace();
        let key = parts.next().unwrap_or_default().to_ascii_lowercase();
        let value = parts.next().and_then(|item| item.parse::<f64>().ok());
        if matches!(
            key.as_str(),
            "ncols"
                | "nrows"
                | "xllcorner"
                | "yllcorner"
                | "xllcenter"
                | "yllcenter"
                | "cellsize"
                | "nodata_value"
        ) {
            let value = value
                .ok_or_else(|| DemError::InvalidData(format!("ASC 头字段 {key} 的数值无效")))?;
            header.insert(key, value);
            data_start = index + 1;
        } else {
            break;
        }
    }

    let width = header
        .get("ncols")
        .copied()
        .filter(|value| *value > 0.0)
        .map(|value| value as usize)
        .ok_or_else(|| DemError::InvalidData("ASC 缺少 ncols".into()))?;
    let height = header
        .get("nrows")
        .copied()
        .filter(|value| *value > 0.0)
        .map(|value| value as usize)
        .ok_or_else(|| DemError::InvalidData("ASC 缺少 nrows".into()))?;
    let cell_count = checked_cell_count(width, height)?;
    let values = lines[data_start..]
        .iter()
        .flat_map(|line| line.split_whitespace())
        .take(cell_count)
        .map(|value| {
            value
                .parse::<f64>()
                .map_err(|_| DemError::InvalidData(format!("ASC 包含无效高程值：{value}")))
        })
        .collect::<Result<Vec<_>, _>>()?;
    if values.len() != cell_count {
        return Err(DemError::InvalidData(format!(
            "ASC 高程数据不足：需要 {cell_count}，实际 {}",
            values.len()
        )));
    }

    let no_data = header.get("nodata_value").copied().or(Some(-9999.0));
    let geo = header
        .get("cellsize")
        .copied()
        .filter(|value| *value > 0.0)
        .map(|cell_size| {
            let is_center = header.contains_key("xllcenter") || header.contains_key("yllcenter");
            let xll = header
                .get("xllcorner")
                .or_else(|| header.get("xllcenter"))
                .copied()
                .unwrap_or(0.0);
            let yll = header
                .get("yllcorner")
                .or_else(|| header.get("yllcenter"))
                .copied()
                .unwrap_or(0.0);
            let x_origin = if is_center {
                xll - cell_size / 2.0
            } else {
                xll
            };
            let y_origin = if is_center {
                yll + height as f64 * cell_size - cell_size / 2.0
            } else {
                yll + height as f64 * cell_size
            };
            let transform = [x_origin, cell_size, 0.0, y_origin, 0.0, -cell_size];
            GeoMetadata {
                geo_transform: Some(transform),
                geo_transform_method: Some("ASCII Grid header".into()),
                bbox: calculate_bbox(transform, width, height),
                unit: "map unit".into(),
                source_file: name.into(),
                source_format: "ASCII Grid".into(),
                source_geo_tiff_tags: json!({}),
                ..Default::default()
            }
        });

    finish_dataset(name, "ASCII Grid", width, height, values, no_data, geo)
}

fn parse_hgt(name: &str, bytes: &[u8]) -> Result<DemDataset, DemError> {
    if bytes.len() % 2 != 0 {
        return Err(DemError::InvalidData("HGT 文件长度不是 16 位对齐".into()));
    }
    let sample_count = bytes.len() / 2;
    let size = (sample_count as f64).sqrt() as usize;
    if size * size != sample_count {
        return Err(DemError::InvalidData("HGT 不是标准方形网格".into()));
    }
    checked_cell_count(size, size)?;
    let values = bytes
        .chunks_exact(2)
        .map(|chunk| i16::from_be_bytes([chunk[0], chunk[1]]) as f64)
        .collect::<Vec<_>>();
    let geo = hgt_tile_origin(name).map(|(lat, lon)| {
        let cell_size = 1.0 / (size.saturating_sub(1).max(1) as f64);
        GeoMetadata {
            crs: Some("EPSG:4326".into()),
            crs_code: Some(4326),
            crs_kind: Some("geographic".into()),
            crs_method: Some("SRTM tile name".into()),
            geo_transform: Some([lon, cell_size, 0.0, lat + 1.0, 0.0, -cell_size]),
            geo_transform_method: Some("SRTM tile name".into()),
            bbox: Some(GeoBounds {
                west: lon,
                south: lat,
                east: lon + 1.0,
                north: lat + 1.0,
            }),
            unit: "degree".into(),
            geographic_crs: Some(4326),
            source_file: name.into(),
            source_format: "SRTM HGT".into(),
            source_geo_tiff_tags: json!({}),
            ..Default::default()
        }
    });
    finish_dataset(name, "SRTM HGT", size, size, values, Some(-32768.0), geo)
}

fn hgt_tile_origin(name: &str) -> Option<(f64, f64)> {
    let stem = name.rsplit(['/', '\\']).next()?.split('.').next()?;
    let bytes = stem.as_bytes();
    if bytes.len() < 7 {
        return None;
    }
    let lat = stem[1..3].parse::<f64>().ok()?;
    let lon = stem[4..7].parse::<f64>().ok()?;
    let lat = if bytes[0].eq_ignore_ascii_case(&b'S') {
        -lat
    } else if bytes[0].eq_ignore_ascii_case(&b'N') {
        lat
    } else {
        return None;
    };
    let lon = if bytes[3].eq_ignore_ascii_case(&b'W') {
        -lon
    } else if bytes[3].eq_ignore_ascii_case(&b'E') {
        lon
    } else {
        return None;
    };
    Some((lat, lon))
}

fn parse_geotiff(
    name: &str,
    bytes: &[u8],
    companions: &[CoreFile],
) -> Result<DemDataset, DemError> {
    let mut decoder =
        Decoder::new(Cursor::new(bytes)).map_err(|error| DemError::Tiff(error.to_string()))?;
    let header = read_geotiff_header(name, &mut decoder, companions)?;
    let width = header.width;
    let height = header.height;
    let cell_count = checked_cell_count(width as usize, height as usize)?;

    let decoded = decoder
        .read_image()
        .map_err(|error| DemError::Tiff(error.to_string()))?;
    let all_values = decoding_result_to_f64(decoded);
    if all_values.len() < cell_count {
        return Err(DemError::InvalidData(format!(
            "GeoTIFF 样本不足：需要 {cell_count}，实际 {}",
            all_values.len()
        )));
    }
    let samples_per_pixel = (all_values.len() / cell_count).max(1);
    let first_band = all_values
        .into_iter()
        .step_by(samples_per_pixel)
        .take(cell_count)
        .collect::<Vec<_>>();

    finish_dataset(
        name,
        "GeoTIFF",
        width as usize,
        height as usize,
        first_band,
        header.no_data,
        Some(header.geo),
    )
}

struct GeoTiffHeader {
    width: u32,
    height: u32,
    no_data: Option<f64>,
    statistics_minimum: Option<f64>,
    statistics_maximum: Option<f64>,
    geo: GeoMetadata,
}

fn read_geotiff_header<R: Read + Seek>(
    name: &str,
    decoder: &mut Decoder<R>,
    companions: &[CoreFile],
) -> Result<GeoTiffHeader, DemError> {
    let (width, height) = decoder
        .dimensions()
        .map_err(|error| DemError::Tiff(error.to_string()))?;
    let model_transform = decoder.get_tag_f64_vec(Tag::ModelTransformationTag).ok();
    let model_tiepoint = decoder.get_tag_f64_vec(Tag::ModelTiepointTag).ok();
    let model_scale = decoder.get_tag_f64_vec(Tag::ModelPixelScaleTag).ok();
    let geo_key_directory = decoder.get_tag_u16_vec(Tag::GeoKeyDirectoryTag).ok();
    let geo_double_params = decoder.get_tag_f64_vec(Tag::GeoDoubleParamsTag).ok();
    let geo_ascii_params = decoder.get_tag_ascii_string(Tag::GeoAsciiParamsTag).ok();
    let no_data = decoder
        .get_tag_ascii_string(Tag::GdalNodata)
        .ok()
        .and_then(|value| value.trim_matches(char::from(0)).trim().parse::<f64>().ok());
    let gdal_metadata = decoder
        .get_tag_ascii_string(Tag::Unknown(42112))
        .ok()
        .map(|value| value.trim_matches(char::from(0)).to_string());
    let statistics_minimum = gdal_metadata
        .as_deref()
        .and_then(|value| parse_gdal_metadata_number(value, "STATISTICS_MINIMUM"));
    let statistics_maximum = gdal_metadata
        .as_deref()
        .and_then(|value| parse_gdal_metadata_number(value, "STATISTICS_MAXIMUM"));

    let geo_keys = parse_geo_keys(
        geo_key_directory.as_deref(),
        geo_double_params.as_deref(),
        geo_ascii_params.as_deref(),
    );
    let raster_type = geo_keys
        .get("GTRasterTypeGeoKey")
        .and_then(Value::as_u64)
        .map(|value| value as u16);
    let pixel_is_point = raster_type == Some(2);
    let mut geo_transform = geotiff_transform(
        model_transform.as_deref(),
        model_tiepoint.as_deref(),
        model_scale.as_deref(),
        pixel_is_point,
    );
    let mut transform_method = geo_transform.map(|_| {
        if model_transform.is_some() {
            "ModelTransformation".to_string()
        } else {
            "ModelTiepoint+PixelScale".to_string()
        }
    });
    let companion = parse_companions(name, companions);
    if geo_transform.is_none() {
        geo_transform = companion.geo_transform;
        transform_method = companion.geo_transform_method;
    }

    let projected_crs = geo_key_u32(&geo_keys, "ProjectedCSTypeGeoKey");
    let geographic_crs = geo_key_u32(&geo_keys, "GeographicTypeGeoKey");
    let vertical_crs = geo_key_u32(&geo_keys, "VerticalCSTypeGeoKey");
    let (crs_code, crs_kind, crs_method) = if let Some(code) = projected_crs {
        (
            Some(code),
            Some("projected".into()),
            Some("ProjectedCSTypeGeoKey".into()),
        )
    } else if let Some(code) = geographic_crs {
        (
            Some(code),
            Some("geographic".into()),
            Some("GeographicTypeGeoKey".into()),
        )
    } else if let Some(code) = companion.crs_code {
        (
            Some(code),
            companion.crs_kind.clone(),
            Some("sidecar CRS".into()),
        )
    } else {
        (None, companion.crs_kind.clone(), None)
    };
    let crs = crs_code
        .map(|code| format!("EPSG:{code}"))
        .or_else(|| companion.crs.clone());
    let unit = horizontal_unit(&geo_keys, crs_kind.as_deref());
    let source_tags = json!({
        "modelTiepoint": model_tiepoint,
        "modelPixelScale": model_scale,
        "modelTransformation": model_transform,
        "geoKeyDirectory": geo_key_directory,
        "geoDoubleParams": geo_double_params,
        "geoAsciiParams": geo_ascii_params
    });
    let geo = GeoMetadata {
        crs,
        crs_code,
        crs_kind,
        crs_method,
        crs_wkt: companion.crs_wkt,
        geo_transform,
        geo_transform_method: transform_method,
        bbox: geo_transform
            .and_then(|transform| calculate_bbox(transform, width as usize, height as usize)),
        unit,
        projected_crs,
        geographic_crs,
        vertical_crs,
        raster_type,
        geo_keys,
        source_geo_tiff_tags: source_tags,
        image_index: 0,
        image_count: 1,
        source_file: name.into(),
        source_format: "GeoTIFF".into(),
    };
    Ok(GeoTiffHeader {
        width,
        height,
        no_data,
        statistics_minimum,
        statistics_maximum,
        geo,
    })
}

fn parse_gdal_metadata_number(metadata: &str, name: &str) -> Option<f64> {
    let marker = format!("name=\"{name}\"");
    let marker_index = metadata.find(&marker)?;
    let value_start = metadata[marker_index..].find('>')? + marker_index + 1;
    let value_end = metadata[value_start..].find('<')? + value_start;
    metadata[value_start..value_end]
        .trim()
        .parse::<f64>()
        .ok()
        .filter(|value| value.is_finite())
}

fn decoding_result_to_f64(result: DecodingResult) -> Vec<f64> {
    match result {
        DecodingResult::U8(values) => values.into_iter().map(|value| value as f64).collect(),
        DecodingResult::U16(values) => values.into_iter().map(|value| value as f64).collect(),
        DecodingResult::U32(values) => values.into_iter().map(|value| value as f64).collect(),
        DecodingResult::U64(values) => values.into_iter().map(|value| value as f64).collect(),
        DecodingResult::I8(values) => values.into_iter().map(|value| value as f64).collect(),
        DecodingResult::I16(values) => values.into_iter().map(|value| value as f64).collect(),
        DecodingResult::I32(values) => values.into_iter().map(|value| value as f64).collect(),
        DecodingResult::I64(values) => values.into_iter().map(|value| value as f64).collect(),
        DecodingResult::F32(values) => values.into_iter().map(|value| value as f64).collect(),
        DecodingResult::F64(values) => values,
        DecodingResult::F16(values) => values
            .into_iter()
            .map(|value| f16_bits_to_f32(value.to_bits()) as f64)
            .collect(),
    }
}

fn f16_bits_to_f32(bits: u16) -> f32 {
    let sign = ((bits & 0x8000) as u32) << 16;
    let exponent = ((bits >> 10) & 0x1f) as u32;
    let fraction = (bits & 0x03ff) as u32;
    let out = match exponent {
        0 => {
            if fraction == 0 {
                sign
            } else {
                let mut fraction = fraction;
                let mut exponent = 113u32;
                while fraction & 0x0400 == 0 {
                    fraction <<= 1;
                    exponent -= 1;
                }
                sign | (exponent << 23) | ((fraction & 0x03ff) << 13)
            }
        }
        31 => sign | 0x7f80_0000 | (fraction << 13),
        _ => sign | ((exponent + 112) << 23) | (fraction << 13),
    };
    f32::from_bits(out)
}

fn geotiff_transform(
    model_transform: Option<&[f64]>,
    model_tiepoint: Option<&[f64]>,
    model_scale: Option<&[f64]>,
    pixel_is_point: bool,
) -> Option<[f64; 6]> {
    if let Some(matrix) = model_transform.filter(|value| value.len() >= 16) {
        let mut result = [
            matrix[3], matrix[0], matrix[1], matrix[7], matrix[4], matrix[5],
        ];
        if pixel_is_point {
            result[0] -= 0.5 * result[1] + 0.5 * result[2];
            result[3] -= 0.5 * result[4] + 0.5 * result[5];
        }
        return Some(result);
    }
    let tie = model_tiepoint.filter(|value| value.len() >= 6)?;
    let scale = model_scale.filter(|value| value.len() >= 2)?;
    let px = scale[0];
    let py = -scale[1].abs();
    let mut x0 = tie[3] - tie[0] * px;
    let mut y0 = tie[4] - tie[1] * py;
    if pixel_is_point {
        x0 -= 0.5 * px;
        y0 -= 0.5 * py;
    }
    Some([x0, px, 0.0, y0, 0.0, py])
}

fn calculate_bbox(transform: [f64; 6], width: usize, height: usize) -> Option<GeoBounds> {
    if !transform.iter().all(|value| value.is_finite()) {
        return None;
    }
    let [x0, px, rx, y0, ry, py] = transform;
    let mut xs = Vec::with_capacity(4);
    let mut ys = Vec::with_capacity(4);
    for (i, j) in [
        (0.0, 0.0),
        (width as f64, 0.0),
        (0.0, height as f64),
        (width as f64, height as f64),
    ] {
        xs.push(x0 + i * px + j * rx);
        ys.push(y0 + i * ry + j * py);
    }
    Some(GeoBounds {
        west: xs.iter().copied().fold(f64::INFINITY, f64::min),
        south: ys.iter().copied().fold(f64::INFINITY, f64::min),
        east: xs.iter().copied().fold(f64::NEG_INFINITY, f64::max),
        north: ys.iter().copied().fold(f64::NEG_INFINITY, f64::max),
    })
}

fn parse_geo_keys(
    directory: Option<&[u16]>,
    doubles: Option<&[f64]>,
    ascii: Option<&str>,
) -> BTreeMap<String, Value> {
    let mut output = BTreeMap::new();
    let Some(directory) = directory.filter(|value| value.len() >= 4) else {
        return output;
    };
    let declared = directory[3] as usize;
    let available = (directory.len() - 4) / 4;
    for index in 0..declared.min(available) {
        let offset = 4 + index * 4;
        let id = directory[offset];
        let location = directory[offset + 1];
        let count = directory[offset + 2] as usize;
        let value_offset = directory[offset + 3] as usize;
        let name = geo_key_name(id);
        let value = match location {
            0 => json!(value_offset),
            34735 => slice_json(directory, value_offset, count),
            34736 => doubles
                .map(|items| slice_json(items, value_offset, count))
                .unwrap_or(Value::Null),
            34737 => ascii
                .and_then(|text| text.get(value_offset..value_offset.saturating_add(count)))
                .map(|text| json!(text.trim_end_matches(['\0', '|'])))
                .unwrap_or(Value::Null),
            _ => Value::Null,
        };
        if !value.is_null() {
            output.insert(name, value);
        }
    }
    output
}

fn slice_json<T: Copy + Serialize>(items: &[T], offset: usize, count: usize) -> Value {
    let end = offset.saturating_add(count).min(items.len());
    if offset >= end {
        return Value::Null;
    }
    if end - offset == 1 {
        json!(items[offset])
    } else {
        json!(&items[offset..end])
    }
}

fn geo_key_name(id: u16) -> String {
    match id {
        1024 => "GTModelTypeGeoKey",
        1025 => "GTRasterTypeGeoKey",
        1026 => "GTCitationGeoKey",
        2048 => "GeographicTypeGeoKey",
        2049 => "GeogCitationGeoKey",
        2054 => "GeogAngularUnitsGeoKey",
        3072 => "ProjectedCSTypeGeoKey",
        3073 => "PCSCitationGeoKey",
        3076 => "ProjLinearUnitsGeoKey",
        4096 => "VerticalCSTypeGeoKey",
        4097 => "VerticalCitationGeoKey",
        4098 => "VerticalDatumGeoKey",
        4099 => "VerticalUnitsGeoKey",
        _ => return format!("GeoKey_{id}"),
    }
    .into()
}

fn geo_key_u32(keys: &BTreeMap<String, Value>, name: &str) -> Option<u32> {
    keys.get(name)
        .and_then(Value::as_u64)
        .filter(|code| *code > 0 && *code != 32767 && *code != 65535)
        .map(|code| code as u32)
}

fn horizontal_unit(keys: &BTreeMap<String, Value>, crs_kind: Option<&str>) -> String {
    let key = if crs_kind == Some("projected") {
        "ProjLinearUnitsGeoKey"
    } else {
        "GeogAngularUnitsGeoKey"
    };
    match keys.get(key).and_then(Value::as_u64) {
        Some(9001 | 9005) => "metre",
        Some(9002) => "foot",
        Some(9003) => "US survey foot",
        Some(9101) => "radian",
        Some(9102) => "degree",
        Some(9103) => "arc-minute",
        Some(9104) => "arc-second",
        Some(9105) => "grad",
        Some(9106) => "gon",
        _ if crs_kind == Some("geographic") => "degree",
        _ => "map unit",
    }
    .into()
}

#[derive(Default)]
struct CompanionMetadata {
    geo_transform: Option<[f64; 6]>,
    geo_transform_method: Option<String>,
    crs: Option<String>,
    crs_code: Option<u32>,
    crs_kind: Option<String>,
    crs_wkt: Option<String>,
}

fn parse_companions(primary_name: &str, companions: &[CoreFile]) -> CompanionMetadata {
    let primary_stem = primary_name
        .to_ascii_lowercase()
        .trim_end_matches(".tiff")
        .trim_end_matches(".tif")
        .to_string();
    let mut output = CompanionMetadata::default();
    for companion in companions {
        let name = companion.name.to_ascii_lowercase();
        if !name.starts_with(&primary_stem) {
            continue;
        }
        let text = String::from_utf8_lossy(&companion.bytes);
        if matches!(name.rsplit('.').next(), Some("tfw" | "tifw" | "wld"))
            && output.geo_transform.is_none()
        {
            let values = text
                .split_whitespace()
                .filter_map(|value| value.parse::<f64>().ok())
                .collect::<Vec<_>>();
            if values.len() >= 6 {
                let [px, ry, rx, py, center_x, center_y] = [
                    values[0], values[1], values[2], values[3], values[4], values[5],
                ];
                output.geo_transform = Some([
                    center_x - 0.5 * px - 0.5 * rx,
                    px,
                    rx,
                    center_y - 0.5 * ry - 0.5 * py,
                    ry,
                    py,
                ]);
                output.geo_transform_method = Some(format!("World File: {}", companion.name));
            }
        } else if name.ends_with(".prj") {
            let definition = text.trim().to_string();
            output.crs_code = find_epsg_code(&definition);
            output.crs = output
                .crs_code
                .map(|code| format!("EPSG:{code}"))
                .or_else(|| definition.split(['[', '"']).nth(1).map(str::to_string));
            output.crs_kind = if definition.contains("PROJCS") || definition.contains("PROJCRS") {
                Some("projected".into())
            } else if definition.contains("GEOGCS") || definition.contains("GEOGCRS") {
                Some("geographic".into())
            } else {
                None
            };
            output.crs_wkt = Some(definition);
        }
    }
    output
}

fn find_epsg_code(text: &str) -> Option<u32> {
    let upper = text.to_ascii_uppercase();
    let index = upper.rfind("EPSG")?;
    upper[index + 4..]
        .chars()
        .skip_while(|character| !character.is_ascii_digit())
        .take_while(char::is_ascii_digit)
        .collect::<String>()
        .parse()
        .ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ascii_grid_and_normalizes_nodata() {
        let source = b"ncols 2\nnrows 2\nxllcorner 100\nyllcorner 20\ncellsize 5\nNODATA_value -9999\n1 2\n-9999 4\n";
        let dataset = parse("sample.asc", source, &[]).unwrap();
        assert_eq!((dataset.width, dataset.height), (2, 2));
        assert_eq!(dataset.data, vec![Some(1.0), Some(2.0), None, Some(4.0)]);
        assert_eq!(dataset.no_data_count, 1);
        assert_eq!(dataset.min, 1.0);
        assert_eq!(dataset.max, 4.0);
        let sampled = sample_dataset(
            &dataset,
            &SamplingOptions {
                max_dimension: 2,
                no_data_fill: "lowest".into(),
                smooth_steps: 0,
            },
        )
        .unwrap();
        assert_eq!(sampled.valid_mask, vec![1, 1, 0, 1]);
        assert_eq!(
            dataset.geo.unwrap().geo_transform,
            Some([100.0, 5.0, 0.0, 30.0, 0.0, -5.0])
        );
    }

    #[test]
    fn legacy_smooth_steps_never_change_authoritative_elevations() {
        let dataset = finish_dataset(
            "authoritative.asc",
            "ASCII Grid",
            3,
            3,
            [0.0, 0.0, 0.0, 0.0, 9.0, 0.0, 0.0, 0.0, 0.0],
            None,
            None,
        )
        .unwrap();
        let original = sample_dataset(
            &dataset,
            &SamplingOptions {
                max_dimension: 3,
                no_data_fill: "lowest".into(),
                smooth_steps: 0,
            },
        )
        .unwrap();
        let legacy = sample_dataset(
            &dataset,
            &SamplingOptions {
                max_dimension: 3,
                no_data_fill: "lowest".into(),
                smooth_steps: 3,
            },
        )
        .unwrap();
        assert_eq!(legacy.heights, original.heights);
        assert_eq!(legacy.valid_mask, original.valid_mask);
    }

    #[test]
    fn masked_resampling_ignores_invalid_zero_corners() {
        let source = vec![1.0, 0.0, 1.0, 0.0];
        let mask = vec![1, 0, 1, 0];
        let resampled = resample_heights(&source, &mask, 2, 2, 3, 3);
        assert!((resampled[4] - 1.0).abs() < f32::EPSILON);
    }

    #[test]
    fn parses_hgt_big_endian_and_tile_location() {
        let values = [1i16, 2, -32768, 4];
        let bytes = values
            .into_iter()
            .flat_map(i16::to_be_bytes)
            .collect::<Vec<_>>();
        let dataset = parse("N28E086.hgt", &bytes, &[]).unwrap();
        assert_eq!((dataset.width, dataset.height), (2, 2));
        assert_eq!(dataset.no_data_count, 1);
        assert_eq!(dataset.geo.unwrap().crs_code, Some(4326));
    }

    #[test]
    fn rejects_incomplete_ascii_grid() {
        let error = parse("bad.asc", b"ncols 2\nnrows 2\n1 2 3\n", &[]).unwrap_err();
        assert!(error.to_string().contains("数据不足"));
    }

    #[test]
    fn converts_half_precision_values() {
        assert_eq!(f16_bits_to_f32(0x3c00), 1.0);
        assert_eq!(f16_bits_to_f32(0xc000), -2.0);
    }

    #[test]
    fn decodes_tiff_first_band_in_rust() {
        use tiff::encoder::{colortype::Gray16, TiffEncoder};

        let mut cursor = Cursor::new(Vec::new());
        TiffEncoder::new(&mut cursor)
            .unwrap()
            .write_image::<Gray16>(2, 2, &[10, 20, 30, 40])
            .unwrap();
        let dataset = parse("terrain.tif", cursor.get_ref(), &[]).unwrap();
        assert_eq!((dataset.width, dataset.height), (2, 2));
        assert_eq!(
            dataset.data,
            vec![Some(10.0), Some(20.0), Some(30.0), Some(40.0)]
        );
        assert_eq!(dataset.engine, "rust-dem-core");
    }

    #[test]
    fn opens_and_samples_file_backed_geotiff_without_full_dataset_data() {
        use tiff::encoder::{colortype::Gray16, TiffEncoder};

        let mut cursor = Cursor::new(Vec::new());
        TiffEncoder::new(&mut cursor)
            .unwrap()
            .write_image::<Gray16>(4, 4, &(1u16..=16).collect::<Vec<_>>())
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "dem-studio-file-backed-{}-{}.tif",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, cursor.into_inner()).unwrap();
        let result = (|| {
            let dataset = open_geotiff_path(&path, "large.tif", &[])?;
            assert!(dataset.metadata.data.is_empty());
            assert!(!dataset.overview.heights.is_empty());
            assert_eq!((dataset.metadata.width, dataset.metadata.height), (4, 4));
            assert_eq!((dataset.metadata.min, dataset.metadata.max), (1.0, 16.0));
            let sampled = sample_file_dataset(
                &dataset,
                &SamplingOptions {
                    max_dimension: 4,
                    no_data_fill: "lowest".into(),
                    smooth_steps: 0,
                },
            )?;
            assert_eq!((sampled.cols, sampled.rows), (4, 4));
            assert_eq!(sampled.heights.first().copied(), Some(0.0));
            assert_eq!(sampled.heights.last().copied(), Some(1.0));
            let overview = sample_file_overview(
                &dataset,
                &SamplingOptions {
                    max_dimension: 4,
                    no_data_fill: "lowest".into(),
                    smooth_steps: 0,
                },
            )?;
            assert_eq!((overview.cols, overview.rows), (4, 4));
            Ok::<(), DemError>(())
        })();
        let _ = std::fs::remove_file(&path);
        result.unwrap();
    }

    #[test]
    fn file_backed_geotiff_uses_embedded_overview_and_gdal_statistics() {
        use tiff::encoder::{colortype::Gray16, TiffEncoder};

        let mut cursor = Cursor::new(Vec::new());
        {
            let mut encoder = TiffEncoder::new(&mut cursor).unwrap();
            let mut base = encoder.new_image::<Gray16>(8, 8).unwrap();
            base.encoder().write_tag(Tag::GdalNodata, "0").unwrap();
            base.encoder()
                .write_tag(
                    Tag::Unknown(42112),
                    "<GDALMetadata><Item name=\"STATISTICS_MINIMUM\">10</Item><Item name=\"STATISTICS_MAXIMUM\">90</Item></GDALMetadata>",
                )
                .unwrap();
            base.write_data(&vec![50u16; 64]).unwrap();

            let overview_values = vec![
                0u16, 20, 30, 0, 40, 50, 60, 70, 0, 80, 90, 0, 10, 20, 30, 40,
            ];
            encoder
                .write_image::<Gray16>(4, 4, &overview_values)
                .unwrap();
        }
        let path = std::env::temp_dir().join(format!(
            "dem-studio-embedded-overview-{}-{}.tif",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, cursor.into_inner()).unwrap();
        let result = (|| {
            let dataset = open_geotiff_path(&path, "overview.tif", &[])?;
            assert_eq!((dataset.metadata.min, dataset.metadata.max), (10.0, 90.0));
            assert_eq!((dataset.overview.cols, dataset.overview.rows), (4, 4));
            assert_eq!(dataset.overview.engine, "rust-dem-core-v2-pyramid-overview");
            assert_eq!(
                dataset.overview.valid_mask,
                vec![0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1]
            );
            assert_eq!(dataset.overview.heights[1], 0.125);
            assert_eq!(dataset.overview.heights[10], 1.0);
            Ok::<(), DemError>(())
        })();
        let _ = std::fs::remove_file(&path);
        result.unwrap();
    }

    #[test]
    fn window_sampling_selects_the_coarsest_adequate_external_overview() {
        use tiff::encoder::{colortype::Gray16, TiffEncoder};

        let path = std::env::temp_dir().join(format!(
            "dem-studio-overview-selection-{}-{}.tif",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let overview_path = appended_sidecar_path(&path, ".ovr");
        let aux_path = appended_sidecar_path(&path, ".aux.xml");
        let mut base_cursor = Cursor::new(Vec::new());
        TiffEncoder::new(&mut base_cursor)
            .unwrap()
            .write_image::<Gray16>(16, 16, &(0u16..=255).collect::<Vec<_>>())
            .unwrap();
        let mut overview_cursor = Cursor::new(Vec::new());
        {
            let mut encoder = TiffEncoder::new(&mut overview_cursor).unwrap();
            encoder
                .write_image::<Gray16>(8, 8, &vec![40u16; 64])
                .unwrap();
            encoder
                .write_image::<Gray16>(4, 4, &vec![80u16; 16])
                .unwrap();
        }
        std::fs::write(&path, base_cursor.into_inner()).unwrap();
        std::fs::write(&overview_path, overview_cursor.into_inner()).unwrap();
        std::fs::write(
            &aux_path,
            "<PAMDataset><PAMRasterBand band=\"1\"><Metadata><MDI key=\"STATISTICS_MINIMUM\">0</MDI><MDI key=\"STATISTICS_MAXIMUM\">255</MDI></Metadata></PAMRasterBand></PAMDataset>",
        )
        .unwrap();
        let result = (|| {
            let dataset = open_geotiff_path(&path, "selection.tif", &[])?;
            assert_eq!(dataset.overview_sources.len(), 2);

            let options = |side| WindowSamplingOptions {
                source_x: 0,
                source_y: 0,
                source_width: 16,
                source_height: 16,
                output_width: Some(side),
                output_height: Some(side),
                max_dimension: None,
                no_data_fill: "lowest".into(),
                smooth_steps: 0,
            };

            let coarse = select_window_raster_source(&dataset, &options(4), 4, 4);
            assert_eq!((coarse.width, coarse.height), (4, 4));
            let coarse_sample = sample_file_window(&dataset, &options(4))?;
            assert!(coarse_sample
                .heights
                .iter()
                .all(|value| (*value - 80.0 / 255.0).abs() < 1.0e-6));

            let medium = select_window_raster_source(&dataset, &options(5), 5, 5);
            assert_eq!((medium.width, medium.height), (8, 8));
            let medium_sample = sample_file_window(&dataset, &options(5))?;
            assert!(medium_sample
                .heights
                .iter()
                .all(|value| (*value - 40.0 / 255.0).abs() < 1.0e-6));

            let full = select_window_raster_source(&dataset, &options(17), 17, 17);
            assert_eq!(full.cache_namespace, 0);
            assert_eq!((full.width, full.height), (16, 16));
            Ok::<(), DemError>(())
        })();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&overview_path);
        let _ = std::fs::remove_file(&aux_path);
        result.unwrap();
    }

    #[test]
    fn file_backed_geotiff_auto_discovers_exact_pam_and_ovr_sidecars() {
        use tiff::encoder::{colortype::Gray16, TiffEncoder};

        let path = std::env::temp_dir().join(format!(
            "dem-studio-external-overview-{}-{}.tif",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let overview_path = appended_sidecar_path(&path, ".ovr");
        let aux_path = appended_sidecar_path(&path, ".aux.xml");
        let mut base_cursor = Cursor::new(Vec::new());
        {
            let mut encoder = TiffEncoder::new(&mut base_cursor).unwrap();
            let mut image = encoder.new_image::<Gray16>(8, 8).unwrap();
            image.encoder().write_tag(Tag::GdalNodata, "0").unwrap();
            image.write_data(&vec![50u16; 64]).unwrap();
        }
        let mut overview_cursor = Cursor::new(Vec::new());
        TiffEncoder::new(&mut overview_cursor)
            .unwrap()
            .write_image::<Gray16>(
                4,
                4,
                &[
                    0u16, 20, 30, 0, 40, 50, 60, 70, 0, 80, 90, 0, 10, 20, 30, 40,
                ],
            )
            .unwrap();
        std::fs::write(&path, base_cursor.into_inner()).unwrap();
        std::fs::write(&overview_path, overview_cursor.into_inner()).unwrap();
        std::fs::write(
            &aux_path,
            "<PAMDataset><PAMRasterBand band=\"1\"><Metadata><MDI key=\"STATISTICS_MINIMUM\">10</MDI><MDI key=\"STATISTICS_MAXIMUM\">90</MDI></Metadata></PAMRasterBand></PAMDataset>",
        )
        .unwrap();
        let result = (|| {
            let dataset = open_geotiff_path(&path, "overview.tif", &[])?;
            assert_eq!((dataset.metadata.min, dataset.metadata.max), (10.0, 90.0));
            assert_eq!((dataset.overview.cols, dataset.overview.rows), (4, 4));
            assert_eq!(dataset.overview.engine, "rust-dem-core-v2-pyramid-overview");
            assert_eq!(
                dataset.overview.valid_mask,
                vec![0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 0, 1, 1, 1, 1]
            );
            std::fs::write(&overview_path, b"broken derived overview").unwrap();
            std::fs::write(&aux_path, "<PAMDataset>broken statistics</PAMDataset>").unwrap();
            let fallback = open_geotiff_path(&path, "overview.tif", &[])?;
            assert_eq!(fallback.overview.engine, "rust-dem-core-v2-stats-fallback");
            Ok::<(), DemError>(())
        })();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&overview_path);
        let _ = std::fs::remove_file(&aux_path);
        result.unwrap();
    }

    #[test]
    fn sparse_nodata_geotiff_uses_sidecars_before_rejecting_empty_stats_sample() {
        use tiff::encoder::{colortype::Gray16, TiffEncoder};

        let path = std::env::temp_dir().join(format!(
            "dem-studio-sparse-sidecar-rescue-{}-{}.tif",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let overview_path = appended_sidecar_path(&path, ".ovr");
        let aux_path = appended_sidecar_path(&path, ".aux.xml");
        let mut base_cursor = Cursor::new(Vec::new());
        {
            let mut encoder = TiffEncoder::new(&mut base_cursor).unwrap();
            let mut image = encoder.new_image::<Gray16>(8, 8).unwrap();
            image.encoder().write_tag(Tag::GdalNodata, "0").unwrap();
            image.rows_per_strip(1).unwrap();
            let mut values = vec![0u16; 64];
            values[3 * 8 + 2] = 50;
            values[3 * 8 + 3] = 60;
            image.write_data(&values).unwrap();
        }
        let mut overview_cursor = Cursor::new(Vec::new());
        TiffEncoder::new(&mut overview_cursor)
            .unwrap()
            .write_image::<Gray16>(
                4,
                4,
                &[0u16, 0, 0, 0, 0, 50, 60, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            )
            .unwrap();
        std::fs::write(&path, base_cursor.into_inner()).unwrap();
        std::fs::write(&overview_path, overview_cursor.into_inner()).unwrap();
        std::fs::write(
            &aux_path,
            "<PAMDataset><PAMRasterBand band=\"1\"><Metadata><MDI key=\"STATISTICS_MINIMUM\">50</MDI><MDI key=\"STATISTICS_MAXIMUM\">60</MDI></Metadata></PAMRasterBand></PAMDataset>",
        )
        .unwrap();
        let result = (|| {
            let dataset = open_geotiff_path(&path, "sparse.tif", &[])?;
            assert_eq!((dataset.metadata.min, dataset.metadata.max), (50.0, 60.0));
            assert_eq!(dataset.overview.valid_mask.iter().sum::<u8>(), 2);
            assert_eq!(dataset.overview.engine, "rust-dem-core-v2-pyramid-overview");
            Ok::<(), DemError>(())
        })();
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&overview_path);
        let _ = std::fs::remove_file(&aux_path);
        result.unwrap();
    }

    #[test]
    fn file_backed_chunk_cache_reuses_chunks_across_window_requests() {
        use tiff::encoder::{colortype::Gray16, TiffEncoder};

        let mut cursor = Cursor::new(Vec::new());
        TiffEncoder::new(&mut cursor)
            .unwrap()
            .write_image::<Gray16>(4, 4, &(1u16..=16).collect::<Vec<_>>())
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "dem-studio-cache-{}-{}.tif",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, cursor.into_inner()).unwrap();
        let result = (|| {
            let dataset = open_geotiff_path(&path, "cache.tif", &[])?;
            let options = WindowSamplingOptions {
                source_x: 0,
                source_y: 0,
                source_width: 4,
                source_height: 4,
                output_width: Some(4),
                output_height: Some(4),
                max_dimension: None,
                no_data_fill: "lowest".into(),
                smooth_steps: 0,
            };
            sample_file_window(&dataset, &options)?;
            let after_first = dataset.cache_stats()?;
            sample_file_window(&dataset, &options)?;
            let after_second = dataset.cache_stats()?;
            assert!(after_first.misses >= 1);
            assert!(after_first.decoded_chunks >= 1);
            assert!(after_second.hits > after_first.hits);
            assert_eq!(
                after_second.decoded_chunks, after_first.decoded_chunks,
                "warm request must reuse the decoded chunk"
            );
            Ok::<(), DemError>(())
        })();
        let _ = std::fs::remove_file(&path);
        result.unwrap();
    }

    #[test]
    fn chunk_cache_enforces_its_byte_budget() {
        let mut cache = ChunkCache::new(16);
        for chunk_index in 0..2 {
            cache.insert(
                chunk_index,
                Arc::new(ChunkSamples {
                    width: 2,
                    height: 1,
                    values: vec![chunk_index as f64; 2],
                    samples_per_pixel: 1,
                }),
            );
        }
        assert!(cache.stats.resident_bytes <= cache.stats.max_bytes);
        assert_eq!(cache.entries.len(), 1);
        assert_eq!(cache.stats.evictions, 1);
    }

    #[test]
    fn preserves_large_integer_steps_until_normalization() {
        let dataset = finish_dataset(
            "u32-precision.tif",
            "GeoTIFF",
            4,
            2,
            [
                16_777_216.0,
                16_777_217.0,
                16_777_218.0,
                16_777_219.0,
                16_777_216.0,
                16_777_217.0,
                16_777_218.0,
                16_777_219.0,
            ],
            None,
            None,
        )
        .unwrap();
        let sampled = sample_dataset(
            &dataset,
            &SamplingOptions {
                max_dimension: 4,
                no_data_fill: "zero".into(),
                smooth_steps: 0,
            },
        )
        .unwrap();
        assert_eq!(&sampled.heights[0..4], &[0.0, 1.0 / 3.0, 2.0 / 3.0, 1.0]);
    }

    #[test]
    fn lod_prefilter_suppresses_checkerboard_aliasing() {
        let values = (0..64 * 64).map(|index| {
            let x = index % 64;
            let y = index / 64;
            if (x + y) % 2 == 0 { 0.0 } else { 1.0 }
        });
        let dataset =
            finish_dataset("checker.tif", "GeoTIFF", 64, 64, values, None, None).unwrap();
        let sampled = sample_dataset(
            &dataset,
            &SamplingOptions {
                max_dimension: 8,
                no_data_fill: "zero".into(),
                smooth_steps: 0,
            },
        )
        .unwrap();
        for value in sampled.heights {
            assert!(
                (0.45..=0.55).contains(&value),
                "prefiltered checkerboard value {value} was aliased"
            );
        }
    }

    #[test]
    fn real_frmm_geotiff_preserves_precision_and_prefilters_when_available() {
        let path = PathBuf::from(
            r"F:\BaiduNetdiskDownload\西南战区\滇南\FRMM_EarthPrinter_DN_PREC_2024.tif",
        );
        if !path.is_file() {
            return;
        }
        let dataset =
            open_geotiff_path(&path, "FRMM_EarthPrinter_DN_PREC_2024.tif", &[]).unwrap();
        assert_eq!((dataset.metadata.width, dataset.metadata.height), (31_984, 18_495));
        assert_eq!((dataset.metadata.min, dataset.metadata.max), (622.0, 2239.0));
        let sampled = sample_file_dataset(
            &dataset,
            &SamplingOptions {
                max_dimension: 32,
                no_data_fill: "zero".into(),
                smooth_steps: 0,
            },
        )
        .unwrap();
        assert_eq!((sampled.cols, sampled.rows), (32, 19));
        assert!(sampled.valid_mask.iter().any(|value| *value != 0));
        assert!(sampled.heights.iter().all(|value| value.is_finite()));
        assert!(sampled.heights.iter().all(|value| (0.0..=1.0).contains(value)));
    }

    #[test]
    fn cancellable_sampling_stops_before_allocating_output() {
        let dataset = finish_dataset(
            "cancel.asc",
            "ASCII Grid",
            4,
            4,
            (1..=16).map(f64::from),
            None,
            None,
        )
        .unwrap();
        let cancelled = AtomicBool::new(true);
        let result = sample_dataset_window_cancellable(
            &dataset,
            &WindowSamplingOptions {
                source_x: 0,
                source_y: 0,
                source_width: 4,
                source_height: 4,
                output_width: Some(4),
                output_height: Some(4),
                max_dimension: None,
                no_data_fill: "lowest".into(),
                smooth_steps: 0,
            },
            Some(&cancelled),
        );
        assert!(matches!(result, Err(DemError::Cancelled)));
    }

    #[test]
    fn samples_only_the_requested_memory_window() {
        let dataset = finish_dataset(
            "window.asc",
            "ASCII Grid",
            4,
            4,
            (1..=16).map(f64::from),
            None,
            None,
        )
        .unwrap();
        let sampled = sample_dataset_window(
            &dataset,
            &WindowSamplingOptions {
                source_x: 1,
                source_y: 1,
                source_width: 2,
                source_height: 2,
                output_width: Some(2),
                output_height: Some(2),
                max_dimension: None,
                no_data_fill: "lowest".into(),
                smooth_steps: 0,
            },
        )
        .unwrap();
        assert_eq!((sampled.cols, sampled.rows), (2, 2));
        assert_eq!(
            sampled.heights,
            vec![5.0 / 15.0, 6.0 / 15.0, 9.0 / 15.0, 10.0 / 15.0]
        );
    }

    #[test]
    fn samples_only_the_requested_file_backed_window() {
        use tiff::encoder::{colortype::Gray16, TiffEncoder};

        let mut cursor = Cursor::new(Vec::new());
        TiffEncoder::new(&mut cursor)
            .unwrap()
            .write_image::<Gray16>(4, 4, &(1u16..=16).collect::<Vec<_>>())
            .unwrap();
        let path = std::env::temp_dir().join(format!(
            "dem-studio-window-{}-{}.tif",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::write(&path, cursor.into_inner()).unwrap();
        let result = (|| {
            let dataset = open_geotiff_path(&path, "window.tif", &[])?;
            let sampled = sample_file_window(
                &dataset,
                &WindowSamplingOptions {
                    source_x: 1,
                    source_y: 1,
                    source_width: 2,
                    source_height: 2,
                    output_width: Some(2),
                    output_height: Some(2),
                    max_dimension: None,
                    no_data_fill: "lowest".into(),
                    smooth_steps: 0,
                },
            )?;
            assert_eq!((sampled.cols, sampled.rows), (2, 2));
            assert_eq!(
                sampled.heights,
                vec![5.0 / 15.0, 6.0 / 15.0, 9.0 / 15.0, 10.0 / 15.0]
            );
            Ok::<(), DemError>(())
        })();
        let _ = std::fs::remove_file(&path);
        result.unwrap();
    }

    #[test]
    fn window_max_dimension_preserves_window_aspect_ratio() {
        let options = WindowSamplingOptions {
            source_x: 10,
            source_y: 20,
            source_width: 200,
            source_height: 100,
            output_width: None,
            output_height: None,
            max_dimension: Some(50),
            no_data_fill: "lowest".into(),
            smooth_steps: 0,
        };
        assert_eq!(
            validate_window_options(1000, 1000, &options).unwrap(),
            (50, 25)
        );
    }

    #[test]
    fn rejects_out_of_bounds_window() {
        let options = WindowSamplingOptions {
            source_x: 3,
            source_y: 0,
            source_width: 2,
            source_height: 2,
            output_width: Some(2),
            output_height: Some(2),
            max_dimension: None,
            no_data_fill: "lowest".into(),
            smooth_steps: 0,
        };
        let error = validate_window_options(4, 4, &options).unwrap_err();
        assert!(error.to_string().contains("源窗口越界"));
    }

    #[test]
    fn derives_geotiff_affine_bounds() {
        let transform = geotiff_transform(
            None,
            Some(&[0.0, 0.0, 0.0, 100.0, 200.0, 0.0]),
            Some(&[10.0, 20.0, 0.0]),
            false,
        )
        .unwrap();
        assert_eq!(transform, [100.0, 10.0, 0.0, 200.0, 0.0, -20.0]);
        let bounds = calculate_bbox(transform, 2, 3).unwrap();
        assert_eq!(bounds.west, 100.0);
        assert_eq!(bounds.east, 120.0);
        assert_eq!(bounds.south, 140.0);
        assert_eq!(bounds.north, 200.0);
    }

    #[test]
    fn samples_in_rust_core_with_legacy_smoothing_field_ignored() {
        let dataset = parse(
            "sample.asc",
            b"ncols 3\nnrows 3\ncellsize 1\nNODATA_value -9999\n1 2 3\n4 -9999 6\n7 8 9\n",
            &[],
        )
        .unwrap();
        let sampled = sample_dataset(
            &dataset,
            &SamplingOptions {
                max_dimension: 3,
                no_data_fill: "nearest".into(),
                smooth_steps: 1,
            },
        )
        .unwrap();
        assert_eq!((sampled.cols, sampled.rows), (3, 3));
        assert_eq!(sampled.heights.len(), 9);
        assert!(sampled
            .heights
            .iter()
            .all(|value| (0.0..=1.0).contains(value)));
    }

    #[test]
    fn encodes_rendered_geotiff_with_affine_transform() {
        let bytes = encode_rendered_geotiff(&RenderedGeoTiff {
            width: 2,
            height: 2,
            rgba: vec![
                10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 0,
            ],
            geo_transform: [100.0, 5.0, 0.0, 200.0, 0.0, -5.0],
            geo_key_directory: vec![1, 1, 0, 2, 1024, 0, 1, 2, 1025, 0, 1, 1],
            geo_double_params: vec![],
            geo_ascii_params: None,
            embed_crs: true,
        })
        .unwrap();
        let dataset = parse("rendered.tif", &bytes, &[]).unwrap();
        assert_eq!((dataset.width, dataset.height), (2, 2));
        assert_eq!(
            dataset.geo.unwrap().geo_transform,
            Some([100.0, 5.0, 0.0, 200.0, 0.0, -5.0])
        );
    }
}
