// ================================================================
// CRASH GAME 222 - SERVER.JS
// Live crash game + wallet + Paystack + admin panel
// ================================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ================================================================
// CONFIG
// ================================================================

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const GROWTH = 0.1;
const EDGE = 0.99;
const X = 2 ** 52;

const COUNT_MS = 6000;
const OVER_MS = 3500;

const MIN = 10;
const MAX = 10000;
const START = 1000;
const BONUS = 500;

// ================================================================
// PAYSTACK CONFIG
// ================================================================

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY || '';

const APP_URL =
  process.env.APP_URL || '';

const PAYSTACK_CALLBACK_URL =
  process.env.PAYSTACK_CALLBACK_URL ||
  (APP_URL ? APP_URL + '/paystack/callback' : '');

const MIN_DEPOSIT =
  Number(process.env.MIN_DEPOSIT || 100);

const MAX_DEPOSIT =
  Number(process.env.MAX_DEPOSIT || 1000000);

const MIN_WITHDRAWAL =
  Number(process.env.MIN_WITHDRAWAL || 100);

const MAX_WITHDRAWAL =
  Number(process.env.MAX_WITHDRAWAL || 1000000);

const REQUIRE_WITHDRAWAL_APPROVAL =
  String(
    process.env.REQUIRE_WITHDRAWAL_APPROVAL || 'true'
  ) !== 'false';

// ================================================================
// DATABASE
// ================================================================

let db = {
  players: {},
  history: [],
  nonce: 0,
  roundId: 0,
  transactions: [],
  withdrawals: []
};

try {
  if (fs.existsSync(DATA)) {
    const loaded = JSON.parse(
      fs.readFileSync(DATA, 'utf8')
    );

    if (loaded && typeof loaded === 'object') {
      db = {
        ...db,
        ...loaded
      };
    }
  }
} catch (e) {
  console.error('Database load error:', e.message);
}

if (!Array.isArray(db.history)) {
  db.history = [];
}

if (!Array.isArray(db.transactions)) {
  db.transactions = [];
}

if (!Array.isArray(db.withdrawals)) {
  db.withdrawals = [];
}

if (!db.players || typeof db.players !== 'object') {
  db.players = {};
}

// ================================================================
// REFUND OPEN BETS AFTER RESTART
// ================================================================

for (const id of Object.keys(db.players)) {
  const p = db.players[id];

  if (p && Number(p.bet) > 0) {
    p.balance =
      Number(p.balance || 0) +
      Number(p.bet || 0);

    p.bet = 0;
    p.at = 0;
    p.bonusBet = false;
  }
}

// ================================================================
// SAVE SYSTEM
// ================================================================

let dirty = false;

function save() {
  dirty = true;
}

setInterval(() => {
  if (!dirty) return;

  try {
    const tmp = DATA + '.tmp';

    fs.writeFileSync(
      tmp,
      JSON.stringify(db, null, 2)
    );

    fs.renameSync(tmp, DATA);

    dirty = false;
  } catch (e) {
    console.error('Database save error:', e.message);
  }
}, 1000);

// ================================================================
// ADMIN KEY
// ================================================================

let ADMIN_KEY =
  process.env.ADMIN_KEY ||
  db.adminKey ||
  crypto.randomBytes(24).toString('hex');

if (!db.adminKey) {
  db.adminKey = ADMIN_KEY;
  save();
}

console.log('ADMIN KEY:', ADMIN_KEY);

// ================================================================
// TELEGRAM
// ================================================================

const BOT_TOKEN =
  process.env.BOT_TOKEN || '';

// ================================================================
// HELPERS
// ================================================================

const sha = s =>
  crypto
    .createHash('sha256')
    .update(String(s))
    .digest('hex');

function crashFrom(h) {
  const r =
    parseInt(h.slice(0, 13), 16);

  return Math.min(
    1000,
    Math.max(
      1,
      Math.floor(
        100 *
        EDGE *
        X /
        (X - r)
      ) / 100
    )
  );
}

function r2(n) {
  return Math.round(
    Number(n || 0) * 100
  ) / 100;
}

function addLog(type, data = {}) {
  console.log(
    `[${new Date().toISOString()}]`,
    type,
    data
  );
}

function json(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });

  res.end(body);
}

function out(status, data) {
  return {
    status,
    data
  };
}

// ================================================================
// TELEGRAM USER VERIFICATION
// ================================================================

function tgUser(initData) {
  if (!initData || !BOT_TOKEN) {
    return null;
  }

  try {
    const params =
      new URLSearchParams(initData);

    const hash =
      params.get('hash');

    if (!hash) return null;

    params.delete('hash');

    const dataCheckString =
      [...params.entries()]
        .sort(([a], [b]) =>
          a.localeCompare(b)
        )
        .map(([k, v]) =>
          `${k}=${v}`
        )
        .join('\n');

    const secretKey =
      crypto
        .createHmac(
          'sha256',
          'WebAppData'
        )
        .update(BOT_TOKEN)
        .digest();

    const calculated =
      crypto
        .createHmac(
          'sha256',
          secretKey
        )
        .update(dataCheckString)
        .digest('hex');

    if (
      calculated.length !==
      hash.length
    ) {
      return null;
    }

    if (
      !crypto.timingSafeEqual(
        Buffer.from(calculated),
        Buffer.from(hash)
      )
    ) {
      return null;
    }

    const user =
      JSON.parse(
        params.get('user') || '{}'
      );

    return user;
  } catch (e) {
    return null;
  }
}

// ================================================================
// PLAYER
// ================================================================

function playerIdFromUser(user) {
  return String(
    user.id ||
    user.username ||
    user.first_name ||
    ''
  );
}

function getPlayer(user) {
  const id =
    playerIdFromUser(user);

  if (!id) return null;

  if (!db.players[id]) {
    db.players[id] = {
      id,
      username: user.username || '',
      firstName: user.first_name || '',
      balance: START,
      bonus: BONUS,
      bet: 0,
      at: 0,
      bonusBet: false,
      createdAt: Date.now(),
      totalBets: 0,
      totalWins: 0,
      totalLosses: 0,
      totalWagered: 0,
      totalWon: 0,
      totalWithdrawn: 0
    };

    save();
  }

  const p = db.players[id];

  p.username =
    user.username ||
    p.username ||
    '';

  p.firstName =
    user.first_name ||
    p.firstName ||
    '';

  return p;
}

