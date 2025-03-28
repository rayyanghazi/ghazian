// ====================== CONFIGURATION ======================
const config = {
  // Exchange Credentials
  BYBIT_API_KEY: "YOUR_API_KEY",
  BYBIT_SECRET: "YOUR_API_SECRET",
  
  // Telegram Settings
  TELEGRAM_TOKEN: "YOUR_TELEGRAM_BOT_TOKEN",
  CHAT_ID: "YOUR_CHAT_ID",
  
  // Trading Parameters
  RISK_PER_TRADE: 1,          // $1 risk per trade
  MAX_DCA_LEVELS: 2,          // Maximum DCA attempts
  DCA_INCREASE_PERCENT: 50,   // Position size increase per DCA
  
  // Exit Strategies
  TP1_PERCENT: 1.5,           // Take Profit 1 (50% position)
  TP2_PERCENT: 3,             // Take Profit 2 (remaining 50%)
  SL_PERCENT: 1,              // Initial Stop Loss
  TRAIL_ACTIVATE_PERCENT: 0.5,// When to activate trailing SL
  
  // Technical Analysis
  RSI_OVERBOUGHT: 60,
  RSI_OVERSOLD: 40,
  VOLUME_SPIKE_RATIO: 2,      // Minimum volume spike
  LIQUIDITY_CHECK_DISTANCE: 0.5 // % from price to check liquidity
};

// ====================== INITIALIZATION ======================
const ccxt = require('ccxt');
const TelegramBot = require('node-telegram-bot-api');
const sqlite3 = require('sqlite3').verbose();

// Initialize exchange connection
const exchange = new ccxt.bybit({
  apiKey: config.BYBIT_API_KEY,
  secret: config.BYBIT_API_SECRET,
  options: { defaultType: 'future' }
});

// Initialize Telegram bot
const bot = new TelegramBot(config.TELEGRAM_TOKEN, { polling: true });

// Database setup
const db = new sqlite3.Database('trades.db');

// Runtime variables
let dynamicWatchlist = ["WIF", "PEPE", "NOT"]; // Default watchlist
let isTradingActive = false;
const activeTrailingStops = {};

// ====================== TECHNICAL INDICATORS ======================
// Exponential Moving Average
function calculateEMA(closePrices, period) {
  const multiplier = 2 / (period + 1);
  let ema = closePrices[0];
  
  for (let i = 1; i < closePrices.length; i++) {
    ema = (closePrices[i] - ema) * multiplier + ema;
  }
  
  return ema;
}

// Relative Strength Index
function calculateRSI(closePrices, period = 14) {
  let gains = 0;
  let losses = 0;
  
  for (let i = 1; i <= period; i++) {
    const difference = closePrices[i] - closePrices[i - 1];
    if (difference >= 0) gains += difference;
    else losses -= difference;
  }
  
  const averageGain = gains / period;
  const averageLoss = losses / period;
  const relativeStrength = averageLoss === 0 ? 100 : averageGain / averageLoss;
  
  return 100 - (100 / (1 + relativeStrength));
}

// Volume Weighted Average Price
function calculateVWAP(candles) {
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;
  
  candles.forEach(candle => {
    const typicalPrice = (candle[2] + candle[3] + candle[4]) / 3; // (H+L+C)/3
    cumulativeTPV += typicalPrice * candle[5];
    cumulativeVolume += candle[5];
  });
  
  return cumulativeVolume === 0 ? 0 : cumulativeTPV / cumulativeVolume;
}

// Liquidity Check
async function checkLiquidity(symbol, price, direction) {
  try {
    const orderbook = await exchange.fetchOrderBook(`${symbol}/USDT`);
    const targetPrice = direction === 'LONG'
      ? price * (1 + config.LIQUIDITY_CHECK_DISTANCE / 100)
      : price * (1 - config.LIQUIDITY_CHECK_DISTANCE / 100);
    
    const relevantSide = direction === 'LONG' ? orderbook.asks : orderbook.bids;
    const liquidity = relevantSide.find(level => 
      direction === 'LONG' ? level[0] >= targetPrice : level[0] <= targetPrice
    )?.[1] || 0;
    
    return liquidity > 0;
  } catch (error) {
    console.error(`Liquidity check failed for ${symbol}:`, error);
    return false;
  }
}

