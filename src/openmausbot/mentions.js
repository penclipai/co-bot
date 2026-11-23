/**
 * @mention 解析、防误触掩码、日程/时间解析与有界集合辅助函数（纯函数，零外部依赖）。
 */

export function compactChatCtx(chatCtx) {
  if (!chatCtx) return null;
  if (!chatCtx.isExternal) {
    if (chatCtx.polishDraft?.originChatId) {
      return {
        isExternal: false,
        polishDraft: {
          originChatId: chatCtx.polishDraft.originChatId,
          originChatName: chatCtx.polishDraft.originChatName || '',
          originChatType: chatCtx.polishDraft.originChatType || 'group',
          replyToImMsgId: chatCtx.polishDraft.replyToImMsgId ?? null,
          addBotPrefix: Boolean(chatCtx.polishDraft.addBotPrefix),
          ...(chatCtx.polishDraft.delegationRe ? { delegationRe: chatCtx.polishDraft.delegationRe } : {}),
        },
      };
    }
    return null;
  }
  return {
    isExternal: true,
    originChatId: chatCtx.originChatId,
    chatType: chatCtx.chatType,
    chatName: chatCtx.chatName || '',
    replyChatId: chatCtx.replyChatId,
    controlChatId: chatCtx.controlChatId,
    replyToImMsgId: chatCtx.replyToImMsgId ?? null,
    originQuoteId: chatCtx.originQuoteId ?? null,
    privateReply: Boolean(chatCtx.privateReply),
    silentProgress: Boolean(chatCtx.silentProgress),
    readonly: Boolean(chatCtx.readonly),
    draftFirst: Boolean(chatCtx.draftFirst),
    ...(chatCtx.collaborator ? { collaborator: chatCtx.collaborator } : {}),
    ...(Array.isArray(chatCtx.allowedProjects) ? { allowedProjects: [...chatCtx.allowedProjects] } : {}),
    ...(chatCtx.delegationReq ? { delegationReq: { ...chatCtx.delegationReq } } : {}),
  };
}

