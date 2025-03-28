// ====================== CONFIG ======================
const config = {
  BYBIT_API_KEY: "YOUR_API_KEY",
  BYBIT_SECRET: "YOUR_API_SECRET",
  TELEGRAM_TOKEN: "YOUR_TELEGRAM_BOT_TOKEN",
  CHAT_ID: "YOUR_CHAT_ID",
  
  // Risk Management
  RISK_PER_TRADE: 1,          // $1 per trade
  MAX_DCA_LEVELS: 2,          // Max 2 DCA levels
  DCA_INCREASE_PERCENT: 50,   // 50% more size each DCA
  DCA_TRIGGER_PERCENT: -5,    // DCA at -5% from entry
  
  // Take Profit & SL
  TP1_PERCENT: 1.5,           // Close 50% at 1.5%
  TP2_PERCENT: 3,             // Close rest at 3%
  SL_PERCENT: 1,              // Initial SL
  TRAIL_ACTIVATE: 0.5,        // Trail after +0.5%
  
  // Technical Analysis
  RSI_OVERBOUGHT: 60,
  RSI_OVERSOLD: 40,
  VOLUME_SPIKE: 2,            // 2x average volume
  LIQUIDITY_ZONE_PERCENT: 0.5 // 0.5% dari harga untuk cek liquidity
};

// ====================== LIBRARIES ======================
const ccxt = require("ccxt");
const TelegramBot = require("node-telegram-bot-api");
const sqlite3 = require("sqlite3").verbose();

// ====================== GLOBALS ======================
const bybit = new ccxt.bybit({
  apiKey: config.BYBIT_API_KEY,
  secret: config.BYBIT_API_SECRET,
  options: { defaultType: "future" }
});

const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });
const db = new sqlite3.Database("trades.db");
let dynamicWatchlist = ["WIF", "PEPE", "NOT"];
let isTradingActive = false;
const activeTrailingStops = {};

