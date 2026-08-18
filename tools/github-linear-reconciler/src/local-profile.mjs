import { execFile as nodeExecFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat as nodeLstat,
  mkdir as nodeMkdir,
  open as nodeOpen,
  readFile as nodeReadFile,
  realpath as nodeRealpath,
  rename as nodeRename,
  rmdir as nodeRmdir,
  unlink as nodeUnlink,
} from "node:fs/promises";
import { homedir as readHomeDirectory } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

export const PROFILE_MARKER_NAME = ".github-linear-reconciler-profile.json";
export const WINDOWS_FULL_CONTROL_MASK = 2_032_127;
const WINDOWS_SYSTEM_SID = "S-1-5-18";
const WINDOWS_ACL_MAX_BUFFER = 64 * 1_024;
const executeFile = promisify(nodeExecFile);
const PROFILE_MARKER_CONTENT = `${JSON.stringify({
  schemaVersion: 1,
  application: "github-linear-reconciler",
})}\n`;

const WINDOWS_ACL_INSPECTION_SCRIPT = `
$ErrorActionPreference = 'Stop'
$targetPath = [Environment]::GetEnvironmentVariable('GITHUB_LINEAR_RECONCILER_ACL_PATH', 'Process')
if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'missing ACL target path' }
$acl = Get-Acl -LiteralPath $targetPath
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$ownerSid = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
$rules = @($acl.Access | ForEach-Object {
  [ordered]@{
    sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
    type = $_.AccessControlType.ToString()
    rights = [int64]$_.FileSystemRights
    inherited = [bool]$_.IsInherited
    inheritanceFlags = [int]$_.InheritanceFlags
    propagationFlags = [int]$_.PropagationFlags
  }
})
[ordered]@{
  currentSid = $currentSid
  ownerSid = $ownerSid
  accessRulesProtected = [bool]$acl.AreAccessRulesProtected
  accessRules = $rules
} | ConvertTo-Json -Depth 4 -Compress
`;

