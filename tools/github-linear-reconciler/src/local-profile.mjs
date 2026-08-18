import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  open as nodeOpen,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
  rmdir as nodeRmdir,
  unlink as nodeUnlink,
} from "node:fs/promises";
import { homedir as readHomeDirectory } from "node:os";
import path from "node:path";

export const PROFILE_MARKER_NAME = ".github-linear-reconciler-profile.json";
const PROFILE_MARKER_CONTENT = `${JSON.stringify({
  schemaVersion: 1,
  application: "github-linear-reconciler",
})}\n`;

function pathErrorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : null;
}

function isMissingPath(error) {
  return pathErrorCode(error) === "ENOENT";
}

function assertAbsolute(candidate, label) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
    throw new TypeError(`${label} deve ser absoluto`);
  }
  return path.resolve(candidate);
}

async function findGitMarker(directory, lstatImpl) {
  let current = path.resolve(directory);
  for (;;) {
    try {
      await lstatImpl(path.join(current, ".git"));
      return path.join(current, ".git");
    } catch (error) {
      if (!isMissingPath(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function assertOutsideGitWorktree(
  candidate,
  {
    candidateIsDirectory = false,
    lstatImpl = nodeLstat,
    realpathImpl = nodeRealpath,
  } = {},
) {
  const absolute = assertAbsolute(candidate, "caminho local");
  const lexicalDirectory = candidateIsDirectory
    ? absolute
    : path.dirname(absolute);
  if (await findGitMarker(lexicalDirectory, lstatImpl)) {
    throw new TypeError("caminho local não pode estar dentro de worktree Git");
  }

  let canonical;
  try {
    canonical = await realpathImpl(absolute);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    return absolute;
  }
  const canonicalDirectory = candidateIsDirectory
    ? canonical
    : path.dirname(canonical);
  if (await findGitMarker(canonicalDirectory, lstatImpl)) {
    throw new TypeError(
      "caminho local canônico não pode estar dentro de worktree Git",
    );
  }
  return canonical;
}

export function resolveLocalProfileRoot({
  env = process.env,
  homedir = readHomeDirectory(),
  platform = process.platform,
} = {}) {
  const override = env.GITHUB_LINEAR_RECONCILER_PROFILE_DIR?.trim();
  if (override) {
    return assertAbsolute(override, "GITHUB_LINEAR_RECONCILER_PROFILE_DIR");
  }
  const stateRoot =
    platform === "win32"
      ? env.LOCALAPPDATA?.trim() || path.join(homedir, "AppData", "Local")
      : env.XDG_STATE_HOME?.trim() || path.join(homedir, ".local", "state");
  return path.join(stateRoot, "github-linear-reconciler");
}

function assertPrivateMode(metadata, expected, label, platform) {
  if (platform === "win32") return;
  assertOwnedByCurrentUser(metadata, label, platform);
  if ((metadata.mode & 0o777) !== expected) {
    throw new TypeError(
      `${label} deve preservar modo ${expected.toString(8).padStart(4, "0")}`,
    );
  }
}

export function assertOwnedByCurrentUser(
  metadata,
  label,
  platform = process.platform,
) {
  if (platform === "win32" || typeof process.getuid !== "function") return;
  if (!Number.isInteger(metadata.uid) || metadata.uid !== process.getuid()) {
    throw new TypeError(`${label} deve pertencer ao usuário atual`);
  }
}

async function inspectOwnedProfile(
  profileRoot,
  { platform, lstatImpl, readFileImpl, realpathImpl },
) {
  const rootMetadata = await lstatImpl(profileRoot);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new TypeError("raiz do profile deve ser diretório regular");
  }
  assertPrivateMode(rootMetadata, 0o700, "raiz do profile", platform);

  const markerPath = path.join(profileRoot, PROFILE_MARKER_NAME);
  let markerMetadata;
  try {
    markerMetadata = await lstatImpl(markerPath);
  } catch (error) {
    if (isMissingPath(error)) {
      throw new TypeError(
        "raiz do profile preexistente sem marker da ferramenta",
      );
    }
    throw error;
  }
  if (markerMetadata.isSymbolicLink() || !markerMetadata.isFile()) {
    throw new TypeError("marker do profile deve ser arquivo regular");
  }
  assertPrivateMode(markerMetadata, 0o600, "marker do profile", platform);
  const marker = await readFileImpl(markerPath, "utf8");
  if (marker !== PROFILE_MARKER_CONTENT) {
    throw new TypeError("marker do profile possui conteúdo inválido");
  }

  const canonicalRoot = await realpathImpl(profileRoot);
  await assertOutsideGitWorktree(canonicalRoot, {
    candidateIsDirectory: true,
    lstatImpl,
    realpathImpl,
  });
  return Object.freeze({
    root: canonicalRoot,
    configPath: path.join(canonicalRoot, "config.json"),
    reportsPath: path.join(canonicalRoot, "reports"),
  });
}

export async function ensureOwnedLocalProfile({
  root,
  env = process.env,
  homedir,
  platform = process.platform,
  lstatImpl = nodeLstat,
  mkdirImpl = nodeMkdir,
  openImpl = nodeOpen,
  readFileImpl = nodeReadFile,
  realpathImpl = nodeRealpath,
  rmdirImpl = nodeRmdir,
  unlinkImpl = nodeUnlink,
} = {}) {
  const profileRoot = assertAbsolute(
    root ?? resolveLocalProfileRoot({ env, homedir, platform }),
    "raiz do profile",
  );
  await assertOutsideGitWorktree(profileRoot, {
    candidateIsDirectory: true,
    lstatImpl,
    realpathImpl,
  });

  const parentPath = path.dirname(profileRoot);
  const parentMetadata = await lstatImpl(parentPath);
  if (parentMetadata.isSymbolicLink() || !parentMetadata.isDirectory()) {
    throw new TypeError(
      "parent da raiz do profile deve ser diretório regular preexistente",
    );
  }
  const canonicalParent = await realpathImpl(parentPath);
  await assertOutsideGitWorktree(canonicalParent, {
    candidateIsDirectory: true,
    lstatImpl,
    realpathImpl,
  });

  let created = false;
  try {
    await lstatImpl(profileRoot);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    await mkdirImpl(profileRoot, {
      recursive: false,
      mode: 0o700,
    });
    created = true;
  }

  if (created) {
    const markerPath = path.join(profileRoot, PROFILE_MARKER_NAME);
    let markerHandle;
    try {
      markerHandle = await openImpl(markerPath, "wx", 0o600);
      await markerHandle.writeFile(PROFILE_MARKER_CONTENT, "utf8");
      await markerHandle.sync();
      await markerHandle.close();
      markerHandle = undefined;
    } catch (error) {
      await markerHandle?.close().catch(() => {});
      await unlinkImpl(markerPath).catch((unlinkError) => {
        if (!isMissingPath(unlinkError)) throw unlinkError;
      });
      await rmdirImpl(profileRoot);
      throw error;
    }
  }

  const profile = await inspectOwnedProfile(profileRoot, {
    platform,
    lstatImpl,
    readFileImpl,
    realpathImpl,
  });
  const expectedCanonicalRoot = path.join(
    canonicalParent,
    path.basename(profileRoot),
  );
  if (path.relative(expectedCanonicalRoot, profile.root) !== "") {
    throw new TypeError("raiz do profile possui destino canônico inválido");
  }
  return profile;
}

export async function assertOwnedLocalProfile({
  root,
  env = process.env,
  homedir,
  platform = process.platform,
  lstatImpl = nodeLstat,
  readFileImpl = nodeReadFile,
  realpathImpl = nodeRealpath,
} = {}) {
  const profileRoot = assertAbsolute(
    root ?? resolveLocalProfileRoot({ env, homedir, platform }),
    "raiz do profile",
  );
  await assertOutsideGitWorktree(profileRoot, {
    candidateIsDirectory: true,
    lstatImpl,
    realpathImpl,
  });
  return inspectOwnedProfile(profileRoot, {
    platform,
    lstatImpl,
    readFileImpl,
    realpathImpl,
  });
}

export function assertPrivateFile(
  metadata,
  label,
  platform = process.platform,
) {
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new TypeError(
      `${label} deve ser arquivo regular e não link simbólico`,
    );
  }
  assertPrivateMode(metadata, 0o600, label, platform);
}

export function assertPrivateDirectory(
  metadata,
  label,
  platform = process.platform,
) {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError(
      `${label} deve ser diretório regular e não link simbólico`,
    );
  }
  assertPrivateMode(metadata, 0o700, label, platform);
}