// ====================== SIGNAL GENERATION ======================
async function generateTradingSignal(symbol) {
  try {
    // Fetch market data
    const [candles5m, candles15m] = await Promise.all([
      exchange.fetchOHLCV(`${symbol}/USDT`, '5m', undefined, 50),
      exchange.fetchOHLCV(`${symbol}/USDT`, '15m', undefined, 20)
    ]);
    
    // Process candles
    const closes5m = candles5m.map(c => c[4]);
    const volumes5m = candles5m.map(c => c[5]);
    const currentPrice = closes5m[closes5m.length - 1];
    const currentVolume = volumes5m[volumes5m.length - 1];
    const avgVolume = volumes5m.reduce((sum, vol) => sum + vol, 0) / volumes5m.length;
    
    // Calculate indicators
    const ema9_5m = calculateEMA(closes5m, 9);
    const ema18_5m = calculateEMA(closes5m, 18);
    const ema9_15m = calculateEMA(candles15m.map(c => c[4]), 9);
    const ema18_15m = calculateEMA(candles15m.map(c => c[4]), 18);
    const rsi = calculateRSI(closes5m);
    const vwap = calculateVWAP(candles5m);
    
    // Price action analysis
    const lastCandle = candles5m[candles5m.length - 1];
    const prevCandle = candles5m[candles5m.length - 2];
    const isBullishBreakout = lastCandle[4] > prevCandle[2]; // Close > previous high
    const isBearishBreakout = lastCandle[4] < prevCandle[3]; // Close < previous low
    
    // Liquidity verification
    const [hasBuyLiquidity, hasSellLiquidity] = await Promise.all([
      checkLiquidity(symbol, currentPrice, 'LONG'),
      checkLiquidity(symbol, currentPrice, 'SHORT')
    ]);
    
    // LONG signal conditions
    const shouldEnterLong = (
      ema9_5m > ema18_5m &&               // 5m trend up
      ema9_15m > ema18_15m &&             // 15m trend confirmation
      currentVolume > avgVolume * config.VOLUME_SPIKE_RATIO && // Volume spike
      rsi > config.RSI_OVERSOLD &&        // Not oversold
      rsi < config.RSI_OVERBOUGHT &&      // Not overbought
      currentPrice > vwap &&              // Price above VWAP
      isBullishBreakout &&                // Price action confirmation
      hasSellLiquidity                    // Exit liquidity available
    );
    
    // SHORT signal conditions
    const shouldEnterShort = (
      ema9_5m < ema18_5m &&               // 5m trend down
      ema9_15m < ema18_15m &&             // 15m trend confirmation
      currentVolume > avgVolume * config.VOLUME_SPIKE_RATIO && // Volume spike
      rsi > config.RSI_OVERSOLD &&        // Not oversold
      rsi < config.RSI_OVERBOUGHT &&      // Not overbought
      currentPrice < vwap &&              // Price below VWAP
      isBearishBreakout &&                // Price action confirmation
      hasBuyLiquidity                     // Exit liquidity available
    );
    
    // Generate signal object if conditions met
    if (shouldEnterLong) {
      return {
        signal: 'LONG',
        price: currentPrice,
        reason: [
          '📈 Trend: EMA9 > EMA18 (5m & 15m)',
          `📊 Volume: ${(currentVolume/avgVolume).toFixed(1)}x average`,
          `📉 RSI: ${rsi.toFixed(0)} (Neutral Zone)`,
          '🔼 Price above VWAP',
          '⚡ Bullish breakout detected',
          '💧 Exit liquidity confirmed'
        ].join('\n')
      };
    }
    
    if (shouldEnterShort) {
      return {
        signal: 'SHORT',
        price: currentPrice,
        reason: [
          '📉 Trend: EMA9 < EMA18 (5m & 15m)',
          `📊 Volume: ${(currentVolume/avgVolume).toFixed(1)}x average`,
          `📉 RSI: ${rsi.toFixed(0)} (Neutral Zone)`,
          '🔽 Price below VWAP',
          '⚡ Bearish breakout detected',
          '💧 Exit liquidity confirmed'
        ].join('\n')
      };
    }
    
    return null;
  } catch (error) {
    console.error(`Signal generation failed for ${symbol}:`, error);
    return null;
  }
}

