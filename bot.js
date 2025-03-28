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
  TRAIL_ACTIVATE: 0.5         // Trail after +0.5%
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

// Simpan watchlist di memory
let dynamicWatchlist = ["WIF", "PEPE", "NOT"]; // Default
const activeTrailingStops = {};
let isTradingActive = false;

// ====================== DATABASE SETUP ======================
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

// ====================== HELPER FUNCTIONS ======================
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

async function closePosition(trade, price, reason) {
  const remainingAmount = trade.tp1_hit 
    ? Math.floor(trade.amount * 0.5) 
    : trade.amount;

  await bybit.createMarketOrder(
    `${trade.coin}/USDT`,
    trade.direction === "LONG" ? "sell" : "buy",
    remainingAmount
  );

  const pnl = (trade.direction === "LONG" ? 1 : -1) * 
              (price - trade.entry_price) * remainingAmount;

  db.run(
    `UPDATE trades SET exit_price = ?, pnl = ?, status = ? WHERE id = ?`,
    [price, pnl, reason, trade.id]
  );

  bot.sendMessage(
    config.CHAT_ID,
    `🏁 ${trade.coin} ${reason}\n` +
    `🔹 Entry: ${trade.entry_price}\n` +
    `🔸 Exit: ${price}\n` +
    `💰 PnL: $${pnl.toFixed(2)}`
  );

  delete activeTrailingStops[trade.id];
}

async function closePartialPosition(trade, price, reason, closeRatio) {
  const closeAmount = Math.floor(trade.amount * closeRatio);
  
  await bybit.createMarketOrder(
    `${trade.coin}/USDT`,
    trade.direction === "LONG" ? "sell" : "buy",
    closeAmount
  );

  const pnl = (trade.direction === "LONG" ? 1 : -1) * 
              (price - trade.entry_price) * closeAmount;

  bot.sendMessage(
    config.CHAT_ID,
    `🎯 ${reason} ${trade.coin}\n` +
    `🔹 Closed: ${closeRatio * 100}% @ ${price}\n` +
    `💰 PnL: $${pnl.toFixed(2)}`
  );
}

// ====================== DCA LOGIC ======================
async function executeDCA(trade) {
  const currentLevel = trade.dca_level + 1;
  if (currentLevel > config.MAX_DCA_LEVELS) return;

  const dcaSize = trade.amount * (config.DCA_INCREASE_PERCENT / 100);
  const ticker = await bybit.fetchTicker(`${trade.coin}/USDT`);
  
  try {
    await bybit.createMarketOrder(
      `${trade.coin}/USDT`,
      trade.direction.toLowerCase(),
      dcaSize
    );

    // Update average entry price
    const newEntry = (trade.entry_price * trade.amount + ticker.last * dcaSize) / 
                    (trade.amount + dcaSize);

    db.run(
      `UPDATE trades SET 
        entry_price = ?, 
        amount = amount + ?, 
        dca_level = ? 
       WHERE id = ?`,
      [newEntry, dcaSize, currentLevel, trade.id]
    );

    // Reset trailing stop for new average
    activeTrailingStops[trade.id] = newEntry * 
      (1 - ((trade.direction === "LONG" ? 1 : -1) * config.SL_PERCENT / 100));

    bot.sendMessage(
      config.CHAT_ID,
      `🔄 DCA LEVEL ${currentLevel} ACTIVATED\n` +
      `🔹 ${trade.coin} @ ${ticker.last}\n` +
      `📈 New Avg Entry: ${newEntry.toFixed(8)}\n` +
      `📊 Size Added: $${(dcaSize * ticker.last).toFixed(2)}`
    );
  } catch (error) {
    console.error("DCA failed:", error.message);
  }
}

// ====================== TRADE MONITORING ======================
async function checkTrades() {
  if (!isTradingActive) return;

  const openTrades = await new Promise(resolve => {
    db.all("SELECT * FROM trades WHERE status = 'OPEN'", (err, rows) => resolve(rows || []));
  });

  for (const trade of openTrades) {
    const ticker = await bybit.fetchTicker(`${trade.coin}/USDT`);
    const currentPrice = ticker.last;
    const pnlPercent = ((currentPrice - trade.entry_price) / trade.entry_price) * 100;
    const direction = trade.direction === "LONG" ? 1 : -1;

    // ===== DCA CHECK =====
    if (trade.dca_level < config.MAX_DCA_LEVELS && 
        direction * pnlPercent <= config.DCA_TRIGGER_PERCENT) {
      await executeDCA(trade);
      continue;
    }

    // ===== TRAILING SL MANAGEMENT =====
    if (!activeTrailingStops[trade.id]) {
      activeTrailingStops[trade.id] = trade.entry_price * 
        (1 - (direction * config.SL_PERCENT / 100));
    }

    // Update trailing stop
    if (direction * pnlPercent >= config.TRAIL_ACTIVATE) {
      const newStop = currentPrice * (1 - (direction * config.SL_PERCENT / 100));
      activeTrailingStops[trade.id] = direction === 1 
        ? Math.max(newStop, trade.entry_price) 
        : Math.min(newStop, trade.entry_price);
    }

    // ===== TAKE PROFIT 1 (50%) =====
    if (!trade.tp1_hit && direction * pnlPercent >= config.TP1_PERCENT) {
      await closePartialPosition(trade, currentPrice, "TP1 HIT", 0.5);
      db.run("UPDATE trades SET tp1_hit = 1 WHERE id = ?", [trade.id]);
      continue;
    }

    // ===== TAKE PROFIT 2 (50% REMAINING) =====
    if (trade.tp1_hit && direction * pnlPercent >= config.TP2_PERCENT) {
      await closePosition(trade, currentPrice, "TP2 HIT");
      continue;
    }

    // ===== TRAILING STOP CHECK =====
    const shouldTrigger = (trade.direction === "LONG" && currentPrice <= activeTrailingStops[trade.id]) ||
                         (trade.direction === "SHORT" && currentPrice >= activeTrailingStops[trade.id]);

    if (shouldTrigger) {
      await closePosition(trade, currentPrice, "TRAILING SL HIT");
    }
  }
}