// ================================================================
// TRANSACTIONS
// ================================================================

function txId(prefix = 'TX') {
  return (
    prefix +
    '_' +
    Date.now() +
    '_' +
    crypto
      .randomBytes(5)
      .toString('hex')
  );
}

function addTx(tx) {
  db.transactions.unshift({
    id: tx.id || txId('TX'),
    createdAt:
      tx.createdAt || Date.now(),
    ...tx
  });

  if (db.transactions.length > 500) {
    db.transactions =
      db.transactions.slice(0, 500);
  }

  save();
}

// ================================================================
// FIND PLAYER
// ================================================================

function findPlayerById(id) {
  return db.players[String(id)] || null;
}

// ================================================================
// HTTP REQUEST HELPER
// ================================================================

function jsonReq(
  url,
  options = {},
  body = null
) {
  return new Promise(
    (resolve, reject) => {
      try {
        const u = new URL(url);

        const req =
          require('https').request(
            {
              hostname: u.hostname,
              port:
                u.port ||
                443,
              path:
                u.pathname +
                u.search,
              method:
                options.method ||
                'GET',
              headers: {
                ...(options.headers || {}),
                ...(body
                  ? {
                      'Content-Type':
                        'application/json',
                      'Content-Length':
                        Buffer.byteLength(
                          JSON.stringify(body)
                        )
                    }
                  : {})
              }
            },
            res => {
              let data = '';

              res.on(
                'data',
                c => {
                  data += c;
                }
              );

              res.on(
                'end',
                () => {
                  let parsed =
                    data;

                  try {
                    parsed =
                      JSON.parse(data);
                  } catch (_) {}

                  resolve({
                    status:
                      res.statusCode,
                    data: parsed
                  });
                }
              );
            }
          );

        req.on(
          'error',
          reject
        );

        if (body) {
          req.write(
            JSON.stringify(body)
          );
        }

        req.end();
      } catch (e) {
        reject(e);
      }
    }
  );
}

// ================================================================
// PAYSTACK
// ================================================================

async function paystack(
  endpoint,
  method = 'GET',
  body = null
) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error(
      'PAYSTACK_SECRET_KEY is not configured'
    );
  }

  return jsonReq(
    'https://api.paystack.co' +
      endpoint,
    {
      method,
      headers: {
        Authorization:
          'Bearer ' +
          PAYSTACK_SECRET_KEY
      }
    },
    body
  );
}

// ================================================================
// CREDIT VERIFIED DEPOSIT
// ================================================================

function creditVerifiedDeposit(
  reference,
  amount,
  playerId,
  extra = {}
) {
  const existing =
    db.transactions.find(
      t =>
        t.type === 'deposit' &&
        t.reference === reference
    );

  if (existing) {
    return existing;
  }

  const p =
    findPlayerById(playerId);

  if (!p) {
    throw new Error(
      'Player not found'
    );
  }

  const naira =
    Number(amount);

  if (
    !Number.isFinite(naira) ||
    naira <= 0
  ) {
    throw new Error(
      'Invalid deposit amount'
    );
  }

  p.balance =
    Number(p.balance || 0) +
    naira;

  const tx = {
    id: txId('DEP'),
    type: 'deposit',
    status: 'success',
    playerId: String(playerId),
    reference,
    amount: naira,
    createdAt: Date.now(),
    ...extra
  };

  db.transactions.unshift(tx);

  if (db.transactions.length > 500) {
    db.transactions =
      db.transactions.slice(0, 500);
  }

  save();

  addLog(
    'DEPOSIT_CREDITED',
    {
      playerId,
      amount: naira,
      reference
    }
  );

  return tx;
}

// ================================================================
// PAYSTACK TRANSFER
// ================================================================

async function createWithdrawalTransfer(
  withdrawal
) {
  if (!PAYSTACK_SECRET_KEY) {
    throw new Error(
      'PAYSTACK_SECRET_KEY is not configured'
    );
  }

  const response =
    await paystack(
      '/transfer',
      'POST',
      {
        source: 'balance',
        amount:
          Math.round(
            Number(
              withdrawal.amount
            ) * 100
          ),
        recipient:
          withdrawal.recipientCode,
        reason:
          withdrawal.reason ||
          'Crash Game withdrawal'
      }
    );

  return response;
}

// ================================================================
// CRASH ENGINE
// ================================================================

let R = null;

// ---------------------------------------------------------------
// CURRENT MULTIPLIER
// ---------------------------------------------------------------

function liveMultiplier() {
  if (!R) return 1;

  if (R.phase === 'count') {
    return 1;
  }

  if (R.phase === 'over') {
    return R.crash;
  }

  const elapsed =
    Date.now() -
    R.flyStart;

  const m =
    Math.exp(
      GROWTH *
      elapsed /
      1000
    );

  return Math.min(
    R.crash,
    Math.floor(m * 100) / 100
  );
}

// ---------------------------------------------------------------
// START ROUND
// ---------------------------------------------------------------

function startRound() {
  const seed =
    crypto
      .randomBytes(16)
      .toString('hex');

  db.nonce++;
  db.roundId++;

  R = {
    id: db.roundId,

    phase: 'count',

    seed,

    nonce: db.nonce,

    // Public commitment made BEFORE the result
    commit: sha(seed),

    // Crash result is generated independently
    crash: crashFrom(
      sha(
        seed +
        ':' +
        db.nonce
      )
    ),

    countEnd:
      Date.now() +
      COUNT_MS,

    flyStart: 0,

    overEnd: 0,

    bets: {}
  };

  save();

  broadcast();
}

// ---------------------------------------------------------------
// CASHOUT
// ---------------------------------------------------------------