// ====================== TRADE EXECUTION ======================
async function executeTrade(symbol, direction, entryPrice, reason) {
  try {
    // Calculate position size
    const amount = (config.RISK_PER_TRADE / entryPrice).toFixed(0);
    
    // Place market order
    const order = await exchange.createMarketOrder(
      `${symbol}/USDT`,
      direction.toLowerCase(),
      amount
    );
    
    // Record trade in database
    db.run(
      `INSERT INTO trades (
        coin, direction, entry_price, amount, status
      ) VALUES (?, ?, ?, ?, 'OPEN')`,
      [symbol, direction, entryPrice, amount]
    );
    
    // Initialize trailing stop
    activeTrailingStops[order.id] = {
      entryPrice,
      highestPrice: entryPrice,
      lowestPrice: entryPrice,
      stopPrice: direction === 'LONG'
        ? entryPrice * (1 - config.SL_PERCENT / 100)
        : entryPrice * (1 + config.SL_PERCENT / 100)
    };
    
    // Send notification
    bot.sendMessage(
      config.CHAT_ID,
      `🚀 ${direction} SIGNAL\n` +
      `📌 ${symbol} @ ${entryPrice}\n` +
      `💰 Size: $${config.RISK_PER_TRADE}\n` +
      `📝 Reasons:\n${reason}`
    );
    
    return order;
  } catch (error) {
    console.error(`Trade execution failed for ${symbol}:`, error);
    bot.sendMessage(
      config.CHAT_ID,
      `❌ Failed to execute ${direction} ${symbol}\n` +
      `Error: ${error.message}`
    );
    return null;
  }
}

// ====================== POSITION MANAGEMENT ======================
async function manageOpenPositions() {
  try {
    const openTrades = await new Promise(resolve => {
      db.all(
        "SELECT * FROM trades WHERE status = 'OPEN'",
        (err, rows) => resolve(rows || [])
      );
    });
    
    for (const trade of openTrades) {
      const currentTicker = await exchange.fetchTicker(`${trade.coin}/USDT`);
      const currentPrice = currentTicker.last;
      const pnlPercent = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;
      
      // Get or initialize trailing stop data
      if (!activeTrailingStops[trade.id]) {
        activeTrailingStops[trade.id] = {
          entryPrice: trade.entry_price,
          highestPrice: trade.entry_price,
          lowestPrice: trade.entry_price,
          stopPrice: trade.direction === 'LONG'
            ? trade.entry_price * (1 - config.SL_PERCENT / 100)
            : trade.entry_price * (1 + config.SL_PERCENT / 100)
        };
      }
      
      const trailData = activeTrailingStops[trade.id];
      
      // Update trailing stop for LONG positions
      if (trade.direction === 'LONG') {
        trailData.highestPrice = Math.max(trailData.highestPrice, currentPrice);
        
        // Activate trailing after reaching profit threshold
        if (pnlPercent >= config.TRAIL_ACTIVATE_PERCENT) {
          trailData.stopPrice = Math.max(
            currentPrice * (1 - config.SL_PERCENT / 100),
            trailData.entryPrice  // Never go below entry
          );
        }
        
        // Check take profit levels
        if (!trade.tp1_hit && pnlPercent >= config.TP1_PERCENT) {
          await closePartialPosition(trade, currentPrice, 'TP1 HIT', 0.5);
          db.run("UPDATE trades SET tp1_hit = 1 WHERE id = ?", [trade.id]);
          continue;
        }
        
        if (trade.tp1_hit && pnlPercent >= config.TP2_PERCENT) {
          await closePosition(trade, currentPrice, 'TP2 HIT');
          delete activeTrailingStops[trade.id];
          continue;
        }
        
        // Check trailing stop
        if (currentPrice <= trailData.stopPrice && pnlPercent >= config.TRAIL_ACTIVATE_PERCENT) {
          await closePosition(trade, currentPrice, 'TRAILING SL HIT');
          delete activeTrailingStops[trade.id];
          continue;
        }
      }
      
      // Update trailing stop for SHORT positions
      if (trade.direction === 'SHORT') {
        trailData.lowestPrice = Math.min(trailData.lowestPrice, currentPrice);
        
        // Activate trailing after reaching profit threshold
        if (pnlPercent <= -config.TRAIL_ACTIVATE_PERCENT) {
          trailData.stopPrice = Math.min(
            currentPrice * (1 + config.SL_PERCENT / 100),
            trailData.entryPrice  // Never go above entry
          );
        }
        
        // Check take profit levels
        if (!trade.tp1_hit && pnlPercent <= -config.TP1_PERCENT) {
          await closePartialPosition(trade, currentPrice, 'TP1 HIT', 0.5);
          db.run("UPDATE trades SET tp1_hit = 1 WHERE id = ?", [trade.id]);
          continue;
        }
        
        if (trade.tp1_hit && pnlPercent <= -config.TP2_PERCENT) {
          await closePosition(trade, currentPrice, 'TP2 HIT');
          delete activeTrailingStops[trade.id];
          continue;
        }
        
        // Check trailing stop
        if (currentPrice >= trailData.stopPrice && pnlPercent <= -config.TRAIL_ACTIVATE_PERCENT) {
          await closePosition(trade, currentPrice, 'TRAILING SL HIT');
          delete activeTrailingStops[trade.id];
          continue;
        }
      }
    }
  } catch (error) {
    console.error('Position management error:', error);
  }
}

