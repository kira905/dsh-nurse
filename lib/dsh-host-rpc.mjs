/**
 * dsh-host-rpc.mjs —— DSH Host HTTP RPC 适配层（**发布版薄壳**）
 *
 * 与私有树里的同名文件**导出面逐字一致**，但实现只做两件事：
 *   ① re-export 可发布件 `./dsh-rpc-client.mjs`（端点表 / 双栈回落 / 请求发送；
 *      cookie 由**显式参数 / env / 可选本机凭据件**三路注入，客户端件自身零 fs、零凭据路径）；
 *   ② 本文件承载 `withDshHome()`（调用期间把 `BUTLER_DSH_HOME` 指向目标 home，`finally` 还原）。
 *
 * 与私有树的差别（如实登记）：
 *   · 私有树里本文件还聚合了「本机凭据解析件」（读 `~/.dsh/.credentials.yaml`）——
 *     那一半**不随公开批发布**；`dsh-rpc-client.mjs` 会用 `createRequire` + try/catch
 *     **运行时可选探测**它，公开环境没有 = 无本机凭据（与"凭据文件读不到"同一语义）。
 *   · 因此：想在没有本机凭据件的机器上用 cookie 鉴权，请显式传 `cookieSecret`，
 *     或设环境变量 `DSH_RPC_COOKIE_SECRET`（base64 secret）。
 *
 * 行为口径（与私有树同源）：0.1.4 旧点号 `POST /api/<ns>.<method>` 无鉴权；
 * 0.1.5-rc.2 端点路径段化 + `method` 与端点串逐字相同 + `payload.args.<wire>` +
 * `/api` cookie 鉴权门（`dsh-auth-<sha256(authority)>`，HMAC-SHA256）。
 * 红线：**不硬编码 token、不关鉴权门**。
 */

export * from './dsh-rpc-client.mjs';

import {
  hostRpc, hostRpcJson, hostRpcValue, hostCookie,
  detectStack, clearCookieCache, ENDPOINT_TABLE, REMOVED_ENDPOINTS,
} from './dsh-rpc-client.mjs';

/**
 * 在指定 home 口径下跑一段（同步或异步）逻辑：临时把 `BUTLER_DSH_HOME` 指向 `home`，**用完必定还原**。
 *
 * 为什么需要它：cookie 自签密钥取「home 口径」（`BUTLER_DSH_HOME > DSH_HOME > ~/.dsh`）
 * —— 即 **cookie 绑定的是「home 口径」**。对**隔离实例**取页面 / 发 RPC 时目标 home 不是生产 home
 * ⇒ 必须调用期间改道，否则一律 **401**（活着的实例被看成死的）。
 *
 * ⚠️ 改的是**进程级 env** ⇒ 只在单点调用期间改道、`finally` 还原（不并发调用、不跨请求残留）。
 * ⚠️ 传 `null` / `undefined` / `''` 视为「不改道、直接跑」。
 *
 * @template T
 * @param {string|null|undefined} home 目标 home（如 `<safeRoot>`）
 * @param {() => T|Promise<T>} fn 要执行的逻辑
 * @returns {Promise<T>}
 */
export async function withDshHome(home, fn) {
  if (home === null || home === undefined || home === '') return await fn();
  const prev = process.env.BUTLER_DSH_HOME;
  process.env.BUTLER_DSH_HOME = String(home);
  try { return await fn() } finally {
    if (prev === undefined) delete process.env.BUTLER_DSH_HOME;
    else process.env.BUTLER_DSH_HOME = prev;
  }
}

export default { hostRpc, hostRpcJson, hostRpcValue, hostCookie, withDshHome, detectStack, clearCookieCache, ENDPOINT_TABLE, REMOVED_ENDPOINTS };