function cash(
  t,
  m
) {
  if (!R) {
    return {
      ok: false,
      error: 'No round'
    };
  }

  const b =
    R.bets[t];

  if (!b) {
    return {
      ok: false,
      error: 'No active bet'
    };
  }

  if (b.cashed) {
    return {
      ok: false,
      error: 'Already cashed'
    };
  }

  if (
    R.phase !== 'fly'
  ) {
    return {
      ok: false,
      error: 'Cashout unavailable'
    };
  }

  const p =
    db.players[t];

  if (!p) {
    return {
      ok: false,
      error: 'Player not found'
    };
  }

  const current =
    liveMultiplier();

  if (
    Number(m) < 1 ||
    Number(m) > R.crash
  ) {
    return {
      ok: false,
      error: 'Invalid multiplier'
    };
  }

  if (
    current < Number(m)
  ) {
    return {
      ok: false,
      error: 'Multiplier not reached'
    };
  }

  const mult =
    r2(
      Math.min(
        Number(m),
        R.crash
      )
    );

  const win =
    r2(
      Number(b.amount) *
      mult
    );

  b.cashed = true;
  b.cashout = mult;
  b.win = win;

  p.balance =
    Number(p.balance || 0) +
    win;

  p.bet = 0;
  p.at = 0;
  p.bonusBet = false;

  p.totalWins =
    Number(p.totalWins || 0) +
    1;

  p.totalWon =
    Number(p.totalWon || 0) +
    win;

  addTx({
    id: txId('WIN'),
    type: 'game_win',
    playerId: t,
    amount: win,
    multiplier: mult,
    roundId: R.id,
    createdAt: Date.now()
  });

  save();

  addLog(
    'CASHOUT',
    {
      playerId: t,
      roundId: R.id,
      multiplier: mult,
      win
    }
  );

  broadcast();

  return {
    ok: true,
    multiplier: mult,
    win,
    balance: p.balance
  };
}

// ---------------------------------------------------------------
// END ROUND
// ---------------------------------------------------------------

function endRound() {
  if (!R) return;

  if (R.phase === 'over') {
    return;
  }

  R.phase = 'over';

  R.overEnd =
    Date.now() +
    OVER_MS;

  // Settle unresolved bets as losses
  for (const t of Object.keys(R.bets)) {
    const b =
      R.bets[t];

    if (!b.cashed) {
      const p =
        db.players[t];

      if (p) {
        p.bet = 0;
        p.at = 0;
        p.bonusBet = false;

        p.totalLosses =
          Number(
            p.totalLosses || 0
          ) + 1;

        addTx({
          id: txId('LOSS'),
          type: 'game_loss',
          playerId: t,
          amount:
            Number(
              b.amount || 0
            ),
          roundId: R.id,
          crash: R.crash,
          createdAt: Date.now()
        });
      }
    }
  }

  // -------------------------------------------------------------
  // SAVE COMPLETE ROUND
  // -------------------------------------------------------------

  db.history.unshift({
    id: R.id,
    crash: R.crash,
    seed: R.seed,
    nonce: R.nonce,
    commit: R.commit,

    generatedAt: Date.now(),

    generation:
      'server-cryptographic',

    algorithm:
      'SHA-256(seed:nonce)'
  });

  if (db.history.length > 30) {
    db.history =
      db.history.slice(0, 30);
  }

  save();

  addLog(
    'ROUND_COMPLETE',
    {
      roundId: R.id,
      crash: R.crash,
      nonce: R.nonce,
      commit: R.commit
    }
  );

  broadcast();
}

// ================================================================
// SSE
// ================================================================

const conns =
  new Set();

function snapshot() {
  if (!R) {
    return {
      round: null,
      history:
        db.history
          .slice(0, 15)
          .map(h => h.crash)
    };
  }

  const over =
    R.phase === 'over';

  return {
    round: {
      id: R.id,
      phase: R.phase,

      commit: R.commit,

      countEnd:
        R.countEnd,

      flyStart:
        R.flyStart,

      crash:
        over
          ? R.crash
          : null,

      seed:
        over
          ? R.seed
          : null
    },

    history:
      db.history
        .slice(0, 15)
        .map(
          h => h.crash
        )
  };
}

function broadcast() {
  const data =
    JSON.stringify(
      snapshot()
    );

  for (const res of conns) {
    try {
      res.write(
        `data: ${data}\n\n`
      );
    } catch (_) {
      conns.delete(res);
    }
  }
}

// ================================================================
// GAME LOOP
// ================================================================

setInterval(() => {
  if (!R) return;

  const now =
    Date.now();

  if (
    R.phase === 'count' &&
    now >= R.countEnd
  ) {
    R.phase = 'fly';

    R.flyStart =
      now;

    save();

    broadcast();

    return;
  }

  if (
    R.phase === 'fly'
  ) {
    const m =
      liveMultiplier();

    // Auto cashouts
    for (
      const t of Object.keys(
        R.bets
      )
    ) {
      const b =
        R.bets[t];

      if (
        !b ||
        b.cashed ||
        !b.auto
      ) {
        continue;
      }

      if (
        m >= Number(b.auto)
      ) {
        cash(
          t,
          Number(b.auto)
        );
      }
    }

    // Crash
    if (
      m >= R.crash
    ) {
      endRound();
    }

    return;
  }

  if (
    R.phase === 'over' &&
    now >= R.overEnd
  ) {
    startRound();
  }
}, 50);

// ================================================================
// PLAYER ACTIONS
// ================================================================