// ====================== ORDER CLOSURE FUNCTIONS ======================
async function closePosition(trade, exitPrice, reason) {
  try {
    const amount = trade.tp1_hit 
      ? Math.floor(trade.amount * 0.5)  // Close remaining 50%
      : trade.amount;                  // Close full position
    
    await exchange.createMarketOrder(
      `${trade.coin}/USDT`,
      trade.direction === 'LONG' ? 'sell' : 'buy',
      amount
    );
    
    // Calculate PnL
    const pnl = trade.direction === 'LONG'
      ? (exitPrice - trade.entry_price) * amount
      : (trade.entry_price - exitPrice) * amount;
    
    // Update database
    db.run(
      `UPDATE trades SET 
        exit_price = ?, 
        pnl = ?, 
        status = ? 
       WHERE id = ?`,
      [exitPrice, pnl, reason, trade.id]
    );
    
    // Send notification
    bot.sendMessage(
      config.CHAT_ID,
      `🏁 POSITION CLOSED\n` +
      `📌 ${trade.coin} ${trade.direction}\n` +
      `💰 PnL: $${pnl.toFixed(2)} (${((pnl/(trade.entry_price * trade.amount)) * 100).toFixed(1)}%)\n` +
      `📝 Reason: ${reason}`
    );
  } catch (error) {
    console.error(`Failed to close position for ${trade.coin}:`, error);
    bot.sendMessage(
      config.CHAT_ID,
      `❌ Failed to close ${trade.coin} position\n` +
      `Error: ${error.message}`
    );
  }
}

async function closePartialPosition(trade, exitPrice, reason, closeRatio) {
  try {
    const closeAmount = Math.floor(trade.amount * closeRatio);
    
    await exchange.createMarketOrder(
      `${trade.coin}/USDT`,
      trade.direction === 'LONG' ? 'sell' : 'buy',
      closeAmount
    );
    
    // Calculate partial PnL
    const pnl = trade.direction === 'LONG'
      ? (exitPrice - trade.entry_price) * closeAmount
      : (trade.entry_price - exitPrice) * closeAmount;
    
    // Send notification
    bot.sendMessage(
      config.CHAT_ID,
      `🎯 PARTIAL CLOSE\n` +
      `📌 ${trade.coin} ${trade.direction}\n` +
      `🔹 Closed: ${(closeRatio * 100).toFixed(0)}%\n` +
      `💰 PnL: $${pnl.toFixed(2)}\n` +
      `📝 Reason: ${reason}`
    );
  } catch (error) {
    console.error(`Failed to partially close ${trade.coin}:`, error);
  }
}