/** 计算两个字符串的 Levenshtein 编辑距离（用于配置键名与指令拼写容错提示）。 */
export function levenshtein(a, b) {
  const s = String(a ?? '');
  const t = String(b ?? '');
  const m = s.length;
  const n = t.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

export function buildMentionMatcher(trigger = '@bot', aliases = [], knownNames = []) {
  const bareTrigger = String(trigger || '@bot').replace(/^@/, '').trim().toLowerCase();
  const aliasSet = new Set(
    (Array.isArray(aliases) ? aliases : [])
      .map((a) => String(a ?? '').replace(/^@/, '').trim().toLowerCase())
      .filter(Boolean),
  );
  const knownSet = new Set(
    (Array.isArray(knownNames) ? knownNames : [])
      .map((n) => String(n ?? '').replace(/^@/, '').trim().toLowerCase())
      .filter(Boolean),
  );
  const isDefaultName = (name) => {
    const low = String(name ?? '').trim().toLowerCase();
    return /^(bot|ai|主bot|co-bot|cobot)$/i.test(low) || (bareTrigger && low === bareTrigger) || aliasSet.has(low);
  };
  const isKnownBotOrGroup = (name) => {
    const low = String(name ?? '').trim().toLowerCase();
    return isDefaultName(low) || knownSet.has(low);
  };
  return { isDefaultName, isKnownBotOrGroup };
}

export function parseStartMention(rawText, trigger = '@bot', aliases = [], knownNames = []) {
  const { isDefaultName } = buildMentionMatcher(trigger, aliases, knownNames);
  const atMatch = rawText.match(/^@([^\s\u200B!:：,，]+)(!)?[\s:：,，]*([\s\S]*)$/);
  if (atMatch) {
    const mention = atMatch[1];
    return {
      mention,
      bang: Boolean(atMatch[2]),
      bodyText: atMatch[3].trim(),
      isDefault: isDefaultName(mention),
      atStart: true,
    };
  }

  // 支持不带 `@` 前缀的自定义触发词（例如 `co-bot ...` 或显式配置的无 @ 别名）
  if (trigger && !String(trigger).startsWith('@')) {
    const esc = String(trigger).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const customM = rawText.match(new RegExp(`^${esc}(!)?(?:[\\s:：,，]+([\\s\\S]*))?$`, 'i'));
    if (customM) {
      return {
        mention: trigger,
        bang: Boolean(customM[1]),
        bodyText: (customM[2] ?? '').trim(),
        isDefault: true,
        atStart: true,
      };
    }
  }
  return null;
}

export function maskNonTriggerSpans(s) {
  return String(s ?? '').replace(
    /(```[\s\S]*?```|`[^`\n]+`|「[^」\n]*」|"[^"\n]*"|'[^'\n]*')/g,
    (m) => ' '.repeat(m.length),
  );
}

export function parseInlineTriggerMention(rawText, trigger = '@bot', aliases = [], knownNames = []) {
  const { isDefaultName, isKnownBotOrGroup } = buildMentionMatcher(trigger, aliases, knownNames);
  const masked = maskNonTriggerSpans(rawText);
  const re = /(^|[^A-Za-z0-9._%+-])@([^\s@\u200B!:：,，;；)）\]】」』"'”’?？]+)(!)?/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    const mention = m[2];
    if (!isKnownBotOrGroup(mention)) continue;
    const tokStart = m.index + m[1].length;
    const tokEnd = m.index + m[0].length;
    const before = rawText.slice(0, tokStart);
    const after = rawText.slice(tokEnd).replace(/^[\s:：,，]*/, ' ');
    const bodyText = `${before}${after}`.replace(/\s+/g, ' ').trim();
    return {
      mention,
      bang: Boolean(m[3]),
      bodyText,
      isDefault: isDefaultName(mention),
      atStart: false,
    };
  }
  return null;
}

export function hasNonBotMention(rawText, trigger = '@bot', aliases = [], knownNames = [], structuredMentions = []) {
  const { isKnownBotOrGroup } = buildMentionMatcher(trigger, aliases, knownNames);
  if (Array.isArray(structuredMentions) && structuredMentions.length) {
    for (const m of structuredMentions) {
      if (!m || m.isSelf || m.isAll) continue;
      const label = String(m.name || m.id || '').replace(/^@/, '').trim();
      if (label && !isKnownBotOrGroup(label)) return true;
    }
  }
  const masked = String(rawText ?? '').replace(/(```[\s\S]*?```|`[^`\n]+`)/g, ' ');
  const re = /(^|[^A-Za-z0-9._%+-])@([^\s@\u200B!:：,，;；)）\]】」』"'”’?？]+)/g;
  let m;
  while ((m = re.exec(masked)) !== null) {
    if (!isKnownBotOrGroup(m[2])) return true;
  }
  return false;
}

export function parseStructuredBotMention(rawText, structuredMentions = [], trigger = '@bot', aliases = [], knownNames = []) {
  if (!Array.isArray(structuredMentions) || !structuredMentions.length) return null;
  const { isDefaultName, isKnownBotOrGroup } = buildMentionMatcher(trigger, aliases, knownNames);
  for (const m of structuredMentions) {
    if (!m || m.isSelf || m.isAll) continue;
    const label = String(m.name || '').replace(/^@/, '').trim();
    if (!label || !isKnownBotOrGroup(label)) continue;
    return {
      mention: label,
      bang: false,
      bodyText: String(rawText ?? '').trim(),
      isDefault: isDefaultName(label),
      atStart: false,
    };
  }
  return null;
}

export function parseHHMM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

/** 判断指定时间戳是否落在免打扰时段（支持跨午夜，如 22:00 ~ 08:30）。 */
export function inQuietHours(nowMs, qh) {
  if (!qh?.enabled) return false;
  const a = parseHHMM(qh.start);
  const b = parseHHMM(qh.end);
  if (a == null || b == null || a === b) return false;
  const d = new Date(nowMs);
  const cur = d.getHours() * 60 + d.getMinutes();
  return a < b ? (cur >= a && cur < b) : (cur >= a || cur < b);
}

export function rememberBounded(set, val, cap = 1000) {
  if (!val) return;
  set.add(String(val));
  if (set.size > cap) set.delete(set.values().next().value);
}
