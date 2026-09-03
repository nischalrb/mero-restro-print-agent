// Local-test-only post-build signing hook.
//
// Why this exists: electron-builder's --universal (mac) build merges an
// x64 and an arm64 app bundle together. The nested Electron
// Framework/Helper binaries inside that merge still carry Electron's own
// original (real, notarized) Apple signature, while the outer app wrapper
// -- which now contains our modified Info.plist / app.asar -- only gets an
// ad-hoc signature (we have no paid Apple Developer ID yet). That mismatch
// between "real signature" nested components and "ad-hoc" outer wrapper is
// what makes Gatekeeper treat the app as tampered ("contains malware",
// auto-trashed) instead of just "unidentified developer" (which has an
// Open Anyway override). A single, uniform, deep ad-hoc signature over the
// *entire* bundle avoids that inconsistency.
//
// This hook only runs for local/unsigned builds. If a real Developer ID
// identity is ever configured (CSC_LINK/CSC_NAME, or a keychain identity
// electron-builder picks up), it skips itself so it never clobbers a real,
// notarizable signature.
const { execFileSync } = require("child_process");
const path = require("path");

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }
  if (process.env.CSC_LINK || process.env.CSC_NAME) {
    console.log("[afterSign] Real signing identity configured — skipping local ad-hoc re-sign.");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  console.log(`[afterSign] No Developer ID configured — applying a single uniform ad-hoc signature to ${appPath}`);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], { stdio: "inherit" });
  console.log("[afterSign] Done.");
};
