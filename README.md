# 华天 wise 晚寝签到 · 青龙面板自动签到 + 企业微信推送

每天 21:01 自动完成「学生晚寝签到1」（签到时段 21:00–23:00），结果推送到企业微信群机器人。

**主用脚本：[wise_dorm_sign.js](wise_dorm_sign.js)**（青龙面板 / 任意 Node 服务器，零依赖）

> 另附 [wise_dorm_sign.sh](wise_dorm_sign.sh) 为 OpenWrt / busybox 备用版。**只支持单账号**，多账号汇总推送只在 `.js` 版里有。

---

## 一、青龙「订阅」自动建任务（推荐）

想让青龙订阅拉取 Gitee 仓库后自动把签到任务建好，按下面做（只做一次）。

### 创建订阅

「订阅管理」→「新建订阅」，在名称或链接框里粘贴下面这段（换成你自己的仓库地址）：

```
ql repo https://gitee.com/xutiaotiao0124/late-night-check-in-script wise_dorm_sign.js "" "" ""
```

青龙会自动解析填好各字段。

> 只想拉单个文件用 `ql raw https://…/wise_dorm_sign.js`。

---

## 原理（为什么异地服务器也能签）

签到页把手机 GPS 经纬度当普通数字塞进 `POST /api/flySource-yxgl/dormSignRecord/stuSign` 的 body。服务端只用 haversine 算「提交坐标 ↔ 宿舍登记坐标」的距离，再和允许半径（本任务 **400 米**）比较。

- 不校验 IP、设备、也不校验是否真在定位。
- 所以青龙服务器在哪都行，**把坐标写成宿舍附近即可，不需要模拟定位**。

默认提交坐标 `88.88888888888, 88.888888888888`（距宿舍登记点约 23.7 米），每次在 3 米内随机抖动。

---

## 二、青龙部署（改两行 + 填账号）

### 1. 新建脚本

「脚本管理」→ 新建 → 文件名 `wise_dorm_sign.js`，把脚本内容整段粘贴保存。**不需要 `npm install`**，只用 Node 内置的 `https` / `crypto`。

### 2. 改配置区

脚本顶部的 `const SETTINGS = { … }` 是唯一要调的地方：

```js
const SETTINGS = {
  SIGN_URL: '',                    // 签到链接（必填）
  LAT: 88.888888888888888,         // 纬度
  LNG: 88.888888888888888,         // 经度
  JITTER: 3,                       // 坐标抖动半径（米）
  DRY_RUN: false,                  // 演练模式
  FORCE: false,                    // 强制提交
  RETRY: 3,                        // 失败重试次数
  RETRY_WAIT: 30,                  // 重试间隔（秒）
  EARLY_WAIT: 120,                 // 早到等待（秒）
  QYWX_KEY: '',                    // 企业微信通知
  NOTIFY: true,                    // 推送开关
  NOTIFY_SKIP: false,              // 跳过也推送
  NOTIFY_ALREADY: false,           // 已签到也推送
};
```

**你实际要填的就两处**：

| 位置 | 说明 |
| --- | --- |
| `SIGN_URL` | **必填**。整条签到链接，站点地址与 taskId 都从它自动解析；留空启动即报错退出 |
| `QYWX_KEY` | 想收推送才填；留空 = 不推送 |

> 不再有 `TASK_ID` / `BASE`：都从 `SIGN_URL` 解析，换学期只改链接这一处。
> `CLIENT_SECRET` 也不用管：是官方前端 JS 里硬编码的公开值，不是你的密码，代码里已写死。
> 改完保存即生效，不需要再加环境变量；临时想覆盖可用环境变量（见第 4 步）。