async function playerAction(
  action,
  body
) {
  const user =
    tgUser(
      body.initData ||
      body.init_data ||
      ''
    );

  if (!user) {
    return out(
      401,
      {
        ok: false,
        error:
          'Telegram verification failed'
      }
    );
  }

  const p =
    getPlayer(user);

  if (!p) {
    return out(
      400,
      {
        ok: false,
        error:
          'Player unavailable'
      }
    );
  }

  const id =
    String(p.id);

  // -------------------------------------------------------------
  // BET
  // -------------------------------------------------------------

  if (action === 'bet') {
    if (!R) {
      return out(
        503,
        {
          ok: false,
          error:
            'Game unavailable'
        }
      );
    }

    if (
      R.phase !== 'count'
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            'Betting is closed'
        }
      );
    }

    if (
      Number(p.bet) > 0
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            'Bet already placed'
        }
      );
    }

    const amount =
      Number(body.amount);

    if (
      !Number.isFinite(amount) ||
      amount < MIN ||
      amount > MAX
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            `Bet must be between ₦${MIN} and ₦${MAX}`
        }
      );
    }

    if (
      Number(p.balance) <
      amount
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            'Insufficient balance'
        }
      );
    }

    const auto =
      Number(body.auto || 0);

    p.balance =
      Number(p.balance) -
      amount;

    p.bet = amount;

    p.at = Date.now();

    p.bonusBet = false;

    p.totalBets =
      Number(
        p.totalBets || 0
      ) + 1;

    p.totalWagered =
      Number(
        p.totalWagered || 0
      ) + amount;

    R.bets[id] = {
      amount,
      auto:
        auto >= 1.01
          ? r2(auto)
          : 0,
      cashed: false,
      placedAt: Date.now()
    };

    save();

    addLog(
      'BET',
      {
        playerId: id,
        roundId: R.id,
        amount
      }
    );

    broadcast();

    return out(
      200,
      {
        ok: true,
        balance:
          p.balance,
        bet:
          p.bet,
        roundId:
          R.id
      }
    );
  }

  // -------------------------------------------------------------
  // CANCEL
  // -------------------------------------------------------------

  if (action === 'cancel') {
    if (!R) {
      return out(
        400,
        {
          ok: false,
          error:
            'No round'
        }
      );
    }

    if (
      R.phase !== 'count'
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            'Cannot cancel now'
        }
      );
    }

    const b =
      R.bets[id];

    if (!b) {
      return out(
        400,
        {
          ok: false,
          error:
            'No active bet'
        }
      );
    }

    p.balance =
      Number(p.balance || 0) +
      Number(b.amount || 0);

    p.bet = 0;
    p.at = 0;
    p.bonusBet = false;

    delete R.bets[id];

    save();

    broadcast();

    return out(
      200,
      {
        ok: true,
        balance:
          p.balance
      }
    );
  }

  // -------------------------------------------------------------
  // CASHOUT
  // -------------------------------------------------------------

  if (action === 'cashout') {
    const m =
      Number(
        body.multiplier
      );

    const result =
      cash(id, m);

    return out(
      result.ok ? 200 : 400,
      result
    );
  }

  // -------------------------------------------------------------
  // RESTORE
  // -------------------------------------------------------------

  if (action === 'restore') {
    return out(
      200,
      {
        ok: true,
        player: {
          id: p.id,
          username:
            p.username,
          firstName:
            p.firstName,
          balance:
            Number(
              p.balance || 0
            ),
          bonus:
            Number(
              p.bonus || 0
            ),
          bet:
            Number(
              p.bet || 0
            ),
          stats: {
            totalBets:
              Number(
                p.totalBets || 0
              ),
            totalWins:
              Number(
                p.totalWins || 0
              ),
            totalLosses:
              Number(
                p.totalLosses || 0
              ),
            totalWagered:
              Number(
                p.totalWagered || 0
              ),
            totalWon:
              Number(
                p.totalWon || 0
              ),
            totalWithdrawn:
              Number(
                p.totalWithdrawn || 0
              )
          }
        },
        round:
          snapshot().round
      }
    );
  }

  // -------------------------------------------------------------
  // BONUS
  // -------------------------------------------------------------

  if (action === 'bonus') {
    if (
      Number(p.bonus || 0) <= 0
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            'No bonus available'
        }
      );
    }

    const amount =
      Number(p.bonus);

    p.bonus = 0;

    p.balance =
      Number(p.balance || 0) +
      amount;

    save();

    return out(
      200,
      {
        ok: true,
        balance:
          p.balance,
        bonus:
          p.bonus
      }
    );
  }

  // -------------------------------------------------------------
  // DEPOSIT INITIALIZE
  // -------------------------------------------------------------

  if (action === 'deposit') {
    const amount =
      Number(body.amount);

    if (
      !Number.isFinite(amount) ||
      amount < MIN_DEPOSIT ||
      amount > MAX_DEPOSIT
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            `Deposit must be between ₦${MIN_DEPOSIT} and ₦${MAX_DEPOSIT}`
        }
      );
    }

    if (!PAYSTACK_SECRET_KEY) {
      return out(
        503,
        {
          ok: false,
          error:
            'Payment system not configured'
        }
      );
    }

    const email =
      String(
        body.email ||
        `${p.id}@telegram.local`
      );

    try {
      const response =
        await paystack(
          '/transaction/initialize',
          'POST',
          {
            email,
            amount:
              Math.round(
                amount * 100
              ),
            callback_url:
              PAYSTACK_CALLBACK_URL,
            metadata: {
              playerId:
                String(p.id),
              telegramId:
                String(p.id)
            }
          }
        );

      if (
        !response.data ||
        !response.data.status
      ) {
        return out(
          400,
          {
            ok: false,
            error:
              response.data &&
              response.data.message
                ? response.data.message
                : 'Paystack initialization failed'
          }
        );
      }

      addTx({
        id: txId('DEPINIT'),
        type:
          'deposit_initialization',
        status:
          'pending',
        playerId:
          String(p.id),
        amount,
        reference:
          response.data.data
            .reference,
        createdAt:
          Date.now()
      });

      return out(
        200,
        {
          ok: true,
          authorization_url:
            response.data.data
              .authorization_url,
          reference:
            response.data.data
              .reference
        }
      );
    } catch (e) {
      return out(
        500,
        {
          ok: false,
          error:
            e.message
        }
      );
    }
  }

  // -------------------------------------------------------------
  // RESOLVE BANK
  // -------------------------------------------------------------

  if (action === 'resolveBank') {
    const accountNumber =
      String(
        body.account_number ||
        ''
      );

    const bankCode =
      String(
        body.bank_code ||
        ''
      );

    if (
      !/^\d{10}$/.test(
        accountNumber
      )
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            'Invalid account number'
        }
      );
    }

    if (!bankCode) {
      return out(
        400,
        {
          ok: false,
          error:
            'Bank code required'
        }
      );
    }

    try {
      const response =
        await paystack(
          '/bank/resolve',
          'GET'
        );

      return out(
        200,
        {
          ok: true,
          data:
            response.data
        }
      );
    } catch (e) {
      return out(
        500,
        {
          ok: false,
          error:
            e.message
        }
      );
    }
  }

  // -------------------------------------------------------------
  // WITHDRAW
  // -------------------------------------------------------------

  if (action === 'withdraw') {
    const amount =
      Number(body.amount);

    if (
      !Number.isFinite(amount) ||
      amount < MIN_WITHDRAWAL ||
      amount > MAX_WITHDRAWAL
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            `Withdrawal must be between ₦${MIN_WITHDRAWAL} and ₦${MAX_WITHDRAWAL}`
        }
      );
    }

    if (
      Number(p.balance || 0) <
      amount
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            'Insufficient balance'
        }
      );
    }

    const accountNumber =
      String(
        body.account_number ||
        ''
      );

    const bankCode =
      String(
        body.bank_code ||
        ''
      );

    const accountName =
      String(
        body.account_name ||
        ''
      );

    if (
      !/^\d{10}$/.test(
        accountNumber
      )
    ) {
      return out(
        400,
        {
          ok: false,
          error:
            'Invalid account number'
        }
      );
    }

    if (!bankCode) {
      return out(
        400,
        {
          ok: false,
          error:
            'Bank code required'
        }
      );
    }

    const withdrawal = {
      id:
        txId('WD'),
      playerId:
        String(p.id),
      amount,
      accountNumber,
      bankCode,
      accountName,
      status:
        REQUIRE_WITHDRAWAL_APPROVAL
          ? 'pending'
          : 'processing',
      createdAt:
        Date.now()
    };

    // Reserve funds
    p.balance =
      Number(p.balance || 0) -
      amount;

    db.withdrawals.unshift(
      withdrawal
    );

    if (
      db.withdrawals.length >
      500
    ) {
      db.withdrawals =
        db.withdrawals.slice(
          0,
          500
        );
    }

    addTx({
      id:
        withdrawal.id,
      type:
        'withdrawal',
      status:
        withdrawal.status,
      playerId:
        String(p.id),
      amount,
      createdAt:
        Date.now()
    });

    save();

    addLog(
      'WITHDRAWAL_CREATED',
      {
        id:
          withdrawal.id,
        playerId:
          p.id,
        amount
      }
    );

    // -----------------------------------------------------------
    // AUTO TRANSFER WHEN APPROVAL IS DISABLED
    // -----------------------------------------------------------

    if (
      !REQUIRE_WITHDRAWAL_APPROVAL
    ) {
      try {
        if (
          !withdrawal.recipientCode
        ) {
          const recipient =
            await paystack(
              '/transferrecipient',
              'POST',
              {
                type:
                  'nuban',
                name:
                  accountName ||
                  'Customer',
                account_number:
                  accountNumber,
                bank_code:
                  bankCode,
                currency:
                  'NGN'
              }
            );

          if (
            !recipient.data ||
            !recipient.data.status
          ) {
            throw new Error(
              recipient.data &&
              recipient.data.message
                ? recipient.data.message
                : 'Recipient creation failed'
            );
          }

          withdrawal.recipientCode =
            recipient.data.data
              .recipient_code;
        }

        const transfer =
          await createWithdrawalTransfer(
            withdrawal
          );

        if (
          transfer.data &&
          transfer.data.status
        ) {
          withdrawal.status =
            'processing';

          withdrawal.transfer =
            transfer.data.data;

          save();
        } else {
          throw new Error(
            transfer.data &&
            transfer.data.message
              ? transfer.data.message
              : 'Transfer failed'
          );
        }
      } catch (e) {
        // Refund failed transfer
        p.balance =
          Number(p.balance || 0) +
          amount;

        withdrawal.status =
          'failed';

        withdrawal.error =
          e.message;

        addTx({
          id:
            txId('REFUND'),
          type:
            'withdrawal_refund',
          status:
            'success',
          playerId:
            String(p.id),
          amount,
          withdrawalId:
            withdrawal.id,
          createdAt:
            Date.now()
        });

        save();

        addLog(
          'WITHDRAWAL_REFUNDED',
          {
            id:
              withdrawal.id,
            error:
              e.message
          }
        );
      }
    }

    return out(
      200,
      {
        ok: true,
        withdrawal,
        balance:
          p.balance
      }
    );
  }

  return out(
    404,
    {
      ok: false,
      error:
        'Unknown action'
    }
  );
}

