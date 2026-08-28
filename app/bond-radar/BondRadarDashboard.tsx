"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import styles from "./BondRadarDashboard.module.css";

type Quote = {
  code: string;
  name: string;
  price: number;
  previousClose: number;
  open: number;
  high: number;
  low: number;
  changePct: number;
  amplitude: number;
  intradayAmplitude: number;
  amount: number;
  turnoverRate: number;
  volumeRatio: number;
};

type TimelinePoint = {
  time: string;
  bondReturn: number;
  stockReturn: number;
};

type RadarItem = {
  rank: number;
  professionalScore: number;
  volatilityScore: number;
  eligibility?: {
    passed: boolean;
    stockVolatilityPass: boolean;
    upwardTrendPass: boolean;
    bondElasticityPass: boolean;
    failedReasons: string[];
    stockRangePosition: number;
    bondRangePosition: number;
    captureRatio: number;
  };
  factors: {
    volatility: number;
    activity: number;
    trend: number;
    linkage: number;
    premiumQuality: number;
    captureRatio: number;
    returnPersistence: number;
    meanReversion: number;
    oscillation: number;
    stockRangePosition: number;
    bondRangePosition: number;
    style: "向上联动" | "观察候选";
    preliminaryScore: number;
  };
  bond: Quote & {
    conversionPrice: number;
    conversionValue: number;
    conversionPremiumRate: number;
    pureBondValue: number;
  };
  stock: Quote;
  sync: {
    syncMode: "minute-path" | "snapshot-proxy";
    tradeDate: string | null;
    baselineTime?: string | null;
    sampleCount: number;
    pathCorrelation: number | null;
    directionAgreement: number | null;
    syncRate: number;
    latestBondReturn?: number | null;
    latestStockReturn?: number | null;
    timeline: TimelinePoint[];
    label: string;
    divergencePct: number;
    relativeStrength: string;
    warning: string | null;
  };
};

export type BondRadarSnapshot = {
  version: number;
  generatedAt: string;
  generatedAtChina: string;
  tradeDate: string;
  latestMinute: string | null;
  marketPhase: string;
  source: {
    provider: string;
    access: string;
    baseline: string;
    notice: string;
  };
  methodology: {
    ranking: string;
    sync: string;
    liquidity: string;
    shortlist: string;
  };
  universe: {
    providerTotal: number;
    mapped: number;
    complete: number;
    liquid: number;
    eligible?: number;
    usedLiquidityFallback: boolean;
  };
  items: RadarItem[];
};

type SortMode = "professional" | "sync" | "divergence";

function signed(value: number, digits = 2) {
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function formatAmount(value: number) {
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(2)}亿`;
  return `${(value / 10_000).toFixed(0)}万`;
}

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

function changeClass(value: number) {
  if (value > 0) return styles.up;
  if (value < 0) return styles.down;
  return styles.flat;
}

function syncClass(value: number) {
  if (value >= 75) return styles.syncHigh;
  if (value >= 55) return styles.syncMedium;
  return styles.syncLow;
}

function buildPath(
  points: TimelinePoint[],
  key: "bondReturn" | "stockReturn",
  width: number,
  height: number,
  minimum: number,
  maximum: number,
) {
  if (!points.length) return "";
  const x = (index: number) =>
    48 + (index / Math.max(points.length - 1, 1)) * (width - 70);
  const y = (value: number) =>
    18 + ((maximum - value) / Math.max(maximum - minimum, 0.01)) * (height - 50);
  return points
    .map(
      (point, index) =>
        `${index === 0 ? "M" : "L"}${x(index).toFixed(1)},${y(point[key]).toFixed(1)}`,
    )
    .join(" ");
}

function PairChart({ item }: { item: RadarItem }) {
  const width = 760;
  const height = 282;
  const points = item.sync.timeline;
  const values = points.flatMap((point) => [point.bondReturn, point.stockReturn]);
  const rawMinimum = Math.min(0, ...values);
  const rawMaximum = Math.max(0, ...values);
  const padding = Math.max((rawMaximum - rawMinimum) * 0.12, 0.4);
  const minimum = rawMinimum - padding;
  const maximum = rawMaximum + padding;
  const ticks = Array.from(
    { length: 5 },
    (_, index) => maximum - ((maximum - minimum) * index) / 4,
  );
  const y = (value: number) =>
    18 + ((maximum - value) / Math.max(maximum - minimum, 0.01)) * (height - 50);
  const xLabels = points.length
    ? [points[0], points[Math.floor(points.length / 2)], points.at(-1)!]
    : [];
  const xPositions = [48, width / 2, width - 22];

  if (!points.length) {
    return (
      <div className={styles.emptyChart}>
        <strong>分钟路径暂不可用</strong>
        <span>当前同步率使用收盘快照代理口径，下一次更新会自动重试。</span>
      </div>
    );
  }

  return (
    <div className={styles.chartWrap}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${item.bond.name}与${item.stock.name}相对9:30基准的分钟收益路径`}
      >
        <title>{`${item.bond.name}与${item.stock.name}相对9:30基准的分钟收益路径`}</title>
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              className={styles.gridLine}
              x1="48"
              x2={width - 22}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text className={styles.axisText} x="39" y={y(tick) + 4} textAnchor="end">
              {signed(tick, 1)}
            </text>
          </g>
        ))}
        <line
          className={styles.zeroLine}
          x1="48"
          x2={width - 22}
          y1={y(0)}
          y2={y(0)}
        />
        <path
          className={styles.bondPath}
          d={buildPath(points, "bondReturn", width, height, minimum, maximum)}
        />
        <path
          className={styles.stockPath}
          d={buildPath(points, "stockReturn", width, height, minimum, maximum)}
        />
        {xLabels.map((point, index) => (
          <text
            className={styles.axisText}
            key={`${point.time}-${index}`}
            x={xPositions[index]}
            y={height - 5}
            textAnchor={index === 0 ? "start" : index === 2 ? "end" : "middle"}
          >
            {point.time}
          </text>
        ))}
      </svg>
    </div>
  );
}

