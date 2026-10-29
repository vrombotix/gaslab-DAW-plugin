use std::path::PathBuf;
use std::process::Command;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;

mod mock_api;

/// The dev-tree daw-agent build, used when the bundled sidecar is unavailable
/// (a dev checkout where `scripts/prepare-sidecar.sh` hasn't been run yet).
/// AI_DAW_AGENT overrides it.
fn dev_agent_path() -> PathBuf {
    if let Ok(path) = std::env::var("AI_DAW_AGENT") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../build/daw-agent")
}

/// Runs daw-agent and returns its stdout. Prefers the bundled sidecar (the
/// only copy that exists in a packaged install); falls back to the dev-tree
/// build so `npm run tauri dev` works without prepare-sidecar.sh.
async fn run_agent(app: &tauri::AppHandle, args: &[String], envs: &[(&str, String)]) -> Result<String, String> {
    let mut envs = envs.to_vec();
    // Dev builds (`npm run tauri dev`) also enable the dev-mode DAWs, Ardour and
    // REAPER; release installers only offer Ableton Live, FL Studio and Logic Pro.
    if cfg!(debug_assertions) {
        envs.push(("AI_DAW_DEV", "1".to_string()));
    }
    let sidecar_output = match app.shell().sidecar("daw-agent") {
        Ok(cmd) => cmd.args(args).envs(envs.iter().cloned()).output().await.ok(),
        Err(_) => None,
    };
    let (stdout, stderr) = match sidecar_output {
        Some(output) => (output.stdout, output.stderr),
        None => {
            let path = dev_agent_path();
            let output = Command::new(&path)
                .args(args)
                .envs(envs.iter().cloned())
                .output()
                .map_err(|e| format!("Failed to run {}: {}", path.display(), e))?;
            (output.stdout, output.stderr)
        }
    };

    let stdout = String::from_utf8_lossy(&stdout).to_string();
    if stdout.trim().is_empty() {
        return Err(String::from_utf8_lossy(&stderr).to_string());
    }
    // The C++ agent always returns JSON, including failures, so pass it through.
    Ok(stdout)
}

#[tauri::command]
async fn agent_call(app: tauri::AppHandle, args: Vec<String>) -> Result<String, String> {
    run_agent(&app, &args, &[]).await
}

/// Signs in through the agent. The password travels in the agent's
/// environment, never its command line, which other local users can read.
#[tauri::command]
async fn agent_login(app: tauri::AppHandle, email: String, password: String) -> Result<String, String> {
    run_agent(&app, &["login".to_string(), "--email".to_string(), email], &[("AI_DAW_PASSWORD", password)]).await
}

/// Copies every DAW's bridge script into place and returns the agent's
/// per-DAW report (`install-bridges`). Runs on every startup, and again when
/// a setup guide's "Reinstall" asks for it. Best-effort per DAW: one that has
/// never been opened, or an unwritable folder, doesn't stop the others.
///
/// The integrations/ directory is resolved here and passed explicitly via
/// AI_DAW_INTEGRATIONS_DIR rather than letting the agent guess relative to
/// its own path, which breaks once packaging tooling copies the binary
/// (Tauri's own dev build copies the sidecar into target/debug/). Packaged
/// apps use Tauri's bundled resources; dev checkouts use the repo copy.
#[tauri::command]
async fn agent_install_bridges(app: tauri::AppHandle) -> Result<String, String> {
    let dev_integrations = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../integrations");
    let integrations_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("integrations"))
        .filter(|dir| dir.exists())
        .unwrap_or(dev_integrations);

    let envs = [("AI_DAW_INTEGRATIONS_DIR", integrations_dir.to_string_lossy().into_owned())];
    run_agent(&app, &["install-bridges".to_string()], &envs).await
}

fn main() {
    mock_api::spawn();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![agent_call, agent_login, agent_install_bridges])
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match agent_install_bridges(handle).await {
                    Ok(report) => println!("install-bridges: {}", report.trim()),
                    Err(e) => eprintln!("install-bridges failed: {e}"),
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Gaslab DAW Plugin");
}