// ================================================================
// SERVER
// ================================================================

const server =
  http.createServer(
    async (req, res) => {

      // -----------------------------------------------------------
      // CORS
      // -----------------------------------------------------------

      if (
        req.method === 'OPTIONS'
      ) {
        res.writeHead(204, {
          'Access-Control-Allow-Origin':
            '*',
          'Access-Control-Allow-Methods':
            'GET,POST,OPTIONS',
          'Access-Control-Allow-Headers':
            'Content-Type,Authorization'
        });

        return res.end();
      }

      const u =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      // -----------------------------------------------------------
      // READ BODY
      // -----------------------------------------------------------

      let body = {};

      if (
        req.method === 'POST'
      ) {
        try {
          const chunks = [];

          for await (
            const chunk of req
          ) {
            chunks.push(chunk);
          }

          const raw =
            Buffer
              .concat(chunks)
              .toString();

          body =
            raw
              ? JSON.parse(raw)
              : {};
        } catch (e) {
          return json(
            res,
            400,
            {
              ok: false,
              error:
                'Invalid JSON'
            }
          );
        }
      }

      // ===========================================================
      // PAYSTACK WEBHOOK
      // ===========================================================

      if (
        u.pathname ===
          '/paystack/webhook' &&
        req.method === 'POST'
      ) {
        try {
          const signature =
            req.headers[
              'x-paystack-signature'
            ];

          const rawBody =
            JSON.stringify(body);

          if (
            PAYSTACK_SECRET_KEY &&
            signature
          ) {
            const expected =
              crypto
                .createHmac(
                  'sha512',
                  PAYSTACK_SECRET_KEY
                )
                .update(rawBody)
                .digest('hex');

            if (
              expected !==
              signature
            ) {
              return json(
                res,
                401,
                {
                  ok: false,
                  error:
                    'Invalid signature'
                }
              );
            }
          }

          if (
            body.event ===
              'charge.success'
          ) {
            const data =
              body.data || {};

            const reference =
              data.reference;

            const metadata =
              data.metadata || {};

            const playerId =
              metadata.playerId ||
              metadata.telegramId;

            const amount =
              Number(
                data.amount || 0
              ) / 100;

            if (
              reference &&
              playerId &&
              amount > 0
            ) {
              creditVerifiedDeposit(
                reference,
                amount,
                String(playerId),
                {
                  channel:
                    'webhook'
                }
              );
            }
          }

          return json(
            res,
            200,
            {
              ok: true
            }
          );
        } catch (e) {
          console.error(
            'Webhook error:',
            e
          );

          return json(
            res,
            500,
            {
              ok: false,
              error:
                e.message
            }
          );
        }
      }

      // ===========================================================
      // PAYSTACK CALLBACK
      // ===========================================================

      if (
        u.pathname ===
          '/paystack/callback' &&
        req.method === 'GET'
      ) {
        const reference =
          u.searchParams.get(
            'reference'
          );

        if (!reference) {
          res.writeHead(
            400,
            {
              'Content-Type':
                'text/plain'
            }
          );

          return res.end(
            'Missing reference'
          );
        }

        try {
          const response =
            await paystack(
              '/transaction/verify/' +
                encodeURIComponent(
                  reference
                ),
              'GET'
            );

          if (
            response.data &&
            response.data.status &&
            response.data.data &&
            response.data.data.status ===
              'success'
          ) {
            const data =
              response.data.data;

            const metadata =
              data.metadata || {};

            const playerId =
              metadata.playerId ||
              metadata.telegramId;

            const amount =
              Number(
                data.amount || 0
              ) / 100;

            if (
              playerId &&
              amount > 0
            ) {
              creditVerifiedDeposit(
                reference,
                amount,
                String(playerId),
                {
                  channel:
                    'callback'
                }
              );
            }
          }

          res.writeHead(
            200,
            {
              'Content-Type':
                'text/html; charset=utf-8'
            }
          );

          return res.end(`
<!doctype html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Payment</title>
</head>
<body style="font-family:Arial;text-align:center;padding:40px">
<h2>Payment processed</h2>
<p>You can return to the game.</p>
</body>
</html>
          `);
        } catch (e) {
          return json(
            res,
            500,
            {
              ok: false,
              error:
                e.message
            }
          );
        }
      }

      // ===========================================================
      // SSE EVENTS
      // ===========================================================

      if (
        u.pathname === '/events' &&
        req.method === 'GET'
      ) {
        res.writeHead(
          200,
          {
            'Content-Type':
              'text/event-stream',
            'Cache-Control':
              'no-cache, no-store, must-revalidate',
            Connection:
              'keep-alive',
            'Access-Control-Allow-Origin':
              '*'
          }
        );

        res.write(
          `data: ${JSON.stringify(
            snapshot()
          )}\n\n`
        );

        conns.add(res);

        const ping =
          setInterval(
            () => {
              try {
                res.write(
                  ': ping\n\n'
                );
              } catch (_) {}
            },
            15000
          );

        req.on(
          'close',
          () => {
            clearInterval(
              ping
            );

            conns.delete(
              res
            );
          }
        );

        return;
      }

      // ===========================================================
      // BANK LIST
      // ===========================================================

      if (
        u.pathname ===
          '/api/banks' &&
        req.method === 'GET'
      ) {
        try {
          const response =
            await paystack(
              '/bank?country=nigeria&perPage=100',
              'GET'
            );

          return json(
            res,
            200,
            response.data
          );
        } catch (e) {
          return json(
            res,
            500,
            {
              ok: false,
              error:
                e.message
            }
          );
        }
      }

      // ===========================================================
      // PUBLIC TRANSACTIONS
      // ===========================================================

      if (
        u.pathname ===
          '/api/transactions' &&
        req.method === 'GET'
      ) {
        return json(
          res,
          200,
          {
            ok: true,
            transactions:
              db.transactions
                .slice(0, 100)
          }
        );
      }

      // ===========================================================
      // PLAYER API
      // ===========================================================

      if (
        u.pathname.startsWith(
          '/api/'
        ) &&
        req.method === 'POST'
      ) {
        const action =
          u.pathname
            .slice(5)
            .replace(
              /^\/+/,
              ''
            );

        const result =
          await playerAction(
            action,
            body
          );

        return json(
          res,
          result.status,
          result.data
        );
      }

      // ===========================================================
      // ADMIN PAGE
      // ===========================================================

      if (
        u.pathname === '/admin' &&
        req.method === 'GET'
      ) {
        const file =
          path.join(
            __dirname,
            'admin.html'
          );

        if (
          !fs.existsSync(file)
        ) {
          return json(
            res,
            404,
            {
              ok: false,
              error:
                'admin.html not found'
            }
          );
        }

        res.writeHead(
          200,
          {
            'Content-Type':
              'text/html; charset=utf-8',
            'Cache-Control':
              'no-store'
          }
        );

        return res.end(
          fs.readFileSync(
            file
          )
        );
      }

      // ===========================================================
      // ADMIN API
      // ===========================================================

      if (
        u.pathname.startsWith(
          '/admin/api/'
        ) &&
        req.method === 'POST'
      ) {
        const act =
          u.pathname
            .slice(
              '/admin/api/'.length
            )
            .replace(
              /^\/+/,
              ''
            );

        const key =
          body.key ||
          body.adminKey ||
          '';

        if (
          key !== ADMIN_KEY
        ) {
          return json(
            res,
            401,
            {
              ok: false,
              error:
                'Unauthorized'
            }
          );
        }

        // ---------------------------------------------------------
        // ADMIN STATE
        // ---------------------------------------------------------

        if (
          act === 'state'
        ) {
          const players =
            Object.values(
              db.players
            );

          return json(
            res,
            200,
            {
              ok: true,

              online:
                conns.size,

              total:
                players.length,

              round: R
                ? {
                    id:
                      R.id,

                    phase:
                      R.phase,

                    bets:
                      Object.keys(
                        R.bets
                      ).length,

                    multiplier:
                      r2(
                        liveMultiplier()
                      ),

                    crash:
                      R.phase ===
                      'over'
                        ? R.crash
                        : null,

                    commit:
                      R.commit,

                    nonce:
                      R.nonce,

                    generation:
                      'server-cryptographic',

                    startedAt:
                      R.flyStart ||
                      null,

                    completedAt:
                      R.phase ===
                      'over'
                        ? R.overEnd -
                          OVER_MS
                        : null
                  }
                : null,

              paystack:
                {
                  configured:
                    Boolean(
                      PAYSTACK_SECRET_KEY
                    ),

                  minDeposit:
                    MIN_DEPOSIT,

                  maxDeposit:
                    MAX_DEPOSIT,

                  minWithdrawal:
                    MIN_WITHDRAWAL,

                  maxWithdrawal:
                    MAX_WITHDRAWAL,

                  approvalRequired:
                    REQUIRE_WITHDRAWAL_APPROVAL
                },

              players:
                players.map(
                  p => ({
                    id:
                      p.id,
                    username:
                      p.username,
                    firstName:
                      p.firstName,
                    balance:
                      Number(
                        p.balance ||
                          0
                      ),
                    bonus:
                      Number(
                        p.bonus ||
                          0
                      ),
                    bet:
                      Number(
                        p.bet ||
                          0
                      ),
                    totalBets:
                      Number(
                        p.totalBets ||
                          0
                      ),
                    totalWins:
                      Number(
                        p.totalWins ||
                          0
                      ),
                    totalLosses:
                      Number(
                        p.totalLosses ||
                          0
                      ),
                    totalWagered:
                      Number(
                        p.totalWagered ||
                          0
                      ),
                    totalWon:
                      Number(
                        p.totalWon ||
                          0
                      ),
                    totalWithdrawn:
                      Number(
                        p.totalWithdrawn ||
                          0
                      ),
                    createdAt:
                      p.createdAt
                  })
                )
            }
          );
        }

        // ---------------------------------------------------------
        // LIVE CRASH
        // ---------------------------------------------------------

        if (
          act === 'live-crash'
        ) {
          const latest =
            db.history[0] ||
            null;

          let verification =
            null;

          if (
            R &&
            R.phase === 'over'
          ) {
            const derivedHash =
              sha(
                R.seed +
                ':' +
                R.nonce
              );

            const derivedCrash =
              crashFrom(
                derivedHash
              );

            verification = {
              seed:
                R.seed,

              commit:
                R.commit,

              calculatedCommit:
                sha(R.seed),

              commitValid:
                sha(R.seed) ===
                R.commit,

              derivedHash,

              calculatedCrash:
                derivedCrash,

              recordedCrash:
                R.crash,

              crashMatches:
                derivedCrash ===
                R.crash
            };
          }

          return json(
            res,
            200,
            {
              ok: true,

              live: R
                ? {
                    roundId:
                      R.id,

                    phase:
                      R.phase,

                    multiplier:
                      r2(
                        liveMultiplier()
                      ),

                    crash:
                      R.phase ===
                      'over'
                        ? R.crash
                        : null,

                    commit:
                      R.commit,

                    nonce:
                      R.nonce,

                    generation:
                      'server-cryptographic',

                    algorithm:
                      'SHA-256(seed:nonce)',

                    serverTime:
                      Date.now(),

                    verification
                  }
                : null,

              lastCompleted:
                latest
                  ? {
                      id:
                        latest.id,

                      crash:
                        latest.crash,

                      commit:
                        latest.commit,

                      nonce:
                        latest.nonce,

                      generatedAt:
                        latest.generatedAt ||
                        null,

                      generation:
                        latest.generation ||
                        'server-cryptographic',

                      algorithm:
                        latest.algorithm ||
                        'SHA-256(seed:nonce)'
                    }
                  : null,

              history:
                db.history
                  .slice(0, 15)
                  .map(
                    h => ({
                      id:
                        h.id,

                      crash:
                        h.crash,

                      commit:
                        h.commit,

                      nonce:
                        h.nonce,

                      generatedAt:
                        h.generatedAt ||
                        null,

                      generation:
                        h.generation ||
                        'server-cryptographic',

                      algorithm:
                        h.algorithm ||
                        'SHA-256(seed:nonce)'
                    })
                  )
            }
          );
        }

        // ---------------------------------------------------------
        // FINANCIALS
        // ---------------------------------------------------------

        if (
          act === 'financials'
        ) {
          return json(
            res,
            200,
            {
              ok: true,

              transactions:
                db.transactions
                  .slice(0, 200),

              withdrawals:
                db.withdrawals
                  .slice(0, 200)
            }
          );
        }

        // ---------------------------------------------------------
        // TRANSACTIONS
        // ---------------------------------------------------------

        if (
          act === 'transactions'
        ) {
          return json(
            res,
            200,
            {
              ok: true,

              transactions:
                db.transactions
                  .slice(0, 200)
            }
          );
        }

        // ---------------------------------------------------------
        // WITHDRAWALS
        // ---------------------------------------------------------

        if (
          act === 'withdrawals'
        ) {
          return json(
            res,
            200,
            {
              ok: true,

              withdrawals:
                db.withdrawals
                  .slice(0, 200)
            }
          );
        }

        // ---------------------------------------------------------
        // APPROVE WITHDRAWAL
        // Supports BOTH names
        // ---------------------------------------------------------

        if (
          act ===
            'approve-withdrawal' ||
          act ===
            'approveWithdrawal'
        ) {
          const id =
            String(
              body.id ||
              body.withdrawalId ||
              ''
            );

          const w =
            db.withdrawals.find(
              x =>
                String(x.id) ===
                id
            );

          if (!w) {
            return json(
              res,
              404,
              {
                ok: false,
                error:
                  'Withdrawal not found'
              }
            );
          }

          if (
            w.status !==
            'pending'
          ) {
            return json(
              res,
              400,
              {
                ok: false,
                error:
                  'Withdrawal is not pending'
              }
            );
          }

          const p =
            findPlayerById(
              w.playerId
            );

          if (!p) {
            return json(
              res,
              404,
              {
                ok: false,
                error:
                  'Player not found'
              }
            );
          }

          try {
            let recipientCode =
              w.recipientCode;

            if (
              !recipientCode
            ) {
              const recipient =
                await paystack(
                  '/transferrecipient',
                  'POST',
                  {
                    type:
                      'nuban',
                    name:
                      w.accountName ||
                      'Customer',
                    account_number:
                      w.accountNumber,
                    bank_code:
                      w.bankCode,
                    currency:
                      'NGN'
                  }
                );

              if (
                !recipient.data ||
                !recipient.data.status
              ) {
                throw new Error(
                  recipient.data &&
                  recipient.data.message
                    ? recipient.data.message
                    : 'Recipient creation failed'
                );
              }

              recipientCode =
                recipient.data
                  .data
                  .recipient_code;

              w.recipientCode =
                recipientCode;
            }

            const transfer =
              await createWithdrawalTransfer(
                {
                  ...w,
                  recipientCode
                }
              );

            if (
              !transfer.data ||
              !transfer.data.status
            ) {
              throw new Error(
                transfer.data &&
                transfer.data.message
                  ? transfer.data.message
                  : 'Transfer failed'
              );
            }

            w.status =
              'processing';

            w.transfer =
              transfer.data.data;

            p.totalWithdrawn =
              Number(
                p.totalWithdrawn ||
                  0
              ) +
              Number(
                w.amount || 0
              );

            addTx({
              id:
                txId('WDAPPROVE'),
              type:
                'withdrawal_approved',
              status:
                'processing',
              playerId:
                String(w.playerId),
              amount:
                Number(w.amount),
              withdrawalId:
                w.id,
              createdAt:
                Date.now()
            });

            save();

            addLog(
              'WITHDRAWAL_APPROVED',
              {
                id:
                  w.id,
                playerId:
                  w.playerId,
                amount:
                  w.amount
              }
            );

            return json(
              res,
              200,
              {
                ok: true,
                withdrawal:
                  w
              }
            );
          } catch (e) {
            // Refund if transfer failed
            p.balance =
              Number(
                p.balance || 0
              ) +
              Number(
                w.amount || 0
              );

            w.status =
              'failed';

            w.error =
              e.message;

            addTx({
              id:
                txId('WDREFUND'),
              type:
                'withdrawal_refund',
              status:
                'success',
              playerId:
                String(
                  w.playerId
                ),
              amount:
                Number(
                  w.amount
                ),
              withdrawalId:
                w.id,
              createdAt:
                Date.now()
            });

            save();

            return json(
              res,
              500,
              {
                ok: false,
                error:
                  e.message,
                refunded:
                  true
              }
            );
          }
        }

        // ---------------------------------------------------------
        // REJECT WITHDRAWAL
        // Supports BOTH names
        // ---------------------------------------------------------

        if (
          act ===
            'reject-withdrawal' ||
          act ===
            'rejectWithdrawal'
        ) {
          const id =
            String(
              body.id ||
              body.withdrawalId ||
              ''
            );

          const w =
            db.withdrawals.find(
              x =>
                String(x.id) ===
                id
            );

          if (!w) {
            return json(
              res,
              404,
              {
                ok: false,
                error:
                  'Withdrawal not found'
              }
            );
          }

          if (
            w.status !==
            'pending'
          ) {
            return json(
              res,
              400,
              {
                ok: false,
                error:
                  'Withdrawal is not pending'
              }
            );
          }

          const p =
            findPlayerById(
              w.playerId
            );

          if (!p) {
            return json(
              res,
              404,
              {
                ok: false,
                error:
                  'Player not found'
              }
            );
          }

          // Return reserved money
          p.balance =
            Number(
              p.balance || 0
            ) +
            Number(
              w.amount || 0
            );

          w.status =
            'rejected';

          w.rejectedAt =
            Date.now();

          addTx({
            id:
              txId('WDREJECT'),
            type:
              'withdrawal_rejected',
            status:
              'success',
            playerId:
              String(
                w.playerId
              ),
            amount:
              Number(
                w.amount
              ),
            withdrawalId:
              w.id,
            createdAt:
              Date.now()
          });

          save();

          addLog(
            'WITHDRAWAL_REJECTED',
            {
              id:
                w.id,
              playerId:
                w.playerId,
              amount:
                w.amount
            }
          );

          return json(
            res,
            200,
            {
              ok: true,
              withdrawal:
                w,
              balance:
                p.balance
            }
          );
        }

        // ---------------------------------------------------------
        // ADMIN RESTORE PLAYER
        // ---------------------------------------------------------

        if (
          act === 'restore'
        ) {
          const id =
            String(
              body.playerId ||
              body.id ||
              ''
            );

          const p =
            findPlayerById(id);

          if (!p) {
            return json(
              res,
              404,
              {
                ok: false,
                error:
                  'Player not found'
              }
            );
          }

          if (
            Number(p.bet) > 0
          ) {
            p.balance =
              Number(
                p.balance || 0
              ) +
              Number(
                p.bet || 0
              );

            p.bet = 0;
            p.at = 0;
            p.bonusBet =
              false;

            save();
          }

          return json(
            res,
            200,
            {
              ok: true,
              player:
                p
            }
          );
        }

        // ---------------------------------------------------------
        // UNKNOWN ADMIN ACTION
        // ---------------------------------------------------------

        return json(
          res,
          404,
          {
            ok: false,
            error:
              'Unknown admin action'
          }
        );
      }

      // ===========================================================
      // PUBLIC HISTORY
      // ===========================================================

      if (
        u.pathname ===
          '/api/history' &&
        req.method === 'GET'
      ) {
        return json(
          res,
          200,
          {
            ok: true,

            history:
              db.history
                .slice(0, 30)
                .map(
                  h => ({
                    id:
                      h.id,

                    crash:
                      h.crash,

                    commit:
                      h.commit,

                    nonce:
                      h.nonce,

                    seed:
                      h.seed,

                    generatedAt:
                      h.generatedAt ||
                      null,

                    generation:
                      h.generation ||
                      'server-cryptographic',

                    algorithm:
                      h.algorithm ||
                      'SHA-256(seed:nonce)'
                  })
                )
          }
        );
      }

      // ===========================================================
      // STATIC INDEX
      // ===========================================================

      const file =
        path.join(
          __dirname,
          'index.html'
        );

      if (
        fs.existsSync(file)
      ) {
        res.writeHead(
          200,
          {
            'Content-Type':
              'text/html; charset=utf-8'
          }
        );

        return res.end(
          fs.readFileSync(
            file
          )
        );
      }

      return json(
        res,
        404,
        {
          ok: false,
          error:
            'Not found'
        }
      );
    }
  );

// ================================================================
// START SERVER
// ================================================================

server.listen(
  PORT,
  () => {
    console.log(
      `Crash Game 222 running on port ${PORT}`
    );

    console.log(
      `Admin: /admin`
    );

    console.log(
      `Live crash API: /admin/api/live-crash`
    );

    startRound();
  }
);
