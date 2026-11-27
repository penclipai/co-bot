/**
 * 极简项目白名单与会话目录绑定：支持配置映射、@bot bind 解析及提示词作用域声明。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectConfig, ProjectRef } from '../types.ts';

export interface ProjectMatchResult {
  ok: boolean;
  project?: ProjectRef;
  error?: string;
}

export interface ProjectBindingResolution {
  project: ProjectRef | null;
  source: 'explicit' | 'bound' | 'none';
}

const isPathLike = (s: string): boolean => /^(?:\.\.?[\\/]|\/|[a-zA-Z]:[\\/])/.test(s);
const normPathCmp = (p: string): string => {
  const resolved = path.resolve(String(p || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

function isSameOrInsidePath(candidate: string, root: string): boolean {
  const a = normPathCmp(candidate);
  const b = normPathCmp(root);
  if (a === b) return true;
  const prefix = b.endsWith(path.sep) ? b : `${b}${path.sep}`;
  return a.startsWith(prefix);
}

function escapeRegExp(s: string): string {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeAliases(raw: unknown, name: string): string[] {
  const arr = Array.isArray(raw)
    ? raw
    : (typeof raw === 'string' ? raw.split(',') : []);
  const set = new Set<string>();
  for (const item of arr) {
    const clean = String(item ?? '').trim().toLowerCase();
    if (clean && clean !== String(name || '').trim().toLowerCase()) set.add(clean);
  }
  return [...set];
}

/** 归一化 `config.projects`（支持数组或 `{ name: path | obj }` 映射）。 */
export function normalizeProjectsConfig(rawProjects: unknown, baseDir = process.cwd()): ProjectConfig[] {
  if (!rawProjects) return [];
  const entries: ProjectConfig[] = [];
  const pushOne = (nameRaw: unknown, val: unknown): void => {
    const obj = val && typeof val === 'object' ? (val as Record<string, unknown>) : null;
    const name = String(nameRaw ?? obj?.name ?? '').trim();
    const rawPath = typeof val === 'string' ? val.trim() : String(obj?.path ?? '').trim();
    if (!name || !rawPath) return;
    entries.push({
      name,
      path: path.resolve(baseDir, rawPath),
      aliases: normalizeAliases(obj?.aliases, name),
      ...(obj?.description ? { description: String(obj.description).trim() } : {}),
    });
  };

  if (Array.isArray(rawProjects)) {
    for (const item of rawProjects) {
      if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        pushOne(rec.name, rec);
      }
    }
  } else if (typeof rawProjects === 'object') {
    for (const [k, v] of Object.entries(rawProjects as Record<string, unknown>)) {
      pushOne(k, v);
    }
  }
  return entries;
}

/** 检查项目是否处于授权项目名列表中。 */
export function isProjectAuthorized(
  project: { name?: string; aliases?: string[] } | null | undefined,
  allowedProjects: string[] | null = null,
): boolean {
  if (!Array.isArray(allowedProjects) || allowedProjects.length === 0) return true;
  if (!project) return false;
  const allowSet = new Set(allowedProjects.map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));
  if (allowSet.has(String(project.name || '').trim().toLowerCase())) return true;
  return Array.isArray(project.aliases) && project.aliases.some((a) => allowSet.has(a.toLowerCase()));
}

function isAccessibleDir(absPath: string): boolean {
  try {
    return fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
  } catch {
    return false;
  }
}

/** 根据用户输入的项目名、别名或路径解析待绑定项目。 */
export function matchProjectSpec(
  query: unknown,
  projects: ProjectConfig[] = [],
  { allowArbitraryPath = true, baseDir = process.cwd() }: { allowArbitraryPath?: boolean; baseDir?: string } = {},
): ProjectMatchResult {
  const q = String(query ?? '').trim();
  if (!q) return { ok: false, error: '请提供项目名称或本地目录路径' };
  const qLow = q.toLowerCase();

  const exact = projects.find((p) => p.name.toLowerCase() === qLow || p.aliases.includes(qLow));
  if (exact) return { ok: true, project: { name: exact.name, path: exact.path } };

  const fuzzy = projects.find((p) => p.name.toLowerCase().includes(qLow) || p.aliases.some((a) => a.includes(qLow)));
  if (fuzzy) return { ok: true, project: { name: fuzzy.name, path: fuzzy.path } };

  if (isPathLike(q) || path.isAbsolute(q)) {
    const abs = path.resolve(baseDir, q);
    if (projects.length > 0) {
      const rootHit = projects.find((p) => isSameOrInsidePath(abs, p.path));
      if (!rootHit) {
        return { ok: false, error: `路径「${abs}」不在已配置的 projects 白名单目录内` };
      }
      if (!isAccessibleDir(abs)) {
        return { ok: false, error: `目录不存在或不可访问：${abs}` };
      }
      return { ok: true, project: { name: rootHit.name, path: abs } };
    }
    if (!allowArbitraryPath) {
      return { ok: false, error: '未配置允许任意路径绑定' };
    }
    if (!isAccessibleDir(abs)) {
      return { ok: false, error: `目录不存在或不可访问：${abs}` };
    }
    return { ok: true, project: { name: path.basename(abs) || abs, path: abs } };
  }

  return { ok: false, error: `未找到匹配项目「${q}」` };
}