// ====================== TELEGRAM COMMANDS ======================
const commands = {
  help: `
📚 *Daftar Command*:
/watchlist - Tampilkan koin yang dipantau
/add [coin] - Tambah koin ke watchlist (contoh: /add WIF)
/remove [coin] - Hapus koin dari watchlist
/start_trading - Aktifkan auto trading
/stop_trading - Matikan auto trading
/force_buy [coin] [amount] - Entry manual (contoh: /force_buy PEPE 1)
/force_sell [coin] - Close manual (contoh: /force_sell WIF)
/status - Lihat performance trading
  `,
  
  watchlist: () => `📊 *Watchlist Aktif*:\n${dynamicWatchlist.join(", ")}`,
  
  add: (coin) => {
    coin = coin.toUpperCase();
    if (!dynamicWatchlist.includes(coin)) {
      dynamicWatchlist.push(coin);
      return `✅ ${coin} ditambahkan ke watchlist!`;
    }
    return `❌ ${coin} sudah ada di watchlist!`;
  },
  
  remove: (coin) => {
    coin = coin.toUpperCase();
    const index = dynamicWatchlist.indexOf(coin);
    if (index > -1) {
      dynamicWatchlist.splice(index, 1);
      return `✅ ${coin} dihapus dari watchlist!`;
    }
    return `❌ ${coin} tidak ditemukan di watchlist!`;
  }
};

// Command handlers
bot.onText(/\/help/, (msg) => bot.sendMessage(msg.chat.id, commands.help, { parse_mode: 'Markdown' }));
bot.onText(/\/watchlist/, (msg) => bot.sendMessage(msg.chat.id, commands.watchlist(), { parse_mode: 'Markdown' }));
bot.onText(/\/add (.+)/, (msg, match) => bot.sendMessage(msg.chat.id, commands.add(match[1])));
bot.onText(/\/remove (.+)/, (msg, match) => bot.sendMessage(msg.chat.id, commands.remove(match[1])));

// Trading control
bot.onText(/\/start_trading/, (msg) => {
  isTradingActive = true;
  bot.sendMessage(msg.chat.id, "🚀 AUTO TRADING AKTIF! Menjalankan scan setiap 30 detik...");
});

bot.onText(/\/stop_trading/, (msg) => {
  isTradingActive = false;
  bot.sendMessage(msg.chat.id, "🛑 AUTO TRADING DIMATIKAN!");
});

// Manual trading
bot.onText(/\/force_buy (.+) (.+)/, async (msg, match) => {
  const coin = match[1].toUpperCase();
  const amount = parseFloat(match[2]);
  
  try {
    const order = await bybit.createMarketOrder(`${coin}/USDT`, 'buy', amount);
    db.run(
      `INSERT INTO trades (coin, direction, entry_price, amount, status) VALUES (?, ?, ?, ?, 'OPEN')`,
      [coin, "LONG", order.price, amount]
    );
    bot.sendMessage(msg.chat.id, `✅ FORCE BUY ${coin} ${amount} USDT\n💵 Harga: ${order.price}`);
  } catch (error) {
    bot.sendMessage(msg.chat.id, `❌ Gagal: ${error.message}`);
  }
});

bot.onText(/\/force_sell (.+)/, async (msg, match) => {
  const coin = match[1].toUpperCase();
  const openTrade = await new Promise(resolve => {
    db.get("SELECT * FROM trades WHERE coin = ? AND status = 'OPEN'", [coin], (err, row) => resolve(row));
  });

  if (openTrade) {
    const ticker = await bybit.fetchTicker(`${coin}/USDT`);
    await closePosition(openTrade, ticker.last, "FORCE SELL");
    bot.sendMessage(msg.chat.id, `✅ FORCE SELL ${coin} executed!`);
  } else {
    bot.sendMessage(msg.chat.id, `❌ Tidak ada posisi terbuka untuk ${coin}`);
  }
});

// ====================== MAIN EXECUTION ======================
function main() {
  console.log("🤖 Bot started. Kirim /help untuk command list");
  setInterval(checkTrades, 30000); // Scan setiap 30 detik
}

main();
