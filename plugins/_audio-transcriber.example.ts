/**
 * 内网语音转文字（ASR）扩展插件模板（零三方依赖，使用内置 `fetch` 对接内网语音识别服务）。
 *
 * 使用方法：
 *   1. 复制为 `plugins/audio-transcriber.ts`（去掉开头的 `_` 与 `.example`）
 *   2. 在 `config.json` 中配置：
 *      `"plugins": { "audio-transcriber": { "endpoint": "http://asr.internal:8080/v1/transcribe", "timeoutMs": 15000 } }`
 *      或设置环境变量 `COBOT_ASR_ENDPOINT`
 *   3. 收到语音/音频附件时，Bridge 会自动调用注册的转写钩子并将文本注入 `<im-context>`
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { HooksExtensionService, InboundAttachment, KernelContext } from '../src/types.ts';

export const name = 'audio-transcriber';
export const kind = 'extension';
export const version = '1.0.0';
export const inject = ['hooks'];

export function apply(ctx: KernelContext, options: Record<string, unknown> = {}): void {
  const hooks = ctx.get<HooksExtensionService>('hooks');
  const logger = ctx.logger;
  const endpoint = String(options.endpoint ?? process.env.COBOT_ASR_ENDPOINT ?? '').trim();
  const apiKey = String(options.apiKey ?? process.env.COBOT_ASR_API_KEY ?? '').trim();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 15_000) || 15_000);

  hooks.registerAudioTranscriber(async (filePath: string, att: InboundAttachment) => {
    if (!endpoint) return null;
    try {
      const buf = await fs.readFile(filePath);
      const form = new FormData();
      const mime = att.mime || 'application/octet-stream';
      const filename = path.basename(att.name || filePath || 'audio.wav');
      form.append('file', new Blob([buf], { type: mime }), filename);
      if (Number(att.durationSec) > 0) {
        form.append('duration_sec', String(att.durationSec));
      }

      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      timer.unref?.();
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
          body: form,
          signal: ac.signal,
        });
        if (!res.ok) {
          logger?.warn?.(`[audio-transcriber] 内网 ASR 返回 ${res.status} (${filename})`);
          return null;
        }
        const data = (await res.json().catch(() => null)) as { text?: unknown; transcript?: unknown } | null;
        const text = typeof data?.text === 'string'
          ? data.text
          : (typeof data?.transcript === 'string' ? data.transcript : '');
        return text.trim() || null;
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      logger?.warn?.(`[audio-transcriber] 转写失败：${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  });
}