// ====================== TELEGRAM COMMAND HANDLERS ======================
// Watchlist management
bot.onText(/\/watchlist/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📊 CURRENT WATCHLIST:\n${dynamicWatchlist.join('\n')}`
  );
});

bot.onText(/\/add (.+)/, (msg, match) => {
  const coin = match[1].toUpperCase();
  if (!dynamicWatchlist.includes(coin)) {
    dynamicWatchlist.push(coin);
    bot.sendMessage(msg.chat.id, `✅ ${coin} added to watchlist`);
  } else {
    bot.sendMessage(msg.chat.id, `ℹ️ ${coin} already in watchlist`);
  }
});

bot.onText(/\/remove (.+)/, (msg, match) => {
  const coin = match[1].toUpperCase();
  const index = dynamicWatchlist.indexOf(coin);
  if (index > -1) {
    dynamicWatchlist.splice(index, 1);
    bot.sendMessage(msg.chat.id, `✅ ${coin} removed from watchlist`);
  } else {
    bot.sendMessage(msg.chat.id, `❌ ${coin} not found in watchlist`);
  }
});

// Trading control
bot.onText(/\/start_trading/, (msg) => {
  isTradingActive = true;
  bot.sendMessage(msg.chat.id, '🚀 AUTO TRADING ACTIVATED');
});

bot.onText(/\/stop_trading/, (msg) => {
  isTradingActive = false;
  bot.sendMessage(msg.chat.id, '🛑 AUTO TRADING DEACTIVATED');
});

// Manual trading
bot.onText(/\/force_buy (.+) (.+)/, async (msg, match) => {
  const coin = match[1].toUpperCase();
  const amount = parseFloat(match[2]);
  
  try {
    const order = await exchange.createMarketOrder(`${coin}/USDT`, 'buy', amount);
    db.run(
      `INSERT INTO trades (coin, direction, entry_price, amount, status) VALUES (?, ?, ?, ?, 'OPEN')`,
      [coin, 'LONG', order.price, amount]
    );
    bot.sendMessage(
      msg.chat.id,
      `✅ FORCE BUY EXECUTED\n` +
      `📌 ${coin} @ ${order.price}\n` +
      `💰 Size: $${amount}`
    );
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Force buy failed: ${error.message}`);
  }
});

bot.onText(/\/force_sell (.+)/, async (msg, match) => {
  const coin = match[1].toUpperCase();
  const openTrade = await new Promise(resolve => {
    db.get(
      "SELECT * FROM trades WHERE coin = ? AND status = 'OPEN' LIMIT 1",
      [coin],
      (err, row) => resolve(row)
    );
  });
  
  if (openTrade) {
    const ticker = await exchange.fetchTicker(`${coin}/USDT`);
    await closePosition(openTrade, ticker.last, 'FORCE CLOSE');
    bot.sendMessage(msg.chat.id, `✅ Force sell executed for ${coin}`);
  } else {
    bot.sendMessage(msg.chat.id, `❌ No open position found for ${coin}`);
  }
});

// Help command
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `📚 AVAILABLE COMMANDS:\n\n` +
    `/watchlist - Show current watchlist\n` +
    `/add [coin] - Add coin to watchlist\n` +
    `/remove [coin] - Remove coin from watchlist\n` +
    `/start_trading - Enable auto trading\n` +
    `/stop_trading - Disable auto trading\n` +
    `/force_buy [coin] [amount] - Manual buy\n` +
    `/force_sell [coin] - Manual sell\n` +
    `/help - Show this message`
  );
});

// ====================== MAIN EXECUTION LOOP ======================
async function main() {
  try {
    // Initialize database
    await new Promise(resolve => {
      db.run(`
        CREATE TABLE IF NOT EXISTS trades (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      `, resolve);
    });
    
    console.log('✅ Database initialized');
    
    // Start main trading interval
    setInterval(async () => {
      if (!isTradingActive) return;
      
      try {
        // Generate signals for all watchlist coins
        for (const symbol of dynamicWatchlist) {
          const signal = await generateTradingSignal(symbol);
          if (signal) {
            await executeTrade(symbol, signal.signal, signal.price, signal.reason);
          }
        }
        
        // Manage open positions
        await manageOpenPositions();
      } catch (error) {
        console.error('Main loop error:', error);
      }
    }, 30000); // Run every 30 seconds
    
    console.log('🤖 Trading bot started successfully');
    bot.sendMessage(config.CHAT_ID, '🤖 Trading bot is now ONLINE');
  } catch (error) {
    console.error('Initialization failed:', error);
    process.exit(1);
  }
}

// Start the bot
main();
