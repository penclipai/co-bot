/**
 * 统一 2 档外部白名单准入策略：strict owner 之外仅允许白名单同事触发受控只读协助。
 *   - confirm_in_self（默认）：只读查明后先私密回自聊由主人确认发送
 *   - auto_readonly：限定授权项目内只读查明后带 🤖 标识自动回复
 */
import type {
  CollaboratorPolicy,
  CollaboratorRule,
  InboundEvent,
  InboundPolicyDecision,
} from '../types.ts';

const VALID_POLICIES = new Set<CollaboratorPolicy>(['confirm_in_self', 'auto_readonly']);

function toStrList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/** 归一化 `chats.collaborators` 白名单配置（支持数组或 `{ id: cfg }` 对象）。 */
export function normalizeCollaborators(raw: unknown): CollaboratorRule[] {
  if (!raw) return [];
  const out: CollaboratorRule[] = [];
  const seen = new Set<string>();
  const pushOne = (idRaw: unknown, item: unknown): void => {
    const obj = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const id = String(idRaw ?? obj.id ?? '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);
    const rawPolicy = typeof obj.policy === 'string' ? (obj.policy as CollaboratorPolicy) : 'confirm_in_self';
    const pol: CollaboratorPolicy = VALID_POLICIES.has(rawPolicy) ? rawPolicy : 'confirm_in_self';
    out.push({
      id,
      name: obj.name ? String(obj.name).trim() : '',
      policy: pol,
      projects: toStrList(obj.projects),
      chats: toStrList(obj.chats),
    });
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item === 'string') pushOne(item, {});
      else if (item && typeof item === 'object') {
        const rec = item as Record<string, unknown>;
        pushOne(rec.id, rec);
      }
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      pushOne(k, v);
    }
  }
  return out;
}

/** 评估入站事件触发权限；非本人与非白名单发送者一律拒绝。 */
export function evaluateInboundPolicy(
  ev: Partial<InboundEvent> | null | undefined,
  {
    collaborators = [],
    chatAllowed = true,
    isDelegationReq = false,
  }: {
    collaborators?: CollaboratorRule[] | unknown;
    chatAllowed?: boolean;
    isDelegationReq?: boolean;
  } = {},
): InboundPolicyDecision {
  if (ev?.sender?.isSelf) {
    return { allowed: true, role: 'owner', mode: 'owner', readonly: false, allowedProjects: null };
  }
  if (!ev || !ev.chat?.id) {
    return { allowed: false, reason: 'invalid_event' };
  }
  if ((ev.chat.type || 'direct') === 'self') {
    return { allowed: false, reason: 'non_self_in_self_chat' };
  }
  if (isDelegationReq && (ev.chat.type || 'direct') !== 'direct') {
    return { allowed: false, reason: 'delegation_requires_direct' };
  }
  if (!chatAllowed) {
    return { allowed: false, reason: 'chat_not_allowed' };
  }

  const senderId = String(ev.sender?.id ?? '').trim();
  if (!senderId) {
    return { allowed: false, reason: 'missing_sender_id' };
  }
  const list = Array.isArray(collaborators)
    ? normalizeCollaborators(collaborators)
    : normalizeCollaborators(collaborators);
  const entry = list.find((c) => c.id === senderId);
  if (!entry) {
    return { allowed: false, reason: 'not_in_whitelist' };
  }

  const chatId = String(ev.chat.id);
  if (entry.chats.length > 0 && !entry.chats.includes(chatId)) {
    return { allowed: false, reason: 'chat_not_authorized' };
  }

  return {
    allowed: true,
    role: 'collaborator',
    mode: entry.policy,
    readonly: true,
    collaborator: {
      id: entry.id,
      name: entry.name || ev.sender?.name || entry.id,
    },
    allowedProjects: entry.projects.length > 0 ? [...entry.projects] : null,
    isDelegationReq: Boolean(isDelegationReq),
  };
}

/** 为外部白名单同事请求注入强只读安全护栏提示头。 */
export function formatReadonlyGuardBlock({
  collaborator = null,
  allowedProjects = null,
}: {
  collaborator?: { id?: string; name?: string } | null;
  allowedProjects?: string[] | null;
} = {}): string {
  const who = collaborator?.name || collaborator?.id || 'colleague';
  const lines = [
    '<readonly-guard>',
    `caller_role: external_collaborator (${who})`,
    'access_level: STRICT_READONLY',
  ];
  if (Array.isArray(allowedProjects) && allowedProjects.length > 0) {
    lines.push(`allowed_projects: ${allowedProjects.join(', ')}`);
  }
  lines.push(
    'hard_rules: You may ONLY inspect authorized read-only materials and answer concisely. NEVER edit, create, or delete files, NEVER run mutating commands, NEVER modify long-term memory, and NEVER disclose owner\'s private self-chat history, config, or secrets.',
    '</readonly-guard>',
    '',
  );
  return `${lines.join('\n')}\n`;
}
