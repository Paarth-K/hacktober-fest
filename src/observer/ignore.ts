/**
 * Ignore rules for the observer. Anything classified here never has its content
 * read into a ChangeBatch or a context packet.
 */

export type IgnoreReason = "ignored_dir" | "secret" | "binary" | "lockfile" | "generated" | "editor_temp";

const IGNORED_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "bower_components", "jspm_packages",
  "dist", "build", "out", "target", "obj", ".next", ".nuxt", ".svelte-kit", ".expo",
  ".turbo", ".cache", ".parcel-cache", ".vite", "coverage", ".nyc_output",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox",
  ".gradle", ".idea", "vendor", "pods", "deriveddata", ".terraform", ".dart_tool",
  // the engine writes progress reports here
  ".local-code-companion",
]);

/** Directories whose whole contents are credentials. */
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".azure", ".kube", ".docker"]);

const SECRET_NAMES = new Set([
  ".npmrc", ".yarnrc", ".pypirc", ".netrc", "_netrc", ".git-credentials", ".htpasswd",
  ".pgpass", ".dockercfg", "credentials", "kubeconfig", "known_hosts", "authorized_keys",
]);

const SECRET_EXTS = new Set([
  "pem", "key", "p12", "pfx", "jks", "keystore", "ppk", "crt", "cer", "der", "asc", "gpg",
  "kdbx", "tfstate", "tfvars", "secret", "secrets",
]);

const SECRET_PATTERNS = [
  /^\.env(\..*)?$/, // .env, .env.local, .env.production …
  /\.env$/, // prod.env
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/,
  /^credentials?\..+$/,
  /credentials\.json$/,
  /^(client_)?secrets?([._-].*)?\.(json|ya?ml|toml|txt|ini|cfg|conf|properties)$/,
  /[._-]secrets?\.(json|ya?ml|toml|txt|ini|cfg|conf|properties)$/,
  /^service[-_]?account.*\.json$/,
  /\.tfstate\.backup$/,
];

const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "bmp", "ico", "icns", "webp", "avif", "tif", "tiff", "psd", "heic",
  "woff", "woff2", "ttf", "otf", "eot",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war", "zst", "dmg", "iso", "msi", "deb", "rpm", "apk", "ipa",
  "mp3", "mp4", "m4a", "mov", "avi", "mkv", "wav", "flac", "ogg", "webm",
  "exe", "dll", "so", "dylib", "a", "o", "lib", "bin", "dat", "class", "pyc", "pyo", "wasm", "node", "pdb", "rlib",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt",
  "sqlite", "sqlite3", "db", "db-wal", "db-shm", "mdb",
]);

const LOCKFILES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
  "cargo.lock", "poetry.lock", "pipfile.lock", "uv.lock", "composer.lock", "gemfile.lock", "go.sum", "podfile.lock",
]);

const EDITOR_TEMP_PATTERNS = [
  /^\..*\.sw[a-p]$/, // vim swap
  /~$/, // backup files
  /^\.#/, // emacs lock
  /^#.*#$/, // emacs autosave
  /^4913$/, // vim write probe
  /\.(tmp|temp|bak|orig|rej)$/,
  /___jb_(tmp|old)___$/, // JetBrains safe-write
  /\.crswap$/,
];

const GENERATED_PATTERNS = [/\.min\.(js|css)$/, /\.map$/, /^\.ds_store$/, /^thumbs\.db$/, /^desktop\.ini$/, /\.tsbuildinfo$/];

export function isIgnoredDirName(name: string): IgnoreReason | null {
  const lower = name.toLowerCase();
  if (IGNORED_DIRS.has(lower)) return "ignored_dir";
  if (SECRET_DIRS.has(lower)) return "secret";
  return null;
}

/** Classifies a safe workspace-relative POSIX path. null means the file is eligible for diffing. */
export function classifyPath(rel: string, extraIgnoredDirs: ReadonlySet<string> = EMPTY): IgnoreReason | null {
  const segs = rel.split("/");
  const base = (segs.pop() ?? "").toLowerCase();
  for (const seg of segs) {
    const dirReason = isIgnoredDirName(seg);
    if (dirReason) return dirReason;
    if (extraIgnoredDirs.has(seg.toLowerCase())) return "ignored_dir";
  }
  if (isSecretBasename(base)) return "secret";
  if (EDITOR_TEMP_PATTERNS.some((re) => re.test(base))) return "editor_temp";
  if (LOCKFILES.has(base)) return "lockfile";
  if (GENERATED_PATTERNS.some((re) => re.test(base))) return "generated";
  const ext = extOf(base);
  if (ext && BINARY_EXTS.has(ext)) return "binary";
  return null;
}

export function isSecretBasename(baseLower: string): boolean {
  if (SECRET_NAMES.has(baseLower)) return true;
  const ext = extOf(baseLower);
  if (ext && SECRET_EXTS.has(ext)) return true;
  return SECRET_PATTERNS.some((re) => re.test(baseLower));
}

/** True when a buffer looks binary (NUL byte in the first 8000 bytes, as Git does). */
export function looksBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function extOf(baseLower: string): string | null {
  const dot = baseLower.lastIndexOf(".");
  return dot > 0 ? baseLower.slice(dot + 1) : null;
}

const EMPTY: ReadonlySet<string> = new Set();