// ====================== TECHNICAL INDICATORS ======================
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function calculateRSI(closes, period = 14) {
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateVWAP(candles) {
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;
  
  candles.forEach(c => {
    const typicalPrice = (c[2] + c[3] + c[4]) / 3;
    cumulativeTPV += typicalPrice * c[5];
    cumulativeVolume += c[5];
  });
  
  return cumulativeTPV / cumulativeVolume;
}

async function checkLiquidity(symbol, price, direction) {
  try {
    const orderbook = await bybit.fetchOrderBook(`${symbol}/USDT`);
    const targetPrice = direction === "LONG" 
      ? price * (1 + config.LIQUIDITY_ZONE_PERCENT / 100)
      : price * (1 - config.LIQUIDITY_ZONE_PERCENT / 100);
    
    const liquidity = direction === "LONG"
      ? orderbook.asks.find(a => a[0] >= targetPrice)?.[1] || 0
      : orderbook.bids.find(b => b[0] <= targetPrice)?.[1] || 0;
    
    return liquidity > 0;
  } catch (error) {
    console.error("Liquidity check failed:", error);
    return false;
  }
}

// ====================== ENHANCED SIGNAL GENERATION ======================
async function generateSignal(symbol) {
  try {
    // Multi-timeframe analysis
    const [candles5m, candles15m] = await Promise.all([
      bybit.fetchOHLCV(`${symbol}/USDT`, '5m', undefined, 50),
      bybit.fetchOHLCV(`${symbol}/USDT`, '15m', undefined, 20)
    ]);

    // Price data
    const closes5m = candles5m.map(c => c[4]);
    const volumes5m = candles5m.map(c => c[5]);
    const lastCandle = candles5m[candles5m.length - 1];
    const prevCandle = candles5m[candles5m.length - 2];

    // Indicators
    const ema9_5m = calculateEMA(closes5m, 9);
    const ema18_5m = calculateEMA(closes5m, 18);
    const ema9_15m = calculateEMA(candles15m.map(c => c[4]), 9);
    const ema18_15m = calculateEMA(candles15m.map(c => c[4]), 18);
    const rsi = calculateRSI(closes5m);
    const vwap = calculateVWAP(candles5m);
    const currentVolume = volumes5m[volumes5m.length - 1];
    const avgVolume = volumes5m.reduce((a, b) => a + b, 0) / volumes5m.length;

    // Price action
    const isBullishBreakout = lastCandle[4] > prevCandle[2];
    const isBearishBreakout = lastCandle[4] < prevCandle[3];

    // Liquidity check (for SL/TP zones)
    const hasBuyLiquidity = await checkLiquidity(symbol, lastCandle[4], "LONG");
    const hasSellLiquidity = await checkLiquidity(symbol, lastCandle[4], "SHORT");

    // Signal conditions
    const longSignal = (
      ema9_5m > ema18_5m &&
      ema9_15m > ema18_15m &&
      currentVolume > avgVolume * config.VOLUME_SPIKE &&
      rsi > config.RSI_OVERSOLD && rsi < config.RSI_OVERBOUGHT &&
      lastCandle[4] > vwap &&
      isBullishBreakout &&
      hasSellLiquidity
    );

    const shortSignal = (
      ema9_5m < ema18_5m &&
      ema9_15m < ema18_15m &&
      currentVolume > avgVolume * config.VOLUME_SPIKE &&
      rsi > config.RSI_OVERSOLD && rsi < config.RSI_OVERBOUGHT &&
      lastCandle[4] < vwap &&
      isBearishBreakout &&
      hasBuyLiquidity
    );

    if (longSignal) {
      return {
        signal: "LONG",
        price: lastCandle[4],
        reason: [
          "✅ EMA9 > EMA18 (5m & 15m)",
          `📊 Volume ${(currentVolume/avgVolume).toFixed(1)}x`,
          `📈 RSI ${rsi.toFixed(0)} (Neutral)`,
          "🔼 Above VWAP",
          "⚡ Bullish Breakout",
          "💧 Liquidity detected"
        ].join("\n")
      };
    }

    if (shortSignal) {
      return {
        signal: "SHORT",
        price: lastCandle[4],
        reason: [
          "✅ EMA9 < EMA18 (5m & 15m)",
          `📊 Volume ${(currentVolume/avgVolume).toFixed(1)}x`,
          `📈 RSI ${rsi.toFixed(0)} (Neutral)`,
          "🔽 Below VWAP",
          "⚡ Bearish Breakout",
          "💧 Liquidity detected"
        ].join("\n")
      };
    }

    return null;
  } catch (error) {
    console.error(`Signal generation failed for ${symbol}:`, error);
    return null;
  }
}

// ====================== CORE TRADING FUNCTIONS ======================
async function executeTrade(symbol, direction, price, reason) {
  try {
    const amount = (config.RISK_PER_TRADE / price).toFixed(0);
    const order = await bybit.createMarketOrder(
      `${symbol}/USDT`,
      direction.toLowerCase(),
      amount
    );

    db.run(
      `INSERT INTO trades (coin, direction, entry_price, amount, status) VALUES (?, ?, ?, ?, 'OPEN')`,
      [symbol, direction, price, amount]
    );

    bot.sendMessage(
      config.CHAT_ID,
      `🚀 ${direction} ${symbol}\n` +
      `📌 Entry: ${price}\n` +
      `📝 Reason:\n${reason}\n` +
      `💰 Size: $${config.RISK_PER_TRADE}`
    );

    // Initialize trailing stop
    activeTrailingStops[order.id] = {
      id: order.id,
      coin: symbol,
      direction,
      entry: price,
      trailActivated: false
    };

  } catch (error) {
    console.error("Trade execution failed:", error);
    bot.sendMessage(config.CHAT_ID, `❌ Failed to execute ${direction} ${symbol}: ${error.message}`);
  }
}

async function checkExits() {
  const openTrades = await new Promise(resolve => {
    db.all("SELECT * FROM trades WHERE status = 'OPEN'", (err, rows) => resolve(rows || []));
  });

  for (const trade of openTrades) {
    const ticker = await bybit.fetchTicker(`${trade.coin}/USDT`);
    const currentPrice = ticker.last;
    const pnlPercent = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;
    const direction = trade.direction === "LONG" ? 1 : -1;

    // Initialize trailing stop if not exists
    if (!activeTrailingStops[trade.id]) {
      activeTrailingStops[trade.id] = {
        id: trade.id,
        coin: trade.coin,
        direction: trade.direction,
        entry: trade.entry_price,
        trailActivated: false,
        currentStop: trade.entry_price * (1 - (direction * config.SL_PERCENT / 100))
      };
    }

    const trailData = activeTrailingStops[trade.id];

    // Update trailing stop
    if (direction * pnlPercent >= config.TRAIL_ACTIVATE) {
      const newStop = currentPrice * (1 - (direction * config.SL_PERCENT / 100));
      trailData.currentStop = direction === 1 
        ? Math.max(newStop, trade.entry_price)
        : Math.min(newStop, trade.entry_price);
      trailData.trailActivated = true;
    }

    // Check TP1 (50%)
    if (!trade.tp1_hit && direction * pnlPercent >= config.TP1_PERCENT) {
      await closePartialPosition(trade, currentPrice, "TP1 HIT", 0.5);
      db.run("UPDATE trades SET tp1_hit = 1 WHERE id = ?", [trade.id]);
      continue;
    }

    // Check TP2 (remaining 50%)
    if (trade.tp1_hit && direction * pnlPercent >= config.TP2_PERCENT) {
      await closePosition(trade, currentPrice, "TP2 HIT");
      delete activeTrailingStops[trade.id];
      continue;
    }

    // Check Trailing SL
    const shouldTrigger = (trade.direction === "LONG" && currentPrice <= trailData.currentStop) ||
                         (trade.direction === "SHORT" && currentPrice >= trailData.currentStop);

    if (shouldTrigger && trailData.trailActivated) {
      await closePosition(trade, currentPrice, "TRAILING SL HIT");
      delete activeTrailingStops[trade.id];
    }
  }
}

// ====================== TELEGRAM COMMANDS ======================
// ... [Semua command handler dari sebelumnya] ...

// ====================== MAIN EXECUTION ======================
async function main() {
  console.log("🤖 Enhanced Trading Bot Started");
  
  // Initialize database
  db.run(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY,
      coin TEXT,
      direction TEXT,
      entry_price REAL,
      exit_price REAL,
      amount REAL,
      pnl REAL,
      status TEXT,
      dca_level INTEGER DEFAULT 0,
      tp1_hit INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Start trading loop
  setInterval(async () => {
    if (!isTradingActive) return;
    
    try {
      // Check signals for all coins in watchlist
      for (const symbol of dynamicWatchlist) {
        const signal = await generateSignal(symbol);
        if (signal) await executeTrade(symbol, signal.signal, signal.price, signal.reason);
      }
      
      // Manage open positions
      await checkExits();
    } catch (error) {
      console.error("Main loop error:", error);
    }
  }, 30000); // Run every 30 seconds
}

main();
