# 东方财富官方行情配置

分时罗盘的默认行情桥使用东方财富官方公开接口，全部为只读请求：

- 东方财富快照 `stock/get`：每秒轮询，负责最新价、昨收、指数快照、行业名称和累计成交量。
- 东方财富分时 `stock/trends2/get`：默认每 5 秒刷新，负责个股/ETF、匹配市场指数及股票行业板块的当日 1 分钟序列。
- 东方财富日 K `stock/kline/get`：默认缓存 6 小时，负责多日趋势和结构箱体。

全部通道都是无需 API Key 的公开只读接口。它们不是逐笔或交易所直连行情，也不代表已获得交易所授权 Level-1 许可。页面显示的网络耗时不能等同于行情相对交易所的真实延迟。

## 场内 ETF 的免费数据边界

ETF 使用自身公开快照、分钟线、日 K 和对应市场指数。公开接口没有提供可靠跟踪指数映射时，页面会把该辅助项标记为不可用，不会伪造跟踪指数，也不会因此冻结基于 ETF 自身和市场指数的 B/S 研究模型。

## 校验和冻结规则

以下任一条件成立时，页面仍显示最新价，但冻结 B/S 判断：

- 东方财富官方行情请求失败；
- 个股/ETF 分钟线、匹配市场指数分钟线或至少 20 根日 K 任一缺失；
- 东方财富最新一分钟 K 线超过 90 秒；
- 东方财富最新价时间超过 15 秒；
- 东方财富快照与最近一分钟收盘价偏差超过 1%。

行业板块或 ETF 跟踪指数分钟线缺失时只显示降级提示，不冻结模型，也不参与成熟度评分。

可通过 `.env.local` 中的 `EASTMONEY_CONTEXT_REFRESH_MS`、`EASTMONEY_MINUTE_MAX_AGE_MS`、`EASTMONEY_PRICE_TOLERANCE_PCT` 和 `T0_LATEST_MAX_AGE_MS` 调整默认阈值。调整前应先观察真实交易时段数据，不要为了消除警告而放宽校验。

## 健康检查

访问 `http://localhost:8765/health`，确认：

- `provider` 为 `eastmoney-official-market-data`；
- `apiKeyRequired` 为 `false`；
- `latestPriceProvider` 与 `minuteProvider` 均存在。

再访问 `http://localhost:8765/quote?symbol=600519&market=SH`，确认 `meta.validation.passed` 为 `true`。示例代码只用于连通性检查，不会自动成为真实持仓。