各参数含义见[第三节参数总表](#三参数总表)。

### 3. 只给账号配环境变量

学号、密码是私密信息，**不要写进脚本文件**，只走环境变量。全部用 `WQQD_` 开头：

| 变量名 | 值 | 必填 |
| --- | --- | --- |
| `WQQD_ACCOUNT1` | `888888888` | ✅ |
| `WQQD_PASSWORD1` | 密码**明文**（脚本内部自动 md5） | ✅ |
| `WQQD_ACCOUNT2` / `WQQD_PASSWORD2` | 第 2 个账号 | 可选 |
| `WQQD_LAT1` / `WQQD_LNG1` | 第 1 个账号单独用的坐标 | 可选 |
| `WQQD_LAT2` / `WQQD_LNG2` | 第 2 个账号单独用的坐标 | 可选 |

> **多账号**：顺着编号往下写，最多 20 个，编号可不连续（只填 1 和 3 也行）。某编号只填了账号或只填了密码，日志会提示「配置不完整，已跳过」，不会静默漏签。
> **单独坐标**：默认用配置区 `LAT`/`LNG`；某账号宿舍不同就加 `WQQD_LAT2`/`WQQD_LNG2`，只填一个会被忽略、退回默认。
> 旧变量仍有效：`WISE_ACCOUNT` / `WISE_PASSWORD`、`WISE_ACCOUNTS`（`学号1:密码1&学号2:密码2`，条目后可跟 `@纬度,经度`）。所有来源合并去重，编号式优先，同学号只签一次。

### 4. 可选：临时覆盖配置区的环境变量

配置区里的参数，临时想换值就加同名环境变量，不用改脚本。优先级：**环境变量 > 配置区**。

| 变量名 | 覆盖 |
| --- | --- |
| `WQQD_SIGN_URL` | `SIGN_URL` |
| `WQQD_LAT` / `WQQD_LNG` | `LAT` / `LNG` |
| `WQQD_JITTER` | `JITTER` |
| `WQQD_DRY_RUN` | `DRY_RUN`（`1` = 只演练） |
| `WQQD_FORCE` | `FORCE`（`1` = 强制提交） |
| `WQQD_RETRY` / `WQQD_RETRY_WAIT` | `RETRY` / `RETRY_WAIT` |
| `WQQD_EARLY_WAIT` | `EARLY_WAIT` |
| `WQQD_QYWX_KEY` | `QYWX_KEY`（key 或完整地址均可） |
| `WQQD_NOTIFY` / `WQQD_NOTIFY_SKIP` / `WQQD_NOTIFY_ALREADY` | 对应推送开关 |
| `WQQD_NOTIFY_TEST` | `1` = 只打印推送内容不发请求 |
| `WQQD_NOW` | 注入 epoch 秒（测试用） |
| `WQQD_CLIENT_SECRET` | 学校改版换了 OAuth 常量时才用 |

### 5. 设定定时（cron）

「定时任务」→ 新建，命令填 `task wise_dorm_sign.js`，定时规则填 **5 段式** cron（`分 时 日 月 周`，**不写秒**）。

**推荐建两个定时任务**：

| 定时规则 | 作用 |
| --- | --- |
| `1 21 * * *` | 主任务，**21:01** 触发（刻意晚 1 分钟，避开整点抖动） |
| `2 22 * * *` | 兜底，21:01 失败时 22:02 补签 |

> **为什么 `1 21` 而不是 `0 21`**：整点触发有几秒抖动，可能落在 20:59:5x，服务端只认 21:00:00 之后会拒。写 21:01 彻底避开。
> 真早到也没关系：比 21:00 早不超过 `EARLY_WAIT`（默认 120 秒）脚本会原地等到 21:00 再提交。
> 21:01 成功后 22:02 会查到「已签到」跳过且默认不推，一天最多一条通知；只有 21:01 失败才会收到 ❌ 后再收到 ✅。

**常用变体**：

| cron | 含义 |
| --- | --- |
| `0,10,20,30,40,50 21-22 * * *` | 21–22 点每 10 分钟试一次（最保险，已签自动跳过） |
| `1 21 * * 1-5` | 只在周一到周五 |
| `1 21 * * 0,6` | 只在周六、周日 |

> ⚠️ 分钟位不同不能写在一起（`1 21,2 22 * * *` 是错的），要两个时间点就建两条任务。
> ⚠️ **时区**：cron 按面板时区解释。国内面板一般 `Asia/Shanghai`，直接写 `21`；若是 UTC 要写 `13`。

**不用青龙、直接 Linux crontab**（`crontab -e`，node 用绝对路径）：

```sh
1 21 * * *  WQQD_ACCOUNT1=888888888 WQQD_PASSWORD1='xxxxxxxx' WQQD_QYWX_KEY=xxxxxxxx /usr/bin/node /root/wise_dorm_sign.js >> /var/log/wise_sign.log 2>&1
```

多账号就继续往后面加 `WQQD_ACCOUNT2=… WQQD_PASSWORD2=…`。

**OpenWrt 路由器**（编辑 `/etc/crontabs/root`，`.sh` 版只支持单账号）：签到链接填在 `.sh` 自己的 `SIGN_URL=` 那一行，没填会报错退出。

```sh
1 21 * * *  WQQD_ACCOUNT1=888888888 WQQD_PASSWORD1='xxxxxxxx' /bin/sh /root/wise_dorm_sign.sh >> /tmp/wise_sign.log 2>&1
2 22 * * *  WQQD_ACCOUNT1=888888888 WQQD_PASSWORD1='xxxxxxxx' /bin/sh /root/wise_dorm_sign.sh >> /tmp/wise_sign.log 2>&1
```

```sh
/etc/init.d/cron enable && /etc/init.d/cron restart
uci set system.ntp.timezone='CST-8'; uci commit system; /etc/init.d/system restart
```

---

## 三、参数总表

**优先级：环境变量 > 脚本配置区。** 配置区的值不设同名环境变量就生效，设了则被覆盖。账号只能用环境变量。

### 账号（必填，`WQQD_` 前缀）

| 变量 | 说明 |
| --- | --- |
| `WQQD_ACCOUNT1` / `WQQD_PASSWORD1` | 第 1 个账号学号 / 密码**明文**（脚本内部 md5，不要自己先 md5） |
| `WQQD_ACCOUNT2` / `WQQD_PASSWORD2` | 第 2 个账号（可选，最多到 20，编号可不连续） |
| `WQQD_LAT1` / `WQQD_LNG1`、`WQQD_LAT2` / `WQQD_LNG2` | 各账号单独坐标（可选，两个都填才生效） |

> 兼容旧变量 `WISE_ACCOUNT` / `WISE_PASSWORD` / `WISE_ACCOUNTS`，合并去重，编号式优先。

### 其余参数（配置区优先，环境变量可覆盖）

| 配置区里的行 | 默认值 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `SIGN_URL` | `''` | `WQQD_SIGN_URL` | **必填**。整条签到链接，站点地址与 taskId 自动解析；留空启动即报错 |
| `LAT` / `LNG` | `88.888…` | `WQQD_LAT` / `WQQD_LNG` | 默认提交坐标 |
| `JITTER` | `3` | `WQQD_JITTER` | 坐标抖动半径（米），`0` 关闭 |
| `DRY_RUN` | `false` | `WQQD_DRY_RUN` | `1` = 只演练，不真正提交 |
| `FORCE` | `false` | `WQQD_FORCE` | `1` = 忽略「已签到」强制提交（仅测试） |
| `RETRY` | `3` | `WQQD_RETRY` | 失败重试次数（任何错误都重试，连续这么多次失败才判失败） |
| `RETRY_WAIT` | `30` | `WQQD_RETRY_WAIT` | 每次重试间隔（秒） |
| `EARLY_WAIT` | `120` | `WQQD_EARLY_WAIT` | 早到允许原地等待的最大秒数（`0` = 早到一律跳过） |
| `QYWX_KEY` | `''` | `WQQD_QYWX_KEY` | 群机器人 webhook key 或完整地址，留空不推 |
| `NOTIFY` | `true` | `WQQD_NOTIFY` | `0` = 关闭推送 |
| `NOTIFY_SKIP` | `false` | `WQQD_NOTIFY_SKIP` | `1` = 跳过类也推 |
| `NOTIFY_ALREADY` | `false` | `WQQD_NOTIFY_ALREADY` | `1` = 「已签到」也推。默认关（否则兜底那次会多推一条）。**成功/失败始终推，不受此开关影响** |

> 站点地址（`BASE`）和任务 id（`TASK_ID`）已取消独立配置，都从 `SIGN_URL` 解析；旧变量 `WQQD_TASK_ID` / `WQQD_BASE` 不再读取。

---

## 四、推送效果

企业微信 markdown 消息。**成功、失败一定会推**；「今天已签到」和跳过类默认静音。

**✅ 签到成功**
```
### ✅ 晚寝签到成功
> 日期：2026-11-03 21:01:12（星期二）
> 宿舍：xx-xx-xxx
> 坐标：88.88888, 88.888888（距宿舍 21.4 米）
> 签到时间：21:01:12
> 状态：正常
> 距离宿舍：23.8 米
```

**❌ 失败**（重试完仍失败，一定会推）
```
### ❌ 晚寝签到失败
> 已重试 3 次仍失败
> 原因：<具体错误>
> 时间：2026-11-03 21:01:30
```

**多账号**：所有账号汇总成**一条**推送。部分失败时标题写 `❌ 晚寝签到失败（1/2 个账号）`，正文按账号分行列出每个结果。

**ℹ️ 今天已签到**（默认不推，设 `WQQD_NOTIFY_ALREADY=1` 才推）

**⏭ 跳过**（未到时间 / 非签到日 / 任务已结束，默认不推，除非 `WQQD_NOTIFY_SKIP=1`）

---

## 五、脚本做了什么

1. 用学号 + `md5(密码)` 调 OAuth 拿 `access_token`。
2. 拉任务详情：签到时段、宿舍 `roomId`、允许半径（400 米）、签到星期、任务起止日期。
3. 依次判断：任务日期范围 → 今天是否签到日 → 是否免签日 → 是否在签到时段。
4. 查当天是否已签到（`signStatus` ∈ {0,1,2,4,5,6} 视为已签，直接跳过）。
5. 生成与前端**逐字段一致**的请求体（含 `stuTaskId`、`signCode` 两个 md5），POST 提交。
6. 提交成功后回查记录确认；失败自动重试（默认 3 次，间隔 30 秒）。
7. 按结果推送企业微信，并设置退出码。

> 多账号时第 1–6 步对每个账号各跑一遍（独立重试，互不影响），第 7 步汇总成一条推送。

**退出码**

| 退出码 | 含义 |
| --- | --- |
| `0` | 签到成功 / 今天已签 / 正常跳过 |
| `1` | 登录失败、接口异常、签到失败、或缺少签到链接/账号配置 |

---

## 六、常见问题

- **返回「签名错误」**：通常缺 `User-Agent`。脚本已固定带上，无需处理。
- **登录 401**：检查 `WQQD_PASSWORD1` 是否**明文**（脚本自动 md5）；多账号检查编号是否对应；旧写法 `WISE_ACCOUNTS` 里密码含 `&` 或 `;` 请改用编号式变量。
- **返回「未到签到时间！」**：服务端按自己时间校验，提前手动跑就会这样，等 21:00 后正常。
- **企业微信 `errcode 93000`**：webhook 地址/key 不对，重新复制机器人地址。
- **企业微信 `errcode 45009`**：发消息太频繁，等一会或减少推送。
- **偶发 502 或其它接口错误**：脚本会等 `RETRY_WAIT`（默认 30 秒）后自动重试，各步骤都适用，连续 3 次都失败才判失败并推 ❌，还有 22:02 兜底。

---

## 七、测试建议

先演练一次（不提交、不推送）：

```sh
WQQD_ACCOUNT1=888888888 WQQD_PASSWORD1='xxxxxxxx' WQQD_DRY_RUN=1 WQQD_NOTIFY=0 node wise_dorm_sign.js
```

多账号演练：

```sh
WQQD_ACCOUNT1=888888888 WQQD_PASSWORD1='xxxxxxxx' WQQD_ACCOUNT2=888888889 WQQD_PASSWORD2='xxxxxxxx' WQQD_DRY_RUN=1 WQQD_NOTIFY=0 node wise_dorm_sign.js
```

核对推送文案（不真发）：

```sh
WQQD_ACCOUNT1=... WQQD_PASSWORD1=... WQQD_NOTIFY=1 WQQD_NOTIFY_SKIP=1 WQQD_NOTIFY_TEST=1 node wise_dorm_sign.js
```

真发一条测试消息：把 `WQQD_NOTIFY_TEST` 去掉，`WQQD_NOTIFY_SKIP=1` 保留即可。