function Reading({ item }: { item: RadarItem }) {
  const bondReturn = item.sync.latestBondReturn ?? item.bond.changePct;
  const stockReturn = item.sync.latestStockReturn ?? item.stock.changePct;
  const sameDirection =
    Math.sign(bondReturn) === Math.sign(stockReturn);
  const text = sameDirection
    ? `两者当前同向，${item.sync.relativeStrength}，收益差为 ${signed(item.sync.divergencePct)}。`
    : `转债与正股当前反向，收益差达到 ${signed(item.sync.divergencePct)}，属于优先复核的背离组合。`;
  return (
    <div className={styles.reading}>
      <span>盘面读数</span>
      <p>{text}</p>
      <small>
        仅表示分时联动强弱，不构成方向判断或买卖建议；高同步也可能同步下跌。
      </small>
    </div>
  );
}

export default function BondRadarDashboard({
  initialSnapshot,
}: {
  initialSnapshot: BondRadarSnapshot;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [selectedCode, setSelectedCode] = useState(
    initialSnapshot.items[0]?.bond.code ?? "",
  );
  const [sortMode, setSortMode] = useState<SortMode>("professional");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  const selected =
    snapshot.items.find((item) => item.bond.code === selectedCode) ??
    snapshot.items[0];
  const sortedItems = useMemo(() => {
    const items = [...snapshot.items];
    if (sortMode === "sync") {
      return items.sort((left, right) => right.sync.syncRate - left.sync.syncRate);
    }
    if (sortMode === "divergence") {
      return items.sort(
        (left, right) =>
          Math.abs(right.sync.divergencePct) - Math.abs(left.sync.divergencePct),
      );
    }
    return items.sort(
      (left, right) => right.professionalScore - left.professionalScore,
    );
  }, [snapshot.items, sortMode]);
  const medianSync = median(snapshot.items.map((item) => item.sync.syncRate));
  const largestDivergence = snapshot.items.reduce(
    (largest, item) =>
      Math.abs(item.sync.divergencePct) > Math.abs(largest.sync.divergencePct)
        ? item
        : largest,
    snapshot.items[0],
  );

  async function refreshSnapshot() {
    setRefreshing(true);
    setRefreshError("");
    try {
      const response = await fetch(`/data/bond-radar.json?t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const nextSnapshot = (await response.json()) as BondRadarSnapshot;
      setSnapshot(nextSnapshot);
      if (!nextSnapshot.items.some((item) => item.bond.code === selectedCode)) {
        setSelectedCode(nextSnapshot.items[0]?.bond.code ?? "");
      }
    } catch {
      setRefreshError("快照读取失败，仍保留当前数据");
    } finally {
      setRefreshing(false);
    }
  }

  if (!selected || !largestDivergence) {
    return (
      <main className={styles.shell}>
        <div className={styles.emptyState}>暂无符合口径的转债/正股组合。</div>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <header className={styles.topbar}>
        <div className={styles.brand}>
          <div className={styles.brandMark}>R</div>
          <div>
            <strong>转债同步雷达</strong>
            <span>CONVERTIBLE BOND LINKAGE</span>
          </div>
        </div>
        <div className={styles.topActions}>
          <Link className={styles.backLink} href="/">
            返回分时罗盘
          </Link>
          <button
            className={styles.refreshButton}
            disabled={refreshing}
            onClick={refreshSnapshot}
            type="button"
          >
            {refreshing ? "读取中…" : "读取最新快照"}
          </button>
        </div>
      </header>

      <div className={styles.page}>
        <section className={styles.hero}>
          <div>
            <div className={styles.eyebrow}>
              <span className={styles.liveDot} />
              {snapshot.marketPhase} · {snapshot.tradeDate} {snapshot.latestMinute ?? "--"}
            </div>
            <h1>捕捉波动，也看清谁在跟随</h1>
            <p>
              以当日 9:30 第一根有效1分钟K线收盘价为盘中路径基准，先检查正股有效波动与股债日内向上结构，再评估转债弹性、量能和分钟同步率，纯模型保留最多 10 组。
            </p>
          </div>
          <div className={styles.snapshotMeta}>
            <span>快照生成</span>
            <strong>{snapshot.generatedAtChina}</strong>
            <small>{snapshot.source.provider} · {snapshot.source.access}</small>
          </div>
        </section>

        {refreshError ? <div className={styles.errorBar}>{refreshError}</div> : null}

        <section className={styles.stats} aria-label="筛选概览">
          <article>
            <span>通过结构门槛</span>
            <strong>{snapshot.universe.eligible ?? snapshot.items.length}</strong>
            <small>流动性合格 {snapshot.universe.liquid} 组</small>
          </article>
          <article>
            <span>最高专业评分</span>
            <strong>{snapshot.items[0].professionalScore.toFixed(1)}</strong>
            <small>{snapshot.items[0].bond.name} / {snapshot.items[0].stock.name}</small>
          </article>
          <article>
            <span>Top 10 同步率中位数</span>
            <strong>{medianSync}%</strong>
            <small>分钟路径 + 同向分钟</small>
          </article>
          <article>
            <span>最大收益偏离</span>
            <strong>{Math.abs(largestDivergence.sync.divergencePct).toFixed(2)}%</strong>
            <small>{largestDivergence.bond.name} / {largestDivergence.stock.name}</small>
          </article>
        </section>

        <section className={styles.focusGrid}>
          <article className={styles.chartPanel}>
            <div className={styles.panelHeader}>
              <div>
                <span className={styles.sectionLabel}>选中组合 · 相对9:30路径</span>
                <h2>{selected.bond.name} <em>×</em> {selected.stock.name}</h2>
              </div>
              <div className={styles.legend}>
                <span><i className={styles.bondSwatch} />转债</span>
                <span><i className={styles.stockSwatch} />正股</span>
              </div>
            </div>
            <PairChart item={selected} />
          </article>

          <aside className={styles.signalPanel}>
            <div className={styles.syncHeadline}>
              <div>
                <span>分钟同步率</span>
                <strong>{selected.sync.syncRate}%</strong>
              </div>
              <span className={`${styles.syncBadge} ${syncClass(selected.sync.syncRate)}`}>
                {selected.sync.label}
              </span>
            </div>
            <div className={styles.syncTrack} aria-hidden="true">
              <span style={{ width: `${selected.sync.syncRate}%` }} />
            </div>
            <dl className={styles.signalFacts}>
              <div>
                <dt>路径相关性</dt>
                <dd>{selected.sync.pathCorrelation === null ? "代理口径" : signed(selected.sync.pathCorrelation * 100, 0)}</dd>
              </div>
              <div>
                <dt>同向分钟</dt>
                <dd>{selected.sync.directionAgreement === null ? "--" : signed(selected.sync.directionAgreement * 100, 0)}</dd>
              </div>
              <div>
                <dt>专业评分</dt>
                <dd>{selected.professionalScore.toFixed(1)}</dd>
              </div>
              <div>
                <dt>收益差</dt>
                <dd className={changeClass(selected.sync.divergencePct)}>{signed(selected.sync.divergencePct)}</dd>
              </div>
            </dl>
            <div className={styles.pairQuote}>
              <div>
                <span>{selected.bond.name}</span>
                <strong>{selected.bond.price.toFixed(3)}</strong>
                <em className={changeClass(selected.bond.changePct)}>{signed(selected.bond.changePct)}</em>
              </div>
              <div>
                <span>{selected.stock.name}</span>
                <strong>{selected.stock.price.toFixed(2)}</strong>
                <em className={changeClass(selected.stock.changePct)}>{signed(selected.stock.changePct)}</em>
              </div>
            </div>
            <Reading item={selected} />
            <div className={styles.criteriaNote}>
              <span>纯模型入选 · 日内向上结构已确认</span>
              <p>
                正股位于有效区间 {(selected.eligibility?.stockRangePosition ?? selected.factors.stockRangePosition ?? 0).toFixed(0)}% 位置，
                转债跟随捕获比 {(selected.eligibility?.captureRatio ?? selected.factors.captureRatio ?? 0).toFixed(2)}。
              </p>
            </div>
          </aside>
        </section>

        <section className={styles.rankingSection}>
          <div className={styles.rankingHeader}>
            <div>
              <span className={styles.sectionLabel}>全市场筛选结果</span>
              <h2>向上联动 Top 10</h2>
            </div>
            <div className={styles.sortGroup} aria-label="结果排序">
              <button
                aria-pressed={sortMode === "professional"}
                onClick={() => setSortMode("professional")}
                type="button"
              >
                专业评分
              </button>
              <button
                aria-pressed={sortMode === "sync"}
                onClick={() => setSortMode("sync")}
                type="button"
              >
                同步率
              </button>
              <button
                aria-pressed={sortMode === "divergence"}
                onClick={() => setSortMode("divergence")}
                type="button"
              >
                偏离度
              </button>
            </div>
          </div>

          <div className={styles.tableWrap}>
            <table>
              <thead>
                <tr>
                  <th>筛选位</th>
                  <th>转债 / 正股</th>
                  <th>专业评分</th>
                  <th>转债表现</th>
                  <th>正股表现</th>
                  <th>同步率</th>
                  <th>收益差</th>
                  <th>成交额</th>
                </tr>
              </thead>
              <tbody>
                {sortedItems.map((item) => (
                  <tr
                    className={item.bond.code === selected.bond.code ? styles.selectedRow : ""}
                    key={item.bond.code}
                  >
                    <td><span className={styles.rank}>#{item.rank.toString().padStart(2, "0")}</span></td>
                    <td>
                      <button
                        className={styles.pairButton}
                        onClick={() => setSelectedCode(item.bond.code)}
                        type="button"
                      >
                        <span>
                          <strong>{item.bond.name}</strong>
                          <small>{item.bond.code}</small>
                          <em className={styles.trendTag}>向上结构</em>
                        </span>
                        <i>×</i>
                        <span><strong>{item.stock.name}</strong><small>{item.stock.code}</small></span>
                      </button>
                    </td>
                    <td>
                      <strong className={styles.score}>{item.professionalScore.toFixed(1)}</strong>
                      <small className={styles.scoreContext}>
                        有效波动 {item.volatilityScore.toFixed(2)}%
                      </small>
                    </td>
                    <td>
                      <div className={styles.performance}>
                        <strong className={changeClass(item.bond.changePct)}>{signed(item.bond.changePct)}</strong>
                        <small>有效波动 {item.bond.amplitude.toFixed(2)}%</small>
                      </div>
                    </td>
                    <td>
                      <div className={styles.performance}>
                        <strong className={changeClass(item.stock.changePct)}>{signed(item.stock.changePct)}</strong>
                        <small>有效波动 {item.stock.amplitude.toFixed(2)}%</small>
                      </div>
                    </td>
                    <td>
                      <div className={styles.tableSync}>
                        <div><span style={{ width: `${item.sync.syncRate}%` }} /></div>
                        <strong>{item.sync.syncRate}%</strong>
                      </div>
                      <small className={styles.syncText}>{item.sync.label}</small>
                    </td>
                    <td>
                      <strong className={changeClass(item.sync.divergencePct)}>{signed(item.sync.divergencePct)}</strong>
                      <small className={styles.relativeText}>{item.sync.relativeStrength}</small>
                    </td>
                    <td>
                      <div className={styles.performance}>
                        <strong>{formatAmount(item.bond.amount)}</strong>
                        <small>股 {formatAmount(item.stock.amount)}</small>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className={styles.methodSection}>
          <div>
            <span className={styles.sectionLabel}>计算口径</span>
            <h2>每个数字都能被解释</h2>
          </div>
          <div className={styles.methodGrid}>
            <article><span>01</span><strong>统一基准</strong><p>{snapshot.source.baseline}，转债与正股分别归一化。</p></article>
            <article><span>02</span><strong>专业评分</strong><p>{snapshot.methodology.ranking}。</p></article>
            <article><span>03</span><strong>同步计算</strong><p>{snapshot.methodology.sync}。</p></article>
            <article><span>04</span><strong>纯模型短名单</strong><p>{snapshot.methodology.shortlist}。</p></article>
          </div>
        </section>

        <footer className={styles.footer}>
          <span>{snapshot.source.notice}</span>
          <span>研究辅助 · 只读 · 不连接证券账户 · 不具备下单能力</span>
        </footer>
      </div>
    </main>
  );
}