function matchesProjectMention(text: string, token: string): boolean {
  const t = String(token ?? '').trim();
  if (!t) return false;
  if (/^[A-Za-z0-9_-]+$/.test(t)) {
    return new RegExp(`(?:^|[^A-Za-z0-9_-])${escapeRegExp(t)}(?:$|[^A-Za-z0-9_-])`, 'i').test(text);
  }
  return String(text).toLowerCase().includes(t.toLowerCase());
}

/** 检测文本是否显式提及了未被 allowedProjects 授权的已配置项目。 */
export function findUnauthorizedProjectMention(
  text: string,
  projects: ProjectConfig[] = [],
  allowedProjects: string[] | null = null,
): ProjectConfig | null {
  if (!text || !Array.isArray(projects) || !projects.length) return null;
  if (!Array.isArray(allowedProjects) || !allowedProjects.length) return null;
  for (const p of projects) {
    if (isProjectAuthorized(p, allowedProjects)) continue;
    const tokens = [p.name, ...(p.aliases ?? [])];
    if (tokens.some((tok) => matchesProjectMention(text, tok))) return p;
  }
  return null;
}

const ABS_FS_PATH_RE = /[a-zA-Z]:[\\/][^\s"'`<>|*?]+|\/(?:srv|home|Users|var|etc|opt|tmp|root|mnt|Volumes)\/[^\s"'`]+/g;

/** 检测文本中是否包含落在授权项目目录之外的本机绝对路径（防越界路径探测）。 */
export function findUnauthorizedPathMention(
  text: string,
  projects: ProjectConfig[] = [],
  allowedProjects: string[] | null = null,
): string | null {
  if (!text || !Array.isArray(allowedProjects) || !allowedProjects.length) return null;
  const authorizedRoots = projects
    .filter((p) => p?.path && isProjectAuthorized(p, allowedProjects))
    .map((p) => p.path);
  const matches = String(text).match(ABS_FS_PATH_RE);
  if (!matches) return null;
  for (const rawHit of matches) {
    const clean = rawHit.replace(/[),.;:!?，。；：！？]+$/, '');
    if (!clean) continue;
    const insideAllowed = authorizedRoots.some((root) => isSameOrInsidePath(clean, root));
    if (!insideAllowed) return clean;
  }
  return null;
}

/**
 * 解析当次提问的目标代码作用域（优先级：显式提及白名单项目 > 会话已绑定项目 > 无绑定）。
 */
export function resolveProjectBinding({
  text = '',
  chatId = '',
  chatProjects = null,
  projects = [],
  allowedProjects = null,
}: {
  text?: string;
  chatId?: string;
  chatProjects?: Map<string, ProjectRef> | null;
  projects?: ProjectConfig[];
  allowedProjects?: string[] | null;
} = {}): ProjectBindingResolution {
  const candidates = projects.filter((p) => isProjectAuthorized(p, allowedProjects));
  const tokPairs: Array<{ token: string; project: ProjectConfig }> = [];
  for (const p of candidates) {
    tokPairs.push({ token: p.name, project: p });
    for (const a of p.aliases ?? []) tokPairs.push({ token: a, project: p });
  }
  tokPairs.sort((a, b) => b.token.length - a.token.length);

  if (text && tokPairs.length) {
    for (const { token, project } of tokPairs) {
      if (matchesProjectMention(text, token)) {
        return { project: { name: project.name, path: project.path }, source: 'explicit' };
      }
    }
  }

  const bound = chatId && chatProjects ? chatProjects.get(String(chatId)) : null;
  if (bound?.path) {
    const matchedCfg = projects.find((p) => p.name.toLowerCase() === String(bound.name || '').toLowerCase()
      || normPathCmp(p.path) === normPathCmp(bound.path));
    if (!Array.isArray(allowedProjects) || allowedProjects.length === 0
      || isProjectAuthorized(matchedCfg || bound, allowedProjects)) {
      return {
        project: { name: bound.name || path.basename(bound.path), path: bound.path },
        source: 'bound',
      };
    }
  }

  return { project: null, source: 'none' };
}

/** 构造注入给 OpenMausBot 的工作目录边界说明。 */
export function formatProjectContextBlock({
  project = null,
  source = 'none',
  isExternal = false,
  isReadonly = false,
}: {
  project?: ProjectRef | null;
  source?: string;
  isExternal?: boolean;
  isReadonly?: boolean;
} = {}): string {
  if (project?.path) {
    return [
      '<workspace-scope>',
      `bound_project: ${project.name}`,
      `workspace_path: ${project.path}`,
      `scope_source: ${source}`,
      'scope_rule: restrict code/repository inspection to workspace_path only; do NOT scan unrelated local directories.',
      '</workspace-scope>',
      '',
    ].join('\n') + '\n';
  }
  if (isExternal || isReadonly) {
    return [
      '<workspace-scope>',
      'bound_project: none',
      'scope_rule: no project directory is bound to this chat; answer only from conversation context and shared docs if provided. Do NOT browse unrelated local codebases.',
      '</workspace-scope>',
      '',
    ].join('\n') + '\n';
  }
  return '';
}
