use std::path::PathBuf;
use std::process::Command;

fn agent_path() -> PathBuf {
    if let Ok(path) = std::env::var("AI_DAW_AGENT") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../build/daw-agent")
}

#[tauri::command]
fn agent_call(args: Vec<String>) -> Result<String, String> {
    let path = agent_path();
    let output = Command::new(&path)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run {}: {}", path.display(), e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        return Err(String::from_utf8_lossy(&output.stderr).to_string());
    }
    // The C++ agent always returns JSON, including failures, so pass it through.
    Ok(stdout)
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![agent_call])
        .run(tauri::generate_context!())
        .expect("error while running AI DAW desktop application");
}