const WINDOWS_DIRECTORY_CREATE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$targetPath = [Environment]::GetEnvironmentVariable('GITHUB_LINEAR_RECONCILER_ACL_PATH', 'Process')
if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'missing directory target path' }
$targetPath = [System.IO.Path]::GetFullPath($targetPath)
if ([System.IO.Directory]::Exists($targetPath) -or [System.IO.File]::Exists($targetPath)) {
  throw 'directory target already exists'
}
$parentPath = [System.IO.Path]::GetDirectoryName($targetPath)
if (-not [System.IO.Directory]::Exists($parentPath)) { throw 'directory parent does not exist' }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$acl = [System.Security.AccessControl.DirectorySecurity]::new()
$acl.SetOwner($currentSid)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
$propagation = [System.Security.AccessControl.PropagationFlags]::None
foreach ($sid in @($currentSid, $systemSid)) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
    $sid,
    [System.Security.AccessControl.FileSystemRights]::FullControl,
    $inheritance,
    $propagation,
    [System.Security.AccessControl.AccessControlType]::Allow
  )
  [void]$acl.AddAccessRule($rule)
}
$created = [System.IO.Directory]::CreateDirectory($targetPath, $acl)
if (-not $created.Exists) { throw 'directory creation did not materialize' }
`;

const WINDOWS_ACL_SET_SCRIPT = `
$ErrorActionPreference = 'Stop'
$targetPath = [Environment]::GetEnvironmentVariable('GITHUB_LINEAR_RECONCILER_ACL_PATH', 'Process')
$targetKind = [Environment]::GetEnvironmentVariable('GITHUB_LINEAR_RECONCILER_ACL_KIND', 'Process')
if ([string]::IsNullOrWhiteSpace($targetPath)) { throw 'missing ACL target path' }
if ($targetKind -ne 'file' -and $targetKind -ne 'directory') { throw 'invalid ACL target kind' }
$item = Get-Item -LiteralPath $targetPath -Force
if (($targetKind -eq 'directory') -ne [bool]$item.PSIsContainer) { throw 'ACL target kind mismatch' }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if ($targetKind -eq 'directory') {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
  $propagation = [System.Security.AccessControl.PropagationFlags]::None
  foreach ($sid in @($currentSid, $systemSid)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      $inheritance,
      $propagation,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
} else {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
  foreach ($sid in @($currentSid, $systemSid)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
      $sid,
      [System.Security.AccessControl.FileSystemRights]::FullControl,
      [System.Security.AccessControl.AccessControlType]::Allow
    )
    [void]$acl.AddAccessRule($rule)
  }
}
$acl.SetOwner($currentSid)
$acl.SetAccessRuleProtection($true, $false)
Set-Acl -LiteralPath $targetPath -AclObject $acl
`;

function encodedPowerShell(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

function nativePowerShellPath(env) {
  const systemRoot = env.SystemRoot?.trim() || env.SYSTEMROOT?.trim();
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new TypeError(
      "SystemRoot absoluto é obrigatório para validar ACL Windows",
    );
  }
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

async function runWindowsAclPowerShell({
  candidate,
  kind,
  script,
  env,
  execFileImpl,
}) {
  const executable = nativePowerShellPath(env);
  const nativeModulePath = path.win32.join(
    env.SystemRoot?.trim() || env.SYSTEMROOT.trim(),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  );
  return execFileImpl(
    executable,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      encodedPowerShell(script),
    ],
    {
      encoding: "utf8",
      env: {
        ...env,
        GITHUB_LINEAR_RECONCILER_ACL_PATH: candidate,
        ...(kind ? { GITHUB_LINEAR_RECONCILER_ACL_KIND: kind } : {}),
        PSModulePath: nativeModulePath,
      },
      maxBuffer: WINDOWS_ACL_MAX_BUFFER,
      windowsHide: true,
    },
  );
}

export async function readWindowsAcl(
  candidate,
  { env = process.env, execFileImpl = executeFile } = {},
) {
  if (typeof candidate !== "string" || !path.win32.isAbsolute(candidate)) {
    throw new TypeError("caminho ACL Windows deve ser absoluto");
  }
  try {
    const result = await runWindowsAclPowerShell({
      candidate: path.win32.resolve(candidate),
      script: WINDOWS_ACL_INSPECTION_SCRIPT,
      env,
      execFileImpl,
    });
    if (typeof result?.stdout !== "string" || result.stdout.trim() === "") {
      throw new TypeError("PowerShell não retornou JSON ACL");
    }
    const parsed = JSON.parse(result.stdout.trim());
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("JSON ACL inválido");
    }
    return parsed;
  } catch (error) {
    throw new TypeError("não foi possível inspecionar ACL Windows", {
      cause: error,
    });
  }
}

export async function createPrivateWindowsDirectory(
  candidate,
  { env = process.env, execFileImpl = executeFile } = {},
) {
  if (typeof candidate !== "string" || !path.win32.isAbsolute(candidate)) {
    throw new TypeError("caminho de diretório Windows deve ser absoluto");
  }
  try {
    await runWindowsAclPowerShell({
      candidate: path.win32.resolve(candidate),
      kind: "directory",
      script: WINDOWS_DIRECTORY_CREATE_SCRIPT,
      env,
      execFileImpl,
    });
  } catch (error) {
    throw new TypeError(
      "não foi possível criar diretório Windows com ACL privada",
      { cause: error },
    );
  }
}

export async function setPrivateWindowsAcl(
  candidate,
  { kind, env = process.env, execFileImpl = executeFile } = {},
) {
  if (typeof candidate !== "string" || !path.win32.isAbsolute(candidate)) {
    throw new TypeError("caminho ACL Windows deve ser absoluto");
  }
  if (kind !== "file" && kind !== "directory") {
    throw new TypeError("tipo de caminho ACL Windows inválido");
  }
  try {
    await runWindowsAclPowerShell({
      candidate: path.win32.resolve(candidate),
      kind,
      script: WINDOWS_ACL_SET_SCRIPT,
      env,
      execFileImpl,
    });
  } catch (error) {
    throw new TypeError("não foi possível proteger ACL Windows", {
      cause: error,
    });
  }
}

function requireSid(value, label) {
  if (typeof value !== "string" || !/^S-(?:[0-9]+-)+[0-9]+$/u.test(value)) {
    throw new TypeError(`${label} contém SID inválido`);
  }
  return value.toUpperCase();
}

export function assertWindowsAclPolicy(acl, label, kind) {
  if (kind !== "file" && kind !== "directory") {
    throw new TypeError(`${label}: tipo ACL Windows inválido`);
  }
  if (!acl || typeof acl !== "object" || Array.isArray(acl)) {
    throw new TypeError(`${label}: ACL Windows inválida`);
  }
  const currentSid = requireSid(acl.currentSid, label);
  const ownerSid = requireSid(acl.ownerSid, label);
  if (ownerSid !== currentSid) {
    throw new TypeError(`${label}: owner deve ser o operador atual`);
  }
  if (acl.accessRulesProtected !== true) {
    throw new TypeError(`${label}: DACL deve estar protegida`);
  }
  if (!Array.isArray(acl.accessRules) || acl.accessRules.length === 0) {
    throw new TypeError(`${label}: DACL sem regras suficientes`);
  }

  const allowedSids = new Set([currentSid, WINDOWS_SYSTEM_SID]);
  const expectedInheritanceFlags = kind === "directory" ? 3 : 0;
  const accumulatedRights = new Map([...allowedSids].map((sid) => [sid, 0]));
  for (const rule of acl.accessRules) {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new TypeError(`${label}: regra ACL Windows inválida`);
    }
    const sid = requireSid(rule.sid, label);
    if (!allowedSids.has(sid)) {
      throw new TypeError(`${label}: principal não autorizado na DACL`);
    }
    if (rule.type !== "Allow") {
      throw new TypeError(`${label}: DACL aceita somente regras Allow`);
    }
    if (rule.inherited !== false) {
      throw new TypeError(`${label}: DACL contém regra herdada`);
    }
    if (rule.inheritanceFlags !== expectedInheritanceFlags) {
      throw new TypeError(`${label}: inheritanceFlags inválidas`);
    }
    if (rule.propagationFlags !== 0) {
      throw new TypeError(`${label}: propagationFlags inválidas`);
    }
    if (
      !Number.isSafeInteger(rule.rights) ||
      rule.rights < 0 ||
      rule.rights > 0x7fffffff
    ) {
      throw new TypeError(`${label}: direitos ACL Windows inválidos`);
    }
    accumulatedRights.set(sid, accumulatedRights.get(sid) | rule.rights);
  }
  for (const [sid, rights] of accumulatedRights) {
    if ((rights & WINDOWS_FULL_CONTROL_MASK) !== WINDOWS_FULL_CONTROL_MASK) {
      throw new TypeError(`${label}: direitos insuficientes para ${sid}`);
    }
  }
}

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
  {
    env,
    platform,
    lstatImpl,
    readFileImpl,
    readWindowsAclImpl,
    realpathImpl,
    requireCredentials = true,
  },
) {
  const rootMetadata = await lstatImpl(profileRoot);
  assertPrivateDirectory(rootMetadata, "raiz do profile", platform);

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
  assertPrivateFile(markerMetadata, "marker do profile", platform);
  const marker = await readFileImpl(markerPath, "utf8");
  if (marker !== PROFILE_MARKER_CONTENT) {
    throw new TypeError("marker do profile possui conteúdo inválido");
  }

  await assertPrivateDirectoryPath(
    profileRoot,
    rootMetadata,
    "raiz do profile",
    { env, platform, readWindowsAclImpl },
  );
  await assertPrivateFilePath(markerPath, markerMetadata, "marker do profile", {
    env,
    platform,
    readWindowsAclImpl,
  });

  const canonicalRoot = await realpathImpl(profileRoot);
  await assertOutsideGitWorktree(canonicalRoot, {
    candidateIsDirectory: true,
    lstatImpl,
    realpathImpl,
  });
  const credentialsPath = path.join(canonicalRoot, "credentials");
  let canonicalCredentialsPath = credentialsPath;
  if (requireCredentials) {
    const credentialsMetadata = await lstatImpl(credentialsPath);
    await assertPrivateDirectoryPath(
      credentialsPath,
      credentialsMetadata,
      "diretório de credenciais",
      { env, platform, readWindowsAclImpl },
    );
    canonicalCredentialsPath = await realpathImpl(credentialsPath);
    if (path.relative(credentialsPath, canonicalCredentialsPath) !== "") {
      throw new TypeError(
        "diretório de credenciais possui destino canônico inválido",
      );
    }
  }
  return Object.freeze({
    root: canonicalRoot,
    configPath: path.join(canonicalRoot, "config.json"),
    reportsPath: path.join(canonicalRoot, "reports"),
    credentialsPath: canonicalCredentialsPath,
  });
}

async function ensureOwnedCredentialsDirectory(
  profile,
  {
    env,
    platform,
    lstatImpl,
    mkdirImpl,
    readWindowsAclImpl,
    rmdirImpl,
    setWindowsAclImpl,
  },
) {
  let exists = true;
  try {
    await lstatImpl(profile.credentialsPath);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    exists = false;
  }
  if (exists) return;

  let created = false;
  try {
    await mkdirImpl(profile.credentialsPath, {
      recursive: false,
      mode: 0o700,
    });
    created = true;
    await hardenCreatedPrivatePath(profile.credentialsPath, {
      env,
      kind: "directory",
      label: "diretório de credenciais",
      lstatImpl,
      platform,
      readWindowsAclImpl,
      setWindowsAclImpl,
    });
  } catch (error) {
    if (created) {
      await rmdirImpl(profile.credentialsPath).catch((rmdirError) => {
        if (!isMissingPath(rmdirError)) throw rmdirError;
      });
    }
    throw error;
  }
}

export async function ensureOwnedLocalProfile({
  root,
  createWindowsDirectoryImpl = createPrivateWindowsDirectory,
  env = process.env,
  homedir,
  platform = process.platform,
  lstatImpl = nodeLstat,
  mkdirImpl = nodeMkdir,
  openImpl = nodeOpen,
  readFileImpl = nodeReadFile,
  readWindowsAclImpl = readWindowsAcl,
  realpathImpl = nodeRealpath,
  renameImpl = nodeRename,
  rmdirImpl = nodeRmdir,
  setWindowsAclImpl = setPrivateWindowsAcl,
  unlinkImpl = nodeUnlink,
  idFactory = randomUUID,
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

  let exists = true;
  try {
    await lstatImpl(profileRoot);
  } catch (error) {
    if (!isMissingPath(error)) throw error;
    exists = false;
  }

  if (!exists) {
    const uniqueId = String(idFactory()).replace(/[^a-zA-Z0-9_-]/gu, "");
    if (!uniqueId) throw new TypeError("identificador de staging inválido");
    const stagingRoot = path.join(
      parentPath,
      `.${path.basename(profileRoot)}.${process.pid}.${uniqueId}.tmp`,
    );
    const stagingMarkerPath = path.join(stagingRoot, PROFILE_MARKER_NAME);
    const stagingCredentialsPath = path.join(stagingRoot, "credentials");
    let markerHandle;
    let stagingCreated = false;
    let credentialsCreated = false;
    let movedToFinal = false;
    try {
      if (platform === "win32") {
        await createWindowsDirectoryImpl(stagingRoot, { env });
      } else {
        await mkdirImpl(stagingRoot, {
          recursive: false,
          mode: 0o700,
        });
      }
      stagingCreated = true;
      if (platform === "win32") {
        await assertPrivateDirectoryPath(
          stagingRoot,
          await lstatImpl(stagingRoot),
          "staging da raiz do profile",
          { env, platform, readWindowsAclImpl },
        );
      } else {
        await hardenCreatedPrivatePath(stagingRoot, {
          env,
          kind: "directory",
          label: "staging da raiz do profile",
          lstatImpl,
          platform,
          readWindowsAclImpl,
          setWindowsAclImpl,
        });
      }

      await mkdirImpl(stagingCredentialsPath, {
        recursive: false,
        mode: 0o700,
      });
      credentialsCreated = true;
      await hardenCreatedPrivatePath(stagingCredentialsPath, {
        env,
        kind: "directory",
        label: "diretório de credenciais",
        lstatImpl,
        platform,
        readWindowsAclImpl,
        setWindowsAclImpl,
      });

      markerHandle = await openImpl(stagingMarkerPath, "wx", 0o600);
      await hardenCreatedPrivatePath(stagingMarkerPath, {
        env,
        kind: "file",
        label: "marker do profile",
        lstatImpl,
        platform,
        readWindowsAclImpl,
        setWindowsAclImpl,
      });
      await markerHandle.writeFile(PROFILE_MARKER_CONTENT, "utf8");
      await markerHandle.sync();
      await markerHandle.close();
      markerHandle = undefined;
      await renameImpl(stagingRoot, profileRoot);
      movedToFinal = true;
      await assertPrivateDirectoryPath(
        profileRoot,
        await lstatImpl(profileRoot),
        "raiz do profile",
        { env, platform, readWindowsAclImpl },
      );
      const finalMarkerPath = path.join(profileRoot, PROFILE_MARKER_NAME);
      await assertPrivateFilePath(
        finalMarkerPath,
        await lstatImpl(finalMarkerPath),
        "marker do profile",
        { env, platform, readWindowsAclImpl },
      );
    } catch (error) {
      await markerHandle?.close().catch(() => {});
      const rollbackRoot = movedToFinal ? profileRoot : stagingRoot;
      const rollbackMarker = path.join(rollbackRoot, PROFILE_MARKER_NAME);
      const rollbackCredentials = path.join(rollbackRoot, "credentials");
      await unlinkImpl(rollbackMarker).catch((unlinkError) => {
        if (!isMissingPath(unlinkError)) throw unlinkError;
      });
      if (credentialsCreated) {
        await rmdirImpl(rollbackCredentials).catch((rmdirError) => {
          if (!isMissingPath(rmdirError)) throw rmdirError;
        });
      }
      if (stagingCreated) {
        await rmdirImpl(rollbackRoot).catch((rmdirError) => {
          if (!isMissingPath(rmdirError)) throw rmdirError;
        });
      }
      throw error;
    }
  }

  const baseProfile = await inspectOwnedProfile(profileRoot, {
    env,
    platform,
    lstatImpl,
    readFileImpl,
    readWindowsAclImpl,
    realpathImpl,
    requireCredentials: false,
  });
  await ensureOwnedCredentialsDirectory(baseProfile, {
    env,
    platform,
    lstatImpl,
    mkdirImpl,
    readWindowsAclImpl,
    rmdirImpl,
    setWindowsAclImpl,
  });
  const profile = await inspectOwnedProfile(profileRoot, {
    env,
    platform,
    lstatImpl,
    readFileImpl,
    readWindowsAclImpl,
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
  readWindowsAclImpl = readWindowsAcl,
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
    env,
    platform,
    lstatImpl,
    readFileImpl,
    readWindowsAclImpl,
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

export async function assertPrivateFilePath(
  candidate,
  metadata,
  label,
  {
    env = process.env,
    platform = process.platform,
    readWindowsAclImpl = readWindowsAcl,
  } = {},
) {
  assertPrivateFile(metadata, label, platform);
  if (platform !== "win32") return;
  assertWindowsAclPolicy(
    await readWindowsAclImpl(candidate, { env, kind: "file" }),
    label,
    "file",
  );
}

export async function assertPrivateDirectoryPath(
  candidate,
  metadata,
  label,
  {
    env = process.env,
    platform = process.platform,
    readWindowsAclImpl = readWindowsAcl,
  } = {},
) {
  assertPrivateDirectory(metadata, label, platform);
  if (platform !== "win32") return;
  assertWindowsAclPolicy(
    await readWindowsAclImpl(candidate, { env, kind: "directory" }),
    label,
    "directory",
  );
}

export async function hardenCreatedPrivatePath(
  candidate,
  {
    env = process.env,
    kind,
    label,
    lstatImpl = nodeLstat,
    platform = process.platform,
    readWindowsAclImpl = readWindowsAcl,
    setWindowsAclImpl = setPrivateWindowsAcl,
  } = {},
) {
  const assertPath =
    kind === "directory"
      ? assertPrivateDirectoryPath
      : kind === "file"
        ? assertPrivateFilePath
        : null;
  if (!assertPath) throw new TypeError("tipo de caminho privado inválido");
  if (platform === "win32") {
    await setWindowsAclImpl(candidate, { env, kind });
  }
  await assertPath(candidate, await lstatImpl(candidate), label, {
    env,
    platform,
    readWindowsAclImpl,
  });
}
