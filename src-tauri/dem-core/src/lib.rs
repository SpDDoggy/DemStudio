use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Cursor;
use thiserror::Error;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::encoder::{colortype::RGBA8, TiffEncoder};
use tiff::tags::Tag;

const MAX_CELL_COUNT: usize = 100_000_000;

#[derive(Debug, Error)]
pub enum DemError {
    #[error("不支持的 DEM 格式：{0}")]
    UnsupportedFormat(String),
    #[error("DEM 数据无效：{0}")]
    InvalidData(String),
    #[error("GeoTIFF 解码失败：{0}")]
    Tiff(String),
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
    pub data: Vec<Option<f32>>,
    pub no_data: Option<f64>,
    pub min: f64,
    pub max: f64,
    pub no_data_count: usize,
    pub geo: Option<GeoMetadata>,
    pub engine: &'static str,
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

#[derive(Debug, Clone, Serialize)]
pub struct SampledTerrain {
    pub cols: usize,
    pub rows: usize,
    pub heights: Vec<f32>,
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
    let safe_max = options.max_dimension.clamp(2, 4096);
    let scale = (safe_max as f64 / dataset.width as f64)
        .min(safe_max as f64 / dataset.height as f64)
        .min(1.0);
    let cols = ((dataset.width as f64 * scale).round() as usize).max(2);
    let rows = ((dataset.height as f64 * scale).round() as usize).max(2);
    checked_cell_count(cols, rows)?;
    let range = (dataset.max - dataset.min).max(f64::EPSILON);
    let mut heights = vec![0.0f32; cols * rows];

    for y in 0..rows {
        let source_y =
            ((y as f64 / (rows - 1) as f64) * (dataset.height - 1) as f64).round() as usize;
        for x in 0..cols {
            let source_x =
                ((x as f64 / (cols - 1) as f64) * (dataset.width - 1) as f64).round() as usize;
            let value = dataset.data[source_y * dataset.width + source_x];
            let normalized = match value {
                Some(value) => ((value as f64 - dataset.min) / range) as f32,
                None if options.no_data_fill == "middle" => 0.5,
                None if options.no_data_fill == "nearest" => {
                    nearest_height(dataset, source_x, source_y, range)
                }
                None => 0.0,
            };
            heights[y * cols + x] = normalized.clamp(0.0, 1.0);
        }
    }

    for _ in 0..options.smooth_steps.min(32) {
        heights = smooth_heights(&heights, cols, rows);
    }

    Ok(SampledTerrain {
        cols,
        rows,
        heights,
        engine: "rust-dem-core",
    })
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

fn smooth_heights(source: &[f32], cols: usize, rows: usize) -> Vec<f32> {
    let mut destination = vec![0.0f32; source.len()];
    for y in 0..rows {
        for x in 0..cols {
            let mut sum = 0.0f32;
            let mut count = 0usize;
            for dy in -1..=1isize {
                for dx in -1..=1isize {
                    let nx = x as isize + dx;
                    let ny = y as isize + dy;
                    if nx < 0 || ny < 0 || nx >= cols as isize || ny >= rows as isize {
                        continue;
                    }
                    sum += source[ny as usize * cols + nx as usize];
                    count += 1;
                }
            }
            destination[y * cols + x] = sum / count as f32;
        }
    }
    destination
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
            data.push(Some(value as f32));
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
    let (width, height) = decoder
        .dimensions()
        .map_err(|error| DemError::Tiff(error.to_string()))?;
    let cell_count = checked_cell_count(width as usize, height as usize)?;
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
        no_data,
        Some(geo),
    )
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
        assert_eq!(
            dataset.geo.unwrap().geo_transform,
            Some([100.0, 5.0, 0.0, 30.0, 0.0, -5.0])
        );
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
    fn samples_and_smooths_in_rust_core() {
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
