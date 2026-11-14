/**
 * dsh-composer-draft-keeper —— host 半（最小实现）
 *
 * 为什么这里几乎是空的：
 *   `dsh.bundle.patch` 的 `insert: [{id, name}]` 会让宿主 import 我们的包并调用 `apply()`，
 *   所以 `main` 必须指向一个合法的 ESM 模块（BRIEF §12.5 做法 A）。草稿镜像、恢复、
 *   孤儿清理、设置卡片全部在 `lib/client.js`（前端半）里完成 —— 那里才有 localStorage、
 *   session 作用域插槽和 `inputActions`。
 *
 *   host 半如果去写路由 / 定时器，就多一个故障面，却换不来任何能力：
 *   浏览器存储只能在浏览器里读写，Node 侧碰不到。
 *
 * 保留这个文件的两个理由：
 *   1. 满足 bundle 机制（缺 main 或 main 不是 ESM，宿主 import 会失败）；
 *   2. 以后若要加真正需要 host 的东西（例如跨设备的清理提示、卸载时的残留提示），
 *      有现成的挂载点，不用改 package.json。
 */

export const name = 'dsh-composer-draft-keeper'

/**
 * 宿主加载时调用。当前没有任何 host 侧工作要做，因此刻意留空，
 * 也不声明 `inject`（声明了就必须等到那些服务，插件会一直 pending）。
 */
export function apply() {}
