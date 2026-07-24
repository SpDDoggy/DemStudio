use dem_core::{CoreFile, DemDataset, RenderedGeoTiff, SampledTerrain, SamplingOptions};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
struct CoreState {
    datasets: Mutex<HashMap<String, DemDataset>>,
    next_id: AtomicU64,
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

fn register_dataset(dataset: DemDataset, state: &State<'_, CoreState>) -> ParsedDemResponse {
    let id = format!("dem-{}", state.next_id.fetch_add(1, Ordering::Relaxed) + 1);
    state
        .datasets
        .lock()
        .expect("DEM Core state lock poisoned")
        .insert(id.clone(), dataset.clone());
    ParsedDemResponse {
        dataset,
        core_id: id,
    }
}

#[tauri::command]
fn parse_dem(
    request: ParseDemRequest,
    state: State<'_, CoreState>,
) -> Result<ParsedDemResponse, String> {
    let dataset = dem_core::parse(&request.name, &request.bytes, &request.companions)
        .map_err(|error| error.to_string())?;
    Ok(register_dataset(dataset, &state))
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
    let bytes = std::fs::read(&path).map_err(|error| format!("无法读取 DEM 文件：{error}"))?;
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
    let dataset = dem_core::parse(name, &bytes, &companions).map_err(|error| error.to_string())?;
    Ok(register_dataset(dataset, &state))
}

#[tauri::command]
fn sample_dem(
    request: SampleDemRequest,
    state: State<'_, CoreState>,
) -> Result<SampledTerrain, String> {
    let datasets = state
        .datasets
        .lock()
        .map_err(|_| "DEM Core 状态不可用".to_string())?;
    let dataset = datasets
        .get(&request.core_id)
        .ok_or_else(|| "DEM Core 数据集已失效".to_string())?;
    dem_core::sample_dataset(
        dataset,
        &SamplingOptions {
            max_dimension: request.max_dimension,
            no_data_fill: request.no_data_fill,
            smooth_steps: request.smooth_steps,
        },
    )
    .map_err(|error| error.to_string())
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
            encode_geotiff
        ])
        .run(tauri::generate_context!())
        .expect("failed to run DEM Studio");
}
