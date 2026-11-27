/**
 * 内网自定义出站脱敏规则插件模板（默认以 `_` 开头且带 `.example.` 后缀，不会被自动加载）。
 *
 * 使用方法：
 *   1. 复制为 `plugins/custom-redactor.ts`（去掉开头的 `_` 与 `.example`）
 *   2. 按需修改正则与替换策略，保存后重启或在 `/debug` 诊断台点击「重载」即可生效
 *   3. 支持匹配内网员工工号、内部项目代号与内网 Git/Wiki 地址等敏感标识
 */
import type { KernelContext, SecurityExtensionService } from '../src/types.ts';

export const name = 'custom-redactor';
export const kind = 'extension';
export const version = '1.0.0';
export const inject = ['security'];

export function apply(ctx: KernelContext): void {
  const security = ctx.get<SecurityExtensionService>('security');

  // 1. 内网工号（示例：EMP-123456 或 U123456）
  security.registerRedactor({
    name: 'intranet_employee_id',
    pattern: /\bEMP-\d{4,8}\b/gi,
    replace: '[EMP-REDACTED]',
  });

  // 2. 内网私有服务令牌 / 工单内部编号（示例：INTRA-TOK-xxxx）
  security.registerRedactor({
    name: 'intranet_service_token',
    pattern: /\bINTRA-TOK-[A-Za-z0-9_-]{8,}\b/g,
    replace: '[INTRA-TOKEN-REDACTED]',
  });

  // 3. 内网域名中的敏感 Query 参数（如 ?ticket= / &sso_token=）
  security.registerRedactor({
    name: 'intranet_url_ticket',
    pattern: /(https?:\/\/[A-Za-z0-9.-]+\.(?:internal|corp|lan)[^\s]*?[?&](?:ticket|sso_token)=)([^&\s]+)/gi,
    replace: '$1[REDACTED]',
  });
}
