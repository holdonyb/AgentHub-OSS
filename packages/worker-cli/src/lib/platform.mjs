const SUPPORTED_PLATFORMS = new Set(["windows", "linux", "macos"]);

export function defaultPlatform() {
  if (process.platform === "win32") {
    return "windows";
  }
  if (process.platform === "linux") {
    return "linux";
  }
  if (process.platform === "darwin") {
    return "macos";
  }
  throw new Error(`Unsupported host platform: ${process.platform}`);
}

export function normalizePlatform(input) {
  const value = (input || "").trim().toLowerCase();
  if (!value) {
    return defaultPlatform();
  }
  if (value === "win32") {
    return "windows";
  }
  if (value === "darwin") {
    return "macos";
  }
  if (SUPPORTED_PLATFORMS.has(value)) {
    return value;
  }
  throw new Error(`Unsupported worker platform: ${input}`);
}
