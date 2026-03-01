# autoELEC Cloudflare Worker

基于请求样例，实现了一个可部署到 Cloudflare Workers 的电费查询服务，支持：

- 定时查询（Cron Trigger）
- 手动查询接口
- 按策略推送消息到：钉钉机器人、企业微信机器人、Napcat

## 1. 项目结构

- `src/index.js`：Worker 主逻辑
- `wrangler.toml`：Worker 配置与 Cron
- `.dev.vars.example`：环境变量模板

## 2. 快速开始

1) 安装依赖

```bash
npm install
```

2) 配置环境变量

- 复制 `.dev.vars.example` 为 `.dev.vars`
- 填写你的 `SYNJONES_AUTH_TOKEN`、`REQUEST_COOKIE`、房间参数等
- 配置通知通道（可只配一种）

3) 本地调试

```bash
npm run dev
```

4) 部署

```bash
npm run deploy
```

## 3. 查询接口

- 健康检查：`GET /health`
- 手动查询：`GET /query`
- 强制发送通知：`GET /query?notify=1`
- 同步等待完整结果：`GET /query?wait=1`

说明：当为批量查询且配置了目标间隔（`TARGET_QUERY_INTERVAL_SECONDS > 0`）时，`/query` 默认改为后台执行并立即返回 `202`，避免浏览器超时转圈。

补充：后台执行模式下会忽略房间间隔（立即依次查询），确保所有房间都能在一次后台任务中完成；若要严格按间隔执行，请使用 `GET /query?wait=1`。

### 批量查询多个房间

在 `.dev.vars` 中配置 `TARGETS_JSON` 后，`/query` 会一次查询多个目标并汇总结果。

示例：

```env
TARGETS_JSON=[{"id":"room609","name":"宿舍609","campus":"天津工业大学&天津工业大学","building":"20161008184448464922&西苑7号楼","floor":"6&6层","room":"20161009111811624619&1栋609"},{"id":"room610","name":"宿舍610","campus":"天津工业大学&天津工业大学","building":"20161008184448464922&西苑7号楼","floor":"6&6层","room":"ROOM_ID&1栋610"}]
```

说明：

- `TARGETS_JSON` 存在时，优先于单目标参数 `CAMPUS/BUILDING/FLOOR/ROOM`。
- 返回结果中会包含 `queries` 数组（每个目标一项）和 `summary` 汇总信息。
- 批量查询改为串行执行，默认每个目标之间间隔 60 秒。
- 每个房间单独发送一条通知消息，不再合并成一条。

可通过环境变量调整间隔：

```env
TARGET_QUERY_INTERVAL_SECONDS=60
```

如配置了 `API_KEY`，调用 `/query` 需要请求头：

```http
x-api-key: 你的API_KEY
```

## 4. 定时查询

在 `wrangler.toml` 中修改 cron 表达式：

```toml
[triggers]
crons = ["0 4 * * *"]
```

以上表示每天 UTC 04:00 触发，即北京时间（UTC+8）每天中午 12:00。

## 5. 通知策略

`NOTIFY_MODE` 支持：

- `always`：每次查询都通知
- `low_balance`：低于阈值才通知（需 `LOW_BALANCE_THRESHOLD`）
- `change`：余额变化才通知（建议绑定 KV）
- `never`：不通知

补充：

- `NOTIFY_ON_ERROR=true`（默认）时，单个房间查询失败也会单独发一条“查询失败”告警消息。

## 6. 三种消息通道配置

### 钉钉

配置：

- `DINGTALK_WEBHOOK`
- `DINGTALK_SECRET`（可选，开启签名时填写）

### 企业微信

配置：

- `WECOM_WEBHOOK`

### Napcat

配置：

- `NAPCAT_API_URL`
- `NAPCAT_TARGET_TYPE`：`group` 或 `private`
- `NAPCAT_GROUP_ID` / `NAPCAT_USER_ID`
- `NAPCAT_TOKEN`（可选）

## 7. change 模式建议（可选）

如果你使用 `NOTIFY_MODE=change`，建议绑定 KV 记录上次余额。

`wrangler.toml` 增加：

```toml
[[kv_namespaces]]
binding = "STATE_KV"
id = "你的KV_ID"
```

## 8. 注意事项

- `SYNJONES_AUTH_TOKEN` 和 `REQUEST_COOKIE` 可能会过期，需要定期更新。
- 若系统返回结构变化，可设置 `BALANCE_PATH` 精确指定余额字段路径。
