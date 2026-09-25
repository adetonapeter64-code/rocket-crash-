// CRAZY CRASH ROCKETS
// Live Crash server + Real Wallet + Paystack Deposits + Withdrawals + Admin Finance
//
// Run:
//   node server.js
//
// Required Render Environment Variables:
//   ADMIN_KEY=your_admin_password
//   BOT_TOKEN=your_telegram_bot_token
//   PAYSTACK_SECRET_KEY=sk_live_xxxxxxxxx
//   APP_URL=https://your-render-service.onrender.com
//
// Optional:
//   DATA_FILE=/var/data/data.json

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const GROWTH = 0.1;
const EDGE = 0.99;
const X = 2 ** 52;

const COUNT_MS = 6000;
const OVER_MS = 3500;

const MIN = 10;
const MAX = 10000;

// NEW PLAYERS START WITH NO CASH
const START = 0;

// WELCOME BONUS
const BONUS = 50;

const MIN_DEPOSIT = 100;
const MIN_WITHDRAW = 100;

const ADMIN_KEY =
  process.env.ADMIN_KEY ||
  '';

const BOT_TOKEN =
  process.env.BOT_TOKEN ||
  '';

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY ||
  '';

const APP_URL =
  process.env.APP_URL ||
  '';

let db = {
  players: {},
  history: [],
  nonce: 0,
  roundId: 0,

  deposits: [],
  withdrawals: [],

  finance: {
    totalDeposited: 0,
    totalWithdrawn: 0,
    pendingWithdrawals: 0
  }
};

try {
  const saved = JSON.parse(
    fs.readFileSync(DATA, 'utf8')
  );

  db = Object.assign(db, saved);

  db.players = db.players || {};
  db.history = db.history || [];
  db.deposits = db.deposits || [];
  db.withdrawals = db.withdrawals || [];

  db.finance = Object.assign({
    totalDeposited: 0,
    totalWithdrawn: 0,
    pendingWithdrawals: 0
  }, db.finance || {});
} catch (e) {
  // New database
}


// --------------------------------------------------
// PLAYER DATA MIGRATION
// --------------------------------------------------

for (const p of Object.values(db.players)) {

  if (p.bet) {
    p.bal = r2(
      Number(p.bal || 0) +
      Number(p.bet || 0)
    );

    p.bet = 0;
  }

  if (!p.log)
    p.log = [];

  if (!p.st) {
    p.st = {
      r: 0,
      w: 0,
      best: 0,
      big: 0
    };
  }

  /*
   * New bonus system fields.
   *
   * IMPORTANT:
   * Existing balances are preserved because the server
   * cannot determine whether an old balance came from
   * real deposits or the previous virtual-money system.
   */

  if (typeof p.bonusClaimed !== 'boolean') {
    p.bonusClaimed = !!p.bonus;
  }

  if (typeof p.firstDepositCompleted !== 'boolean') {
    p.firstDepositCompleted =
      Number(p.deposits || 0) > 0 ||
      Array.isArray(db.deposits) &&
      db.deposits.some(
        d =>
          d.token &&
          d.token === Object.keys(db.players)
            .find(k => db.players[k] === p) &&
          d.status === 'success'
      );
  }

  if (
    typeof p.bonusBalance !== 'number' ||
    !Number.isFinite(p.bonusBalance)
  ) {
    p.bonusBalance = 0;
  }

  if (typeof p.bonusUsed !== 'boolean') {
    p.bonusUsed = false;
  }

  if (typeof p.bonusFinished !== 'boolean') {
    p.bonusFinished =
      !!p.bonusClaimed &&
      !p.bonusBalance;
  }

  if (!p.email)
    p.email = '';

  if (typeof p.deposits !== 'number')
    p.deposits = 0;

  if (typeof p.withdrawals !== 'number')
    p.withdrawals = 0;
}


let dirty = false;

const save = () => {
  dirty = true;
};

setInterval(() => {

  if (!dirty)
    return;

  dirty = false;

  fs.writeFile(
    DATA,
    JSON.stringify(db),
    () => {}
  );

}, 1000);


// --------------------------------------------------
// HELPERS
// --------------------------------------------------

const sha = s =>
  crypto
    .createHash('sha256')
    .update(String(s))
    .digest('hex');

const r2 = n =>
  Math.round(Number(n) * 100) / 100;


// --------------------------------------------------
// CRASH CALCULATION
// --------------------------------------------------

const crashFrom = h => {

  const r =
    parseInt(
      h.slice(0, 13),
      16
    );

  return Math.min(
    1000,
    Math.max(
      1,
      Math.floor(
        100 * EDGE * X / (X - r)
      ) / 100
    )
  );
};


const addLog = (p, l) => {

  if (!p.log)
    p.log = [];

  p.log.unshift(l);

  p.log.length =
    Math.min(
      p.log.length,
      8
    );
};


// --------------------------------------------------
// TELEGRAM MINI APP VERIFICATION
// --------------------------------------------------

function tgUser(initData) {

  if (
    !BOT_TOKEN ||
    !initData
  )
    return null;

  try {

    const q =
      new URLSearchParams(
        initData
      );

    const hash =
      q.get('hash');

    if (!hash)
      return null;

    q.delete('hash');

    const str =
      [...q.entries()]
        .map(
          ([k, v]) =>
            k + '=' + v
        )
        .sort()
        .join('\n');

    const secret =
      crypto
        .createHmac(
          'sha256',
          'WebAppData'
        )
        .update(BOT_TOKEN)
        .digest();

    const check =
      crypto
        .createHmac(
          'sha256',
          secret
        )
        .update(str)
        .digest('hex');

    if (
      check !== hash
    )
      return null;

    const u =
      JSON.parse(
        q.get('user') || 'null'
      );

    return (
      u && {
        id: u.id,
        username:
          u.username || '',
        name: [
          u.first_name,
          u.last_name
        ]
          .filter(Boolean)
          .join(' ')
      }
    );

  } catch (e) {

    return null;

  }
}


// --------------------------------------------------
// GAME ENGINE
// --------------------------------------------------

let R = null;


function startRound() {

  const seed =
    crypto
      .randomBytes(16)
      .toString('hex');

  db.nonce++;
  db.roundId++;

  R = {

    id:
      db.roundId,

    phase:
      'count',

    seed,

    nonce:
      db.nonce,

    commit:
      sha(seed),

    crash:
      crashFrom(
        sha(
          seed +
          ':' +
          db.nonce
        )
      ),

    countEnd:
      Date.now() +
      COUNT_MS,

    flyStart:
      0,

    overEnd:
      0,

    bets:
      {}
  };

  save();
  broadcast();
}


// --------------------------------------------------
// CASHOUT
// --------------------------------------------------

function cash(t, m) {

  const b =
    R.bets[t];

  const p =
    db.players[t];

  if (
    !b ||
    b.at ||
    !p
  )
    return;

  b.at =
    m;


  // -----------------------------------------------
  // BONUS BET
  // -----------------------------------------------

  if (
    b.source === 'bonus'
  ) {

    const stake =
      Number(b.amt);

    const totalWin =
      r2(
        stake *
        Number(m)
      );

    const profit =
      r2(
        totalWin -
        stake
      );

    /*
     * IMPORTANT:
     *
     * The original ₦50 bonus is NOT withdrawable.
     *
     * Only the profit enters normal balance.
     */

    if (profit > 0) {

      p.bal =
        r2(
          Number(p.bal) +
          profit
        );

    }

    p.bonusBalance = 0;
    p.bonusUsed = true;
    p.bonusFinished = true;

    p.bet = 0;

    p.pnl =
      r2(
        Number(p.pnl) +
        profit
      );

    p.st.r++;
    p.st.w++;

    p.st.best =
      Math.max(
        p.st.best,
        Number(m)
      );

    p.st.big =
      Math.max(
        p.st.big,
        profit
      );

    addLog(
      p,
      {
        type:
          'bonus_win',

        crash:
          null,

        amt:
          stake,

        at:
          m,

        totalWin,

        profit,

        time:
          Date.now()
      }
    );

    save();
    broadcast();

    return;
  }


  // -----------------------------------------------
  // NORMAL CASH BET
  // -----------------------------------------------

  const win =
    r2(
      Number(b.amt) *
      Number(m)
    );

  p.bal =
    r2(
      Number(p.bal) +
      win
    );

  p.pnl =
    r2(
      Number(p.pnl) +
      win -
      Number(b.amt)
    );

  p.bet = 0;

  p.st.r++;
  p.st.w++;

  p.st.best =
    Math.max(
      p.st.best,
      Number(m)
    );

  p.st.big =
    Math.max(
      p.st.big,
      r2(
        win -
        Number(b.amt)
      )
    );

  addLog(
    p,
    {
      crash: null,

      amt:
        b.amt,

      at:
        m,

      profit:
        r2(
          win -
          Number(b.amt)
        )
    }
  );

  save();
  broadcast();
}


// --------------------------------------------------
// END ROUND
// --------------------------------------------------

function endRound() {

  R.phase =
    'over';

  R.overEnd =
    Date.now() +
    OVER_MS;


  for (
    const [t, b]
    of Object.entries(
      R.bets
    )
  ) {

    const p =
      db.players[t];

    if (
      !p ||
      b.at
    )
      continue;


    // ---------------------------------------------
    // BONUS LOSS
    // ---------------------------------------------

    if (
      b.source === 'bonus'
    ) {

      p.bet = 0;

      p.bonusBalance = 0;

      p.bonusUsed = true;

      p.bonusFinished = true;

      p.st.r++;

      /*
       * No money is deducted from p.bal.
       *
       * The ₦50 bonus was separate.
       */

      p.pnl =
        r2(
          Number(p.pnl) -
          Number(b.amt)
        );

      addLog(
        p,
        {
          type:
            'bonus_loss',

          crash:
            R.crash,

          amt:
            b.amt,

          at:
            0,

          profit:
            -Number(b.amt),

          time:
            Date.now()
        }
      );

      continue;
    }


    // ---------------------------------------------
    // NORMAL CASH LOSS
    // ---------------------------------------------

    p.bet = 0;

    p.st.r++;

    p.pnl =
      r2(
        Number(p.pnl) -
        Number(b.amt)
      );

    addLog(
      p,
      {
        crash:
          R.crash,

        amt:
          b.amt,

        at:
          0,

        profit:
          -Number(b.amt)
      }
    );
  }


  db.history.unshift({
    id:
      R.id,

    crash:
      R.crash,

    seed:
      R.seed,

    nonce:
      R.nonce,

    commit:
      R.commit
  });

  db.history.length =
    Math.min(
      db.history.length,
      30
    );

  save();
  broadcast();
}


// --------------------------------------------------
// GAME LOOP
// --------------------------------------------------

setInterval(() => {

  if (!R)
    return;

  const nowTime =
    Date.now();


  if (
    R.phase === 'count' &&
    nowTime >= R.countEnd
  ) {

    R.phase =
      'fly';

    R.flyStart =
      R.countEnd;

    broadcast();
  }


  if (
    R.phase === 'fly'
  ) {

    const m =
      Math.exp(
        GROWTH *
        (
          nowTime -
          R.flyStart
        ) /
        1000
      );


    for (
      const [t, b]
      of Object.entries(
        R.bets
      )
    ) {

      if (
        !b.at &&
        b.auto &&
        b.auto < R.crash &&
        m >= b.auto
      ) {

        cash(
          t,
          b.auto
        );
      }
    }


    if (
      m >= R.crash
    ) {

      endRound();

    }
  }


  else if (
    R.phase === 'over' &&
    nowTime >= R.overEnd
  ) {

    startRound();

  }

}, 50);


// --------------------------------------------------
// CONNECTIONS / SSE
// --------------------------------------------------

const conns =
  new Set();


function snap(token) {

  const p =
    db.players[token];

  const b =
    R.bets[token];

  const over =
    R.phase === 'over';


  const bonusAvailable =
    !!(
      p &&
      p.firstDepositCompleted &&
      !p.bonusClaimed &&
      !p.bonusFinished
    );


  return {

    now:
      Date.now(),

    round: {

      id:
        R.id,

      phase:
        R.phase,

      commit:
        R.commit,

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
          h =>
            h.crash
        ),


    me:

      p && {

        name:
          p.name,

        // Normal withdrawable balance
        bal:
          p.bal,

        pnl:
          p.pnl,

        st:
          p.st,

        log:
          p.log,


        // -----------------------------------------
        // BONUS INFORMATION
        // -----------------------------------------

        bonus:
          !!p.bonusClaimed,

        bonusBalance:
          r2(
            Number(
              p.bonusBalance || 0
            )
          ),

        bonusClaimed:
          !!p.bonusClaimed,

        bonusUsed:
          !!p.bonusUsed,

        bonusFinished:
          !!p.bonusFinished,

        firstDepositCompleted:
          !!p.firstDepositCompleted,

        bonusAvailable,


        bet:

          b
            ? {

                amt:
                  b.amt,

                auto:
                  b.auto,

                at:
                  b.at,

                source:
                  b.source ||
                  'cash'
              }

            : null
      }
  };
}


const send =
  c =>
    c.res.write(
      'data:' +
      JSON.stringify(
        snap(c.token)
      ) +
      '\n\n'
    );


function broadcast() {

  for (
    const c
    of conns
  ) {

    try {

      send(c);

    } catch (e) {}

  }
}


setInterval(
  () => {

    for (
      const c
      of conns
    ) {

      try {

        c.res.write(
          ':\n\n'
        );

      } catch (e) {}

    }

  },
  15000
);


setInterval(
  broadcast,
  10000
);


// --------------------------------------------------
// PLAYER
// --------------------------------------------------

const okToken =
  t =>
    typeof t === 'string' &&
    /^[a-f0-9]{16,64}$/.test(t);


function player(
  token,
  name,
  tg
) {

  if (
    !okToken(token)
  )
    return null;


  let p =
    db.players[token];


  if (!p) {

    if (
      Object.keys(
        db.players
      ).length > 5000
    ) {

      return null;
    }


    p =
      db.players[token] = {

        id:
          '',

        name:
          'Player',


        // REAL CASH BALANCE
        bal:
          START,


        pnl:
          0,


        st: {

          r:
            0,

          w:
            0,

          best:
            0,

          big:
            0
        },


        log:
          [],


        bet:
          0,


        // OLD FIELD KEPT FOR COMPATIBILITY
        bonus:
          false,


        // NEW BONUS SYSTEM
        bonusClaimed:
          false,

        bonusBalance:
          0,

        bonusUsed:
          false,

        bonusFinished:
          false,

        firstDepositCompleted:
          false,


        first:
          Date.now(),

        seen:
          Date.now(),

        tg:
          null,

        email:
          '',

        deposits:
          0,

        withdrawals:
          0
      };
  }


  // -----------------------------------------------
  // SAFETY MIGRATION
  // -----------------------------------------------

  if (
    typeof p.bonusClaimed !==
    'boolean'
  ) {

    p.bonusClaimed =
      !!p.bonus;
  }


  if (
    typeof p.bonusBalance !==
    'number'
  ) {

    p.bonusBalance =
      0;
  }


  if (
    typeof p.bonusUsed !==
    'boolean'
  ) {

    p.bonusUsed =
      false;
  }


  if (
    typeof p.bonusFinished !==
    'boolean'
  ) {

    p.bonusFinished =
      false;
  }


  if (
    typeof p.firstDepositCompleted !==
    'boolean'
  ) {

    p.firstDepositCompleted =
      Number(
        p.deposits || 0
      ) > 0;
  }


  if (!p.id)
    p.id =
      sha(token)
        .slice(0, 8);


  if (!p.first)
    p.first =
      Date.now();


  if (!p.seen)
    p.seen =
      Date.now();


  p.seen =
    Date.now();


  if (tg)
    p.tg =
      tg;


  if (name) {

    p.name =
      String(name)
        .replace(
          /[<>&"']/g,
          ''
        )
        .trim()
        .slice(0, 20)
      ||
      'Player';
  }


  save();

  return p;
}


const now =
  () =>
    Math.exp(
      GROWTH *
      (
        Date.now() -
        R.flyStart
      ) /
      1000
    );


// --------------------------------------------------
// GAME API
// --------------------------------------------------

const api = {


  // -----------------------------------------------
  // NORMAL / BONUS BET
  // -----------------------------------------------

  bet(p, t, b) {

    const requestedSource =
      String(
        b.source ||
        ''
      )
        .toLowerCase()
        .trim();


    const isBonus =
      requestedSource ===
      'bonus';


    let amt;


    if (isBonus) {

      /*
       * BONUS RULE:
       *
       * Exactly ₦50.
       *
       * No ₦10.
       * No ₦20.
       * No ₦100.
       * No splitting.
       * No combining with cash.
       */

      amt =
        Number(
          b.amt
        );      if (
        amt !== BONUS
      ) {

        return (
          'Bonus stake must be exactly ₦' +
          BONUS
        );
      }


      if (
        !p.firstDepositCompleted
      ) {

        return (
          'Make your first successful deposit before claiming the bonus'
        );
      }


      if (
        p.bonusClaimed &&
        !p.bonusBalance
      ) {

        return 'Bonus has already been used';
      }


      if (
        p.bonusFinished
      ) {

        return 'Bonus has already been used';
      }


      if (
        Number(
          p.bonusBalance
        ) !== BONUS
      ) {

        return 'Bonus balance is not available';
      }

    }


    else {

      amt =
        Math.floor(
          Number(
            b.amt
          )
        );


      if (
        !(amt >= MIN &&
          amt <= MAX)
      ) {

        return (
          'Bet must be between ' +
          MIN +
          ' and ' +
          MAX
        );
      }


      if (
        amt >
        Number(
          p.bal
        )
      ) {

        return 'Not enough balance';
      }
    }


    const auto =
      Number(
        b.auto
      ) >= 1.01

        ? r2(
            Number(
              b.auto
            )
          )

        : 0;


    if (
      R.phase !==
      'count'
    ) {

      return (
        'Betting is closed for this round'
      );
    }


    if (
      R.bets[t]
    ) {

      return (
        'You already have a bet in this round'
      );
    }


    // ---------------------------------------------
    // BONUS BET
    // ---------------------------------------------

    if (isBonus) {

      p.bonusBalance =
        0;

      p.bonusUsed =
        true;

      p.bonusClaimed =
        true;


      p.bet =
        BONUS;


      R.bets[t] = {

        amt:
          BONUS,

        auto,

        at:
          0,

        source:
          'bonus'
      };

    }


    // ---------------------------------------------
    // NORMAL CASH BET
    // ---------------------------------------------

    else {

      p.bal =
        r2(
          Number(
            p.bal
          ) -
          amt
        );


      p.bet =
        amt;


      R.bets[t] = {

        amt,

        auto,

        at:
          0,

        source:
          'cash'
      };
    }


    save();
    broadcast();
  },


  // -----------------------------------------------
  // CANCEL BET
  // -----------------------------------------------

  cancel(p, t) {

    const b =
      R.bets[t];


    if (
      R.phase !==
        'count' ||
      !b
    ) {

      return 'Nothing to cancel';
    }


    // ---------------------------------------------
    // BONUS CANCEL
    // ---------------------------------------------

    if (
      b.source ===
      'bonus'
    ) {

      p.bonusBalance =
        BONUS;

      p.bonusUsed =
        false;

      p.bonusFinished =
        false;

      p.bonusClaimed =
        true;

      p.bet =
        0;

      delete R.bets[t];

      save();
      broadcast();

      return;
    }


    // ---------------------------------------------
    // NORMAL CASH CANCEL
    // ---------------------------------------------

    p.bal =
      r2(
        Number(
          p.bal
        ) +
        Number(
          b.amt
        )
      );

    p.bet =
      0;

    delete R.bets[t];

    save();
    broadcast();
  },


  // -----------------------------------------------
  // CASHOUT
  // -----------------------------------------------

  cashout(p, t) {

    const b =
      R.bets[t];


    if (
      R.phase !==
        'fly' ||
      !b ||
      b.at
    ) {

      return 'Nothing to cash out';
    }


    const m =
      Math.floor(
        now() * 100
      ) / 100;


    if (
      m >= R.crash
    ) {

      return (
        'Too late, it crashed'
      );
    }


    cash(
      t,
      m
    );
  },


  // -----------------------------------------------
  // RESTORE
  // -----------------------------------------------

  restore(p, t) {

    return (
      'Restore is disabled because the game no longer creates virtual money'
    );
  },


  // -----------------------------------------------
  // CLAIM ₦50 BONUS
  // -----------------------------------------------

  bonus(p) {

    if (
      !p.firstDepositCompleted
    ) {

      return (
        'Make your first successful deposit before claiming the ₦' +
        BONUS +
        ' bonus'
      );
    }


    if (
      p.bonusClaimed
    ) {

      return 'Bonus already claimed';
    }


    if (
      p.bonusFinished
    ) {

      return 'Bonus has already been used';
    }


    p.bonusClaimed =
      true;

    p.bonusBalance =
      BONUS;

    p.bonusUsed =
      false;

    p.bonusFinished =
      false;


    addLog(
      p,
      {
        type:
          'bonus_claimed',

        amount:
          BONUS,

        time:
          Date.now()
      }
    );


    save();
    broadcast();


    return {

      message:
        '₦' +
        BONUS +
        ' bonus claimed',

      bonusBalance:
        p.bonusBalance
    };
  },


  // ------------------------------------------------
  // DEPOSIT
  // ------------------------------------------------

  async deposit(p, t, b) {

    const amount =
      Math.floor(
        Number(
          b.amount
        )
      );


    if (
      amount <
      MIN_DEPOSIT
    ) {

      return {

        error:
          'Minimum deposit is ₦' +
          MIN_DEPOSIT
      };
    }


    if (
      !PAYSTACK_SECRET_KEY
    ) {

      return {

        error:
          'Payment service is not configured'
      };
    }


    if (!APP_URL) {

      return {

        error:
          'APP_URL is not configured'
      };
    }


    const reference =
      'CRD_' +
      Date.now() +
      '_' +
      crypto
        .randomBytes(5)
        .toString('hex');


    const email =
      String(
        b.email ||
        p.email ||
        ''
      )
        .trim();


    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ) {

      return {

        error:
          'Enter a valid email address'
      };
    }


    p.email =
      email;


    const payment =
      await paystackRequest(
        'POST',
        '/transaction/initialize',
        {

          email,

          amount:
            String(
              amount * 100
            ),

          currency:
            'NGN',

          reference,

          callback_url:
            APP_URL.replace(
              /\/$/,
              ''
            ) +
            '/payment/callback',

          metadata:
            JSON.stringify({

              type:
                'crash_deposit',

              playerId:
                p.id,

              token:
                t,

              amount
            })
        }
      );


    if (
      !payment ||
      !payment.status ||
      !payment.data
    ) {

      return {

        error:
          payment &&
          payment.message

            ? payment.message

            : 'Unable to start payment'
      };
    }


    db.deposits.unshift({

      id:
        reference,

      reference,

      playerId:
        p.id,

      token:
        t,

      amount,

      amountKobo:
        amount * 100,

      status:
        'pending',

      createdAt:
        Date.now(),

      verifiedAt:
        null
    });


    db.deposits.length =
      Math.min(
        db.deposits.length,
        5000
      );


    save();


    return {

      url:
        payment.data.authorization_url,

      reference
    };
  },


  // ------------------------------------------------
  // VERIFY DEPOSIT
  // ------------------------------------------------

  async depositVerify(
    p,
    t,
    b
  ) {

    const reference =
      String(
        b.reference ||
        ''
      )
        .trim();


    if (!reference) {

      return {
        error:
          'Payment reference is required'
      };
    }


    /*
     * IMPORTANT DEPOSIT FIX:
     *
     * Do NOT immediately return "Deposit not found"
     * when the local database does not contain the
     * reference.
     *
     * Paystack is the payment source of truth.
     *
     * We first verify the transaction with Paystack,
     * then recover the missing local deposit record
     * from Paystack metadata.
     */

    let deposit =
      db.deposits.find(
        x =>
          x.reference ===
          reference
      );


    const verified =
      await verifyPaystackTransaction(
        reference
      );


    if (
      !verified ||
      !verified.status ||
      !verified.data
    ) {

      return {

        error:
          verified &&
          verified.message

            ? verified.message

            : 'Payment verification failed'
      };
    }


    const tx =
      verified.data;


    if (
      tx.status !==
      'success'
    ) {

      return {
        error:
          'Payment has not been completed'
      };
    }


    /*
     * If Render's local data did not contain the
     * deposit record, recover it from the verified
     * Paystack transaction metadata.
     */

    if (!deposit) {

      deposit =
        recoverDepositFromPaystack(
          reference,
          tx
        );
    }


    if (!deposit) {

      return {
        error:
          'Deposit could not be matched to this player'
      };
    }


    if (
      deposit.token !==
      t
    ) {

      return {
        error:
          'Deposit does not belong to this player'
      };
    }


    if (
      deposit.status ===
      'success'
    ) {

      return {
        message:
          'Deposit already credited'
      };
    }


    const paid =
      Number(
        tx.amount
      ) / 100;


    if (
      paid !==
      Number(
        deposit.amount
      )
    ) {

      return {
        error:
          'Payment amount does not match'
      };
    }


    const credited =
      creditDeposit(
        deposit,
        tx
      );


    if (
      credited.alreadyCredited
    ) {

      return {
        message:
          'Deposit already credited'
      };
    }


    if (
      credited.error
    ) {

      return {
        error:
          credited.error
      };
    }


    return {

      message:
        'Deposit successful',

      amount:
        deposit.amount,

      balance:
        credited.player.bal,

      bonusAvailable:
        !credited.player.bonusClaimed
    };
  },


  // ------------------------------------------------
  // WITHDRAWAL
  // ------------------------------------------------

  async withdraw(
    p,
    t,
    b
  ) {

    const amount =
      Math.floor(
        Number(
          b.amount
        )
      );


    const accountName =
      String(
        b.accountName ||
        ''
      )
        .trim()
        .slice(
          0,
          100
        );


    const accountNumber =
      String(
        b.accountNumber ||
        ''
      )
        .trim()
        .replace(
          /\D/g,
          ''
        );


    const bankName =
      String(
        b.bankName ||
        ''
      )
        .trim()
        .slice(
          0,
          100
        );


    const bankCode =
      String(
        b.bankCode ||
        ''
      )
        .trim()
        .slice(
          0,
          20
        );


    if (
      amount <
      MIN_WITHDRAW
    ) {

      return {

        error:
          'Minimum withdrawal is ₦' +
          MIN_WITHDRAW
      };
    }


    if (
      amount >
      Number(
        p.bal
      )
    ) {

      return {
        error:
          'Insufficient wallet balance'
      };
    }


    if (
      !accountName ||
      !accountNumber ||
      !bankName
    ) {

      return {

        error:
          'Enter account name, account number and bank name'
      };
    }


    if (
      accountNumber.length <
      8
    ) {

      return {
        error:
          'Enter a valid account number'
      };
    }


    const existing =
      db.withdrawals.find(
        x =>
          x.token === t &&
          (
            x.status ===
              'pending' ||
            x.status ===
              'processing'
          )
      );


    if (existing) {

      return {

        error:
          'You already have a withdrawal being processed'
      };
    }


    const id =
      'WD_' +
      Date.now() +
      '_' +
      crypto
        .randomBytes(5)
        .toString('hex');


    p.bal =
      r2(
        Number(
          p.bal
        ) -
        amount
      );


    const withdrawal = {

      id,

      playerId:
        p.id,

      token:
        t,

      amount,

      status:
        'pending',

      accountName,

      accountNumber,

      bankName,

      bankCode,

      recipientCode:
        null,

      transferCode:
        null,

      transferReference:
        null,

      failure:
        null,

      createdAt:
        Date.now(),

      processedAt:
        null
    };


    db.withdrawals.unshift(
      withdrawal
    );


    db.withdrawals.length =
      Math.min(
        db.withdrawals.length,
        5000
      );


    db.finance.pendingWithdrawals =
      r2(
        Number(
          db.finance.pendingWithdrawals
        ) +
        amount
      );


    p.withdrawals =
      r2(
        Number(
          p.withdrawals || 0
        ) +
        amount
      );


    addLog(
      p,
      {

        type:
          'withdrawal',

        amount,

        id,

        status:
          'pending',

        time:
          Date.now()
      }
    );


    save();
    broadcast();


    return {

      message:
        'Withdrawal request submitted successfully',

      id
    };
  }
};


// --------------------------------------------------
// PAYSTACK REQUEST
// --------------------------------------------------

function paystackRequest(
  method,
  endpoint,
  body
) {

  return new Promise(
    resolve => {

      if (
        !PAYSTACK_SECRET_KEY
      ) {

        return resolve({

          status:
            false,

          message:
            'PAYSTACK_SECRET_KEY is missing'
        });
      }


      const payload =
        body
          ? JSON.stringify(body)
          : '';


      const options = {

        hostname:
          'api.paystack.co',

        path:
          endpoint,

        method,

        headers: {

          Authorization:
            'Bearer ' +
            PAYSTACK_SECRET_KEY,

          'Content-Type':
            'application/json',

          'Content-Length':
            Buffer.byteLength(
              payload
            )
        }
      };


      const request =
        httpsRequest(
          options,
          payload,
          resolve
        );


      request.on(
        'error',
        err =>
          resolve({

            status:
              false,

            message:
              err.message
          })
      );
    }
  );
}


// --------------------------------------------------
// HTTPS REQUEST
// --------------------------------------------------

function httpsRequest(
  options,
  payload,
  resolve
) {

  const https =
    require('https');


  const req =
    https.request(
      options,
      response => {

        let data =
          '';


        response.on(
          'data',
          chunk => {

            data +=
              chunk;
          }
        );


        response.on(
          'end',
          () => {

            try {

              resolve(
                JSON.parse(
                  data ||
                  '{}'
                )
              );

            } catch (e) {

              resolve({

                status:
                  false,

                message:
                  'Invalid response from Paystack'
              });
            }
          }
        );
      }
    );


  req.on(
    'error',
    err => {

      resolve({

        status:
          false,

        message:
          err.message
      });
    }
  );


  if (payload)
    req.write(payload);


  req.end();


  return req;
}


// --------------------------------------------------
// VERIFY PAYSTACK TRANSACTION
// --------------------------------------------------

async function verifyPaystackTransaction(
  reference
) {

  return paystackRequest(
    'GET',
    '/transaction/verify/' +
      encodeURIComponent(
        reference
      )
  );
}


// --------------------------------------------------
// CREDIT VERIFIED DEPOSIT
// --------------------------------------------------

function creditDeposit(
  deposit,
  tx
) {

  if (!deposit) {

    return {
      error:
        'Deposit not found'
    };
  }


  if (
    deposit.status ===
    'success'
  ) {

    return {

      alreadyCredited:
        true,

      player:
        db.players[
          deposit.token
        ] || null
    };
  }


  const p =
    db.players[
      deposit.token
    ];


  if (!p) {

    return {

      error:
        'Player account could not be found'
    };
  }


  const paid =
    Number(
      tx.amount
    ) / 100;


  if (
    paid !==
    Number(
      deposit.amount
    )
  ) {

    return {

      error:
        'Payment amount does not match'
    };
  }


  deposit.status =
    'success';


  deposit.verifiedAt =
    Date.now();


  deposit.paystackId =
    tx.id;


  p.bal =
    r2(
      Number(
        p.bal
      ) +
      Number(
        deposit.amount
      )
    );


  p.deposits =
    r2(
      Number(
        p.deposits ||
        0
      ) +
      Number(
        deposit.amount
      )
    );


  p.firstDepositCompleted =
    true;


  db.finance.totalDeposited =
    r2(
      Number(
        db.finance.totalDeposited
      ) +
      Number(
        deposit.amount
      )
    );


  addLog(
    p,
    {

      type:
        'deposit',

      amount:
        deposit.amount,

      reference:
        deposit.reference,

      time:
        Date.now()
    }
  );


  save();
  broadcast();


  return {

    alreadyCredited:
      false,

    player:
      p
  };
        }// --------------------------------------------------
// PAYSTACK DEPOSIT RECOVERY
// --------------------------------------------------

function parsePaystackMetadata(tx) {

  let meta =
    tx &&
    tx.metadata;


  if (!meta)
    return null;


  if (
    typeof meta ===
    'string'
  ) {

    try {

      meta =
        JSON.parse(
          meta
        );

    } catch (e) {

      return null;
    }
  }


  return (
    meta &&
    typeof meta ===
      'object'

      ? meta
      : null
  );
}


function recoverDepositFromPaystack(
  reference,
  tx
) {

  if (
    !reference ||
    !tx
  )
    return null;


  // First try the normal local record.
  let deposit =
    db.deposits.find(
      x =>
        x.reference ===
        reference
    );


  if (deposit)
    return deposit;


  /*
   * The local pending deposit can be missing after
   * a Render restart/deploy or when the persistent
   * data file was not available.
   *
   * Only recover when the transaction itself and its
   * metadata match the original deposit request.
   */

  if (
    String(
      tx.reference || ''
    ) !== reference
  ) {

    return null;
  }


  const meta =
    parsePaystackMetadata(
      tx
    );


  if (
    !meta ||
    meta.type !==
      'crash_deposit'
  ) {

    return null;
  }


  const token =
    String(
      meta.token ||
      ''
    ).trim();


  if (
    !okToken(token)
  ) {

    return null;
  }


  const p =
    db.players[token];


  if (!p)
    return null;


  /*
   * Ensure the player ID from Paystack metadata
   * belongs to the same player identified by token.
   */

  if (
    meta.playerId &&
    String(
      meta.playerId
    ) !==
      String(
        p.id
      )
  ) {

    return null;
  }


  const paid =
    Number(
      tx.amount
    ) / 100;


  const metaAmount =
    Number(
      meta.amount
    );


  if (
    !Number.isFinite(
      paid
    ) ||
    !Number.isFinite(
      metaAmount
    ) ||
    paid !==
      metaAmount
  ) {

    return null;
  }


  /*
   * Re-create only the missing local deposit record.
   *
   * The wallet is NOT credited here.
   *
   * creditDeposit() remains the single place that
   * actually credits the player's wallet.
   */

  deposit = {

    id:
      reference,

    reference,

    playerId:
      p.id,

    token,

    amount:
      metaAmount,

    amountKobo:
      Math.round(
        metaAmount * 100
      ),

    status:
      'pending',

    createdAt:

      tx.created_at &&
      Date.parse(
        tx.created_at
      )

        ? Date.parse(
            tx.created_at
          )

        : Date.now(),

    verifiedAt:
      null,

    recovered:
      true
  };


  db.deposits.unshift(
    deposit
  );


  db.deposits.length =
    Math.min(
      db.deposits.length,
      5000
    );


  save();


  return deposit;
}


// --------------------------------------------------
// PAYSTACK RECIPIENT / WITHDRAWAL HELPERS
// --------------------------------------------------

async function createPaystackRecipient(
  withdrawal
) {

  if (
    !PAYSTACK_SECRET_KEY
  ) {

    return {

      status:
        false,

      message:
        'PAYSTACK_SECRET_KEY is missing'
    };
  }


  return paystackRequest(
    'POST',
    '/transferrecipient',
    {

      type:
        'nuban',

      name:
        withdrawal.accountName,

      account_number:
        withdrawal.accountNumber,

      bank_code:
        withdrawal.bankCode,

      currency:
        'NGN'
    }
  );
}


async function initiatePaystackTransfer(
  withdrawal,
  recipientCode
) {

  return paystackRequest(
    'POST',
    '/transfer',
    {

      source:
        'balance',

      amount:
        Math.round(
          Number(
            withdrawal.amount
          ) * 100
        ),

      recipient:
        recipientCode,

      reason:
        'Crazy Crash Rockets withdrawal',

      reference:
        withdrawal.id
    }
  );
}


// --------------------------------------------------
// PROCESS WITHDRAWAL
// --------------------------------------------------

async function processWithdrawal(
  withdrawal
) {

  if (!withdrawal)
    return;


  if (
    withdrawal.status !==
    'pending'
  ) {

    return;
  }


  if (
    !PAYSTACK_SECRET_KEY
  ) {

    withdrawal.failure =
      'PAYSTACK_SECRET_KEY is missing';

    save();

    return;
  }


  withdrawal.status =
    'processing';

  save();


  try {

    let recipientCode =
      withdrawal.recipientCode;


    /*
     * Create recipient only when one has not already
     * been created for this withdrawal.
     */

    if (!recipientCode) {

      const recipient =
        await createPaystackRecipient(
          withdrawal
        );


      if (
        !recipient ||
        !recipient.status ||
        !recipient.data
      ) {

        withdrawal.status =
          'failed';

        withdrawal.failure =
          recipient &&
          recipient.message

            ? recipient.message

            : 'Unable to create Paystack recipient';


        const p =
          db.players[
            withdrawal.token
          ];


        if (p) {

          p.bal =
            r2(
              Number(
                p.bal
              ) +
              Number(
                withdrawal.amount
              )
            );


          addLog(
            p,
            {

              type:
                'withdrawal_failed',

              amount:
                withdrawal.amount,

              id:
                withdrawal.id,

              status:
                'failed',

              time:
                Date.now()
            }
          );
        }


        db.finance.pendingWithdrawals =
          r2(
            Math.max(
              0,
              Number(
                db.finance.pendingWithdrawals
              ) -
              Number(
                withdrawal.amount
              )
            )
          );


        withdrawal.processedAt =
          Date.now();


        save();
        broadcast();

        return;
      }


      recipientCode =
        recipient.data.recipient_code;


      withdrawal.recipientCode =
        recipientCode;

      save();
    }


    const transfer =
      await initiatePaystackTransfer(
        withdrawal,
        recipientCode
      );


    if (
      !transfer ||
      !transfer.status ||
      !transfer.data
    ) {

      withdrawal.status =
        'failed';

      withdrawal.failure =
        transfer &&
        transfer.message

          ? transfer.message

          : 'Unable to initiate Paystack transfer';


      const p =
        db.players[
          withdrawal.token
        ];


      if (p) {

        p.bal =
          r2(
            Number(
              p.bal
            ) +
            Number(
              withdrawal.amount
            )
          );


        addLog(
          p,
          {

            type:
              'withdrawal_failed',

            amount:
              withdrawal.amount,

            id:
              withdrawal.id,

            status:
              'failed',

            time:
              Date.now()
          }
        );
      }


      db.finance.pendingWithdrawals =
        r2(
          Math.max(
            0,
            Number(
              db.finance.pendingWithdrawals
            ) -
            Number(
              withdrawal.amount
            )
          )
        );


      withdrawal.processedAt =
        Date.now();


      save();
      broadcast();

      return;
    }


    withdrawal.status =
      'processing';


    withdrawal.transferCode =
      transfer.data.transfer_code ||
      null;


    withdrawal.transferReference =
      transfer.data.reference ||
      withdrawal.id;


    withdrawal.processedAt =
      Date.now();


    save();
    broadcast();

  } catch (e) {

    withdrawal.status =
      'failed';

    withdrawal.failure =
      e.message ||
      'Withdrawal processing failed';


    const p =
      db.players[
        withdrawal.token
      ];


    if (p) {

      p.bal =
        r2(
          Number(
            p.bal
          ) +
          Number(
            withdrawal.amount
          )
        );


      addLog(
        p,
        {

          type:
            'withdrawal_failed',

          amount:
            withdrawal.amount,

          id:
            withdrawal.id,

          status:
            'failed',

          time:
            Date.now()
        }
      );
    }


    db.finance.pendingWithdrawals =
      r2(
        Math.max(
          0,
          Number(
            db.finance.pendingWithdrawals
          ) -
          Number(
            withdrawal.amount
          )
        )
      );


    withdrawal.processedAt =
      Date.now();


    save();
    broadcast();
  }
}


// --------------------------------------------------
// ADMIN HELPERS
// --------------------------------------------------

function adminAuthorized(req) {

  const key =
    String(
      req.headers[
        'x-admin-key'
      ] ||
      ''
    );


  return (
    !!ADMIN_KEY &&
    key === ADMIN_KEY
  );
}


function jsonResponse(
  res,
  status,
  data
) {

  const body =
    JSON.stringify(
      data
    );


  res.writeHead(
    status,
    {

      'Content-Type':
        'application/json; charset=utf-8',

      'Content-Length':
        Buffer.byteLength(
          body
        ),

      'Cache-Control':
        'no-store'
    }
  );


  res.end(
    body
  );
}


function htmlResponse(
  res,
  status,
  html
) {

  res.writeHead(
    status,
    {

      'Content-Type':
        'text/html; charset=utf-8',

      'Cache-Control':
        'no-store'
    }
  );


  res.end(
    html
  );
}


function readBody(req) {

  return new Promise(
    resolve => {

      let data =
        '';


      req.on(
        'data',
        chunk => {

          data +=
            chunk;


          if (
            data.length >
            2 * 1024 * 1024
          ) {

            req.destroy();

            resolve(
              null
            );
          }
        }
      );


      req.on(
        'end',
        () => {

          if (!data) {

            return resolve(
              {}
            );
          }


          try {

            resolve(
              JSON.parse(
                data
              )
            );

          } catch (e) {

            resolve(
              null
            );
          }
        }
      );


      req.on(
        'error',
        () => {

          resolve(
            null
          );
        }
      );
    }
  );
}


// --------------------------------------------------
// PAYSTACK WEBHOOK SIGNATURE
// --------------------------------------------------

function verifyPaystackSignature(
  req,
  rawBody
) {

  if (
    !PAYSTACK_SECRET_KEY
  ) {

    return false;
  }


  const signature =
    String(
      req.headers[
        'x-paystack-signature'
      ] ||
      ''
    );


  if (!signature)
    return false;


  const expected =
    crypto
      .createHmac(
        'sha512',
        PAYSTACK_SECRET_KEY
      )
      .update(
        rawBody
      )
      .digest('hex');


  try {

    return crypto.timingSafeEqual(
      Buffer.from(
        signature
      ),
      Buffer.from(
        expected
      )
    );

  } catch (e) {

    return false;
  }
}


// --------------------------------------------------
// PROCESS SUCCESSFUL PAYSTACK DEPOSIT
// --------------------------------------------------

async function processPaystackDeposit(
  tx,
  reference
) {

  if (!tx)
    return {
      ok:
        false,
      message:
        'Missing transaction data'
    };


  const ref =
    String(
      reference ||
      tx.reference ||
      ''
    ).trim();


  if (!ref) {

    return {

      ok:
        false,

      message:
        'Payment reference is missing'
    };
  }


  /*
   * Always verify with Paystack before crediting.
   */

  const verified =
    await verifyPaystackTransaction(
      ref
    );


  if (
    !verified ||
    !verified.status ||
    !verified.data
  ) {

    return {

      ok:
        false,

      message:
        verified &&
        verified.message

          ? verified.message

          : 'Payment verification failed'
    };
  }


  const verifiedTx =
    verified.data;


  if (
    verifiedTx.status !==
    'success'
  ) {

    return {

      ok:
        false,

      message:
        'Payment has not been completed'
    };
  }


  /*
   * Try the normal local record first.
   * If it is missing, recover it from Paystack metadata.
   */

  let deposit =
    db.deposits.find(
      x =>
        x.reference ===
        ref
    );


  if (!deposit) {

    deposit =
      recoverDepositFromPaystack(
        ref,
        verifiedTx
      );
  }


  if (!deposit) {

    return {

      ok:
        false,

      message:
        'Deposit could not be matched to a player'
    };
  }


  const paid =
    Number(
      verifiedTx.amount
    ) / 100;


  if (
    paid !==
    Number(
      deposit.amount
    )
  ) {

    return {

      ok:
        false,

      message:
        'Payment amount does not match'
    };
  }


  const credited =
    creditDeposit(
      deposit,
      verifiedTx
    );


  if (
    credited.error
  ) {

    return {

      ok:
        false,

      message:
        credited.error
    };
  }


  return {

    ok:
      true,

    alreadyCredited:
      !!credited.alreadyCredited,

    amount:
      deposit.amount,

    reference:
      ref,

    player:
      credited.player
  };
}


// --------------------------------------------------
// WEBHOOK RAW BODY READER
// --------------------------------------------------

function readRawBody(req) {

  return new Promise(
    resolve => {

      let raw =
        '';


      req.on(
        'data',
        chunk => {

          raw +=
            chunk;
        }
      );


      req.on(
        'end',
        () => {

          resolve(
            raw
          );
        }
      );


      req.on(
        'error',
        () => {

          resolve(
            ''
          );
        }
      );
    }
  );
    }// --------------------------------------------------
// HTTP SERVER
// --------------------------------------------------

const server =
  http.createServer(
    async (req, res) => {

      const url =
        new URL(
          req.url,
          'http://' +
            (
              req.headers.host ||
              'localhost'
            )
        );


      const pathname =
        url.pathname;


      // --------------------------------------------
      // CORS
      // --------------------------------------------

      res.setHeader(
        'Access-Control-Allow-Origin',
        '*'
      );

      res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, X-Admin-Key'
      );

      res.setHeader(
        'Access-Control-Allow-Methods',
        'GET, POST, OPTIONS'
      );


      if (
        req.method ===
        'OPTIONS'
      ) {

        res.writeHead(
          204
        );

        return res.end();
      }


      // --------------------------------------------
      // HEALTH CHECK
      // --------------------------------------------

      if (
        pathname ===
        '/health'
      ) {

        return jsonResponse(
          res,
          200,
          {
            ok:
              true,

            service:
              'Crazy Crash Rockets'
          }
        );
      }


      // --------------------------------------------
      // PAYSTACK WEBHOOK
      // --------------------------------------------

      if (
        pathname ===
          '/webhook/paystack' &&
        req.method ===
          'POST'
      ) {

        const rawBody =
          await readRawBody(
            req
          );


        /*
         * Paystack signs the exact raw request body.
         */

        if (
          !verifyPaystackSignature(
            req,
            rawBody
          )
        ) {

          return jsonResponse(
            res,
            401,
            {
              status:
                false,

              message:
                'Invalid Paystack signature'
            }
          );
        }


        let event;

        try {

          event =
            JSON.parse(
              rawBody
            );

        } catch (e) {

          return jsonResponse(
            res,
            400,
            {
              status:
                false,

              message:
                'Invalid webhook payload'
            }
          );
        }


        /*
         * We only need charge.success for deposits.
         *
         * Returning HTTP 200 tells Paystack that the
         * webhook was received.
         */

        if (
          event &&
          event.event ===
            'charge.success'
        ) {

          const tx =
            event.data || {};


          const reference =
            String(
              tx.reference ||
              ''
            ).trim();


          /*
           * Verify again with Paystack before wallet
           * credit. This prevents an unverified webhook
           * from directly creating wallet money.
           */

          try {

            if (reference) {

              await processPaystackDeposit(
                tx,
                reference
              );
            }

          } catch (e) {

            /*
             * Do not make the webhook endpoint crash.
             * Paystack can retry the event if necessary.
             */

            console.error(
              'Paystack webhook deposit error:',
              e.message
            );
          }
        }


        return jsonResponse(
          res,
          200,
          {
            status:
              true
          }
        );
      }


      // --------------------------------------------
      // PAYMENT CALLBACK
      // --------------------------------------------

      if (
        pathname ===
          '/payment/callback' &&
        req.method ===
          'GET'
      ) {

        return handlePaymentCallback(
          req,
          res,
          url
        );
      }


      // --------------------------------------------
      // ADMIN PANEL
      // --------------------------------------------

      if (
        pathname ===
          '/admin' &&
        req.method ===
          'GET'
      ) {

        if (
          !ADMIN_KEY
        ) {

          return htmlResponse(
            res,
            503,
            '<h1>Admin is not configured</h1>'
          );
        }


        return htmlResponse(
          res,
          200,
          ADMIN_HTML
        );
      }


      // --------------------------------------------
      // ADMIN DATA
      // --------------------------------------------

      if (
        pathname ===
          '/api/admin' &&
        req.method ===
          'GET'
      ) {

        if (
          !adminAuthorized(
            req
          )
        ) {

          return jsonResponse(
            res,
            401,
            {
              error:
                'Unauthorized'
            }
          );
        }


        return jsonResponse(
          res,
          200,
          {
            players:
              db.players,

            deposits:
              db.deposits,

            withdrawals:
              db.withdrawals,

            finance:
              db.finance,

            history:
              db.history
          }
        );
      }


      // --------------------------------------------
      // ADMIN WITHDRAWAL PROCESSING
      // --------------------------------------------

      if (
        pathname ===
          '/api/admin/withdraw' &&
        req.method ===
          'POST'
      ) {

        if (
          !adminAuthorized(
            req
          )
        ) {

          return jsonResponse(
            res,
            401,
            {
              error:
                'Unauthorized'
            }
          );
        }


        const body =
          await readBody(
            req
          );


        if (!body) {

          return jsonResponse(
            res,
            400,
            {
              error:
                'Invalid request body'
            }
          );
        }


        const id =
          String(
            body.id ||
            ''
          ).trim();


        const withdrawal =
          db.withdrawals.find(
            x =>
              x.id ===
              id
          );


        if (!withdrawal) {

          return jsonResponse(
            res,
            404,
            {
              error:
                'Withdrawal not found'
            }
          );
        }


        await processWithdrawal(
          withdrawal
        );


        return jsonResponse(
          res,
          200,
          {
            message:
              'Withdrawal processing started',

            withdrawal
          }
        );
      }


      // --------------------------------------------
      // ADMIN WITHDRAWAL STATUS UPDATE
      // --------------------------------------------

      if (
        pathname ===
          '/api/admin/withdrawal-status' &&
        req.method ===
          'POST'
      ) {

        if (
          !adminAuthorized(
            req
          )
        ) {

          return jsonResponse(
            res,
            401,
            {
              error:
                'Unauthorized'
            }
          );
        }


        const body =
          await readBody(
            req
          );


        if (!body) {

          return jsonResponse(
            res,
            400,
            {
              error:
                'Invalid request body'
            }
          );
        }


        const id =
          String(
            body.id ||
            ''
          ).trim();


        const status =
          String(
            body.status ||
            ''
          ).trim();


        const withdrawal =
          db.withdrawals.find(
            x =>
              x.id ===
              id
          );


        if (!withdrawal) {

          return jsonResponse(
            res,
            404,
            {
              error:
                'Withdrawal not found'
            }
          );
        }


        const allowed = [
          'pending',
          'processing',
          'success',
          'failed'
        ];


        if (
          !allowed.includes(
            status
          )
        ) {

          return jsonResponse(
            res,
            400,
            {
              error:
                'Invalid withdrawal status'
            }
          );
        }


        const previous =
          withdrawal.status;


        /*
         * If admin marks a failed withdrawal,
         * return the held money to the player once.
         */

        if (
          status ===
            'failed' &&
          previous !==
            'failed' &&
          previous !==
            'success'
        ) {

          const p =
            db.players[
              withdrawal.token
            ];


          if (p) {

            p.bal =
              r2(
                Number(
                  p.bal
                ) +
                Number(
                  withdrawal.amount
                )
              );


            addLog(
              p,
              {

                type:
                  'withdrawal_failed',

                amount:
                  withdrawal.amount,

                id:
                  withdrawal.id,

                status:
                  'failed',

                time:
                  Date.now()
              }
            );
          }


          db.finance.pendingWithdrawals =
            r2(
              Math.max(
                0,
                Number(
                  db.finance
                    .pendingWithdrawals
                ) -
                Number(
                  withdrawal.amount
                )
              )
            );
        }


        if (
          status ===
            'success' &&
          previous !==
            'success'
        ) {

          db.finance.totalWithdrawn =
            r2(
              Number(
                db.finance
                  .totalWithdrawn
              ) +
              Number(
                withdrawal.amount
              )
            );


          db.finance.pendingWithdrawals =
            r2(
              Math.max(
                0,
                Number(
                  db.finance
                    .pendingWithdrawals
                ) -
                Number(
                  withdrawal.amount
                )
              )
            );
        }


        withdrawal.status =
          status;


        withdrawal.processedAt =
          Date.now();


        save();
        broadcast();


        return jsonResponse(
          res,
          200,
          {
            message:
              'Withdrawal status updated',

            withdrawal
          }
        );
      }


      // --------------------------------------------
      // PLAYER API
      // --------------------------------------------

      if (
        pathname ===
          '/api' &&
        req.method ===
          'POST'
      ) {

        const body =
          await readBody(
            req
          );


        if (!body) {

          return jsonResponse(
            res,
            400,
            {
              error:
                'Invalid request body'
            }
          );
        }


        const token =
          String(
            body.token ||
            ''
          ).trim();


        if (
          !okToken(
            token
          )
        ) {

          return jsonResponse(
            res,
            400,
            {
              error:
                'Invalid player token'
            }
          );
        }


        const tg =
          tgUser(
            body.initData
          );


        const p =
          player(
            token,
            body.name,
            tg
          );


        if (!p) {

          return jsonResponse(
            res,
            400,
            {
              error:
                'Unable to create player'
            }
          );
        }


        const action =
          String(
            body.action ||
            ''
          ).trim();


        try {

          let result;


          switch (
            action
          ) {

            case 'bet':

              result =
                api.bet(
                  p,
                  token,
                  body
                );

              break;


            case 'cancel':

              result =
                api.cancel(
                  p,
                  token
                );

              break;


            case 'cashout':

              result =
                api.cashout(
                  p,
                  token
                );

              break;


            case 'restore':

              result =
                api.restore(
                  p,
                  token
                );

              break;


            case 'bonus':

              result =
                api.bonus(
                  p
                );

              break;


            case 'deposit':

              result =
                await api.deposit(
                  p,
                  token,
                  body
                );

              break;


            case 'deposit_verify':

              result =
                await api.depositVerify(
                  p,
                  token,
                  body
                );

              break;


            case 'withdraw':

              result =
                await api.withdraw(
                  p,
                  token,
                  body
                );

              break;


            case 'state':

              result =
                snap(
                  token
                );

              break;


            default:

              result =
                {
                  error:
                    'Unknown action'
                };
          }


          return jsonResponse(
            res,
            200,
            result
          );

        } catch (e) {

          console.error(
            'API error:',
            e
          );


          return jsonResponse(
            res,
            500,
            {
              error:
                e.message ||
                'Server error'
            }
          );
        }
      }


      // --------------------------------------------
      // PLAYER SSE
      // --------------------------------------------

      if (
        pathname ===
          '/events' &&
        req.method ===
          'GET'
      ) {

        const token =
          String(
            url.searchParams.get(
              'token'
            ) ||
            ''
          ).trim();


        if (
          !okToken(
            token
          )
        ) {

          return jsonResponse(
            res,
            400,
            {
              error:
                'Invalid player token'
            }
          );
        }


        player(
          token,
          '',
          null
        );


        res.writeHead(
          200,
          {

            'Content-Type':
              'text/event-stream; charset=utf-8',

            'Cache-Control':
              'no-cache',

            Connection:
              'keep-alive',

            'Access-Control-Allow-Origin':
              '*'
          }
        );


        const connection = {

          res,

          token
        };


        conns.add(
          connection
        );


        try {

          send(
            connection
          );

        } catch (e) {}


        req.on(
          'close',
          () => {

            conns.delete(
              connection
            );
          }
        );


        return;
      }


      // --------------------------------------------
      // ROOT
      // --------------------------------------------

      if (
        pathname ===
          '/' &&
        req.method ===
          'GET'
      ) {

        return htmlResponse(
          res,
          200,
          GAME_HTML
        );
      }


      // --------------------------------------------
      // NOT FOUND
      // --------------------------------------------

      return jsonResponse(
        res,
        404,
        {
          error:
            'Not found'
        }
      );
    }
  );


// --------------------------------------------------
// PAYMENT CALLBACK HANDLER
// --------------------------------------------------

async function handlePaymentCallback(
  req,
  res,
  url
) {

  const reference =
    String(
      url.searchParams.get(
        'reference'
      ) ||
      url.searchParams.get(
        'trxref'
      ) ||
      ''
    ).trim();


  if (!reference) {

    return htmlResponse(
      res,
      400,
      paymentResultHtml(
        false,
        'Payment reference is missing'
      )
    );
  }


  /*
   * IMPORTANT DEPOSIT FIX:
   *
   * The old callback looked only inside db.deposits
   * and immediately returned "Deposit not found".
   *
   * That fails when Render has lost the local pending
   * record while Paystack still has the successful
   * transaction.
   *
   * We now verify the transaction with Paystack first
   * and recover the missing local record from metadata.
   */

  try {

    const verified =
      await verifyPaystackTransaction(
        reference
      );


    if (
      !verified ||
      !verified.status ||
      !verified.data
    ) {

      return htmlResponse(
        res,
        400,
        paymentResultHtml(
          false,
          verified &&
          verified.message

            ? verified.message

            : 'Payment verification failed'
        )
      );
    }


    const tx =
      verified.data;


    if (
      tx.status !==
      'success'
    ) {

      return htmlResponse(
        res,
        400,
        paymentResultHtml(
          false,
          'Payment has not been completed'
        )
      );
    }


    let deposit =
      db.deposits.find(
        x =>
          x.reference ===
          reference
      );


    /*
     * Recover the missing local deposit record
     * when Paystack metadata matches the transaction.
     */

    if (!deposit) {

      deposit =
        recoverDepositFromPaystack(
          reference,
          tx
        );
    }


    if (!deposit) {

      return htmlResponse(
        res,
        404,
        paymentResultHtml(
          false,
          'Deposit could not be matched to this player'
        )
      );
    }


    const paid =
      Number(
        tx.amount
      ) / 100;


    if (
      paid !==
      Number(
        deposit.amount
      )
    ) {

      return htmlResponse(
        res,
        400,
        paymentResultHtml(
          false,
          'Payment amount does not match'
        )
      );
    }


    const credited =
      creditDeposit(
        deposit,
        tx
      );


    if (
      credited.error
    ) {

      return htmlResponse(
        res,
        400,
        paymentResultHtml(
          false,
          credited.error
        )
      );
    }


    return htmlResponse(
      res,
      200,
      paymentResultHtml(
        true,
        credited.alreadyCredited

          ? 'Deposit already credited'

          : 'Deposit successful'
      )
    );

  } catch (e) {

    console.error(
      'Payment callback error:',
      e
    );


    return htmlResponse(
      res,
      500,
      paymentResultHtml(
        false,
        'Unable to verify payment'
      )
    );
  }
}


// --------------------------------------------------
// PAYMENT RESULT PAGE
// --------------------------------------------------

function paymentResultHtml(
  success,
  message
) {

  const title =
    success
      ? 'Deposit Successful'
      : 'Deposit Problem';


  const color =
    success
      ? '#16a34a'
      : '#dc2626';


  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#080b12;
  color:#fff;
  font-family:Arial,sans-serif;
}
.box{
  width:90%;
  max-width:420px;
  padding:30px;
  box-sizing:border-box;
  border-radius:18px;
  background:#111827;
  text-align:center;
  box-shadow:0 10px 40px rgba(0,0,0,.35);
}
h1{
  margin:0 0 15px;
  color:${color};
}
p{
  color:#d1d5db;
  line-height:1.6;
}
</style>
</head>
<body>
<div class="box">
<h1>${title}</h1>
<p>${String(message)
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')}</p>
<p>You can return to the game.</p>
</div>
</body>
</html>
`;
}


// --------------------------------------------------
// START GAME ENGINE
// --------------------------------------------------

startRound();


// --------------------------------------------------
// SERVER START
// --------------------------------------------------

server.listen(
  PORT,
  () => {

    console.log(
      'Crash engine started'
    );

    console.log(
      'Crazy Crash Rockets running on port ' +
      PORT
    );

    console.log(
      'Admin panel: /admin'
    );


    if (
      ADMIN_KEY
    ) {

      console.log(
        'ADMIN_KEY loaded'
      );

    } else {

      console.log(
        'WARNING: ADMIN_KEY is not configured'
      );
    }


    if (
      PAYSTACK_SECRET_KEY
    ) {

      console.log(
        'Paystack payment system: configured'
      );

    } else {

      console.log(
        'WARNING: Paystack payment system is not configured'
      );
    }


    console.log(
      'APP_URL: ' +
      APP_URL
    );
  }
);


// --------------------------------------------------
// GAME HTML
// --------------------------------------------------

const GAME_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">
<title>Crazy Crash Rockets</title>
</head>
<body>
<div id="app"></div>
<script>
document.getElementById('app').innerHTML =
  '<h2>Crazy Crash Rockets</h2>' +
  '<p>Game server is running.</p>';
</script>
</body>
</html>
`;


// --------------------------------------------------
// ADMIN HTML
// --------------------------------------------------

const ADMIN_HTML = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport"
      content="width=device-width,initial-scale=1">
<title>Crazy Crash Rockets Admin</title>
<style>
body{
  margin:0;
  padding:20px;
  background:#080b12;
  color:#fff;
  font-family:Arial,sans-serif;
}
h1{
  margin-top:0;
}
button{
  padding:10px 15px;
  border:0;
  border-radius:8px;
  cursor:pointer;
}
pre{
  white-space:pre-wrap;
  word-break:break-word;
  background:#111827;
  padding:15px;
  border-radius:12px;
}
</style>
</head>
<body>
<h1>Crazy Crash Rockets Admin</h1>
<p>Admin finance data.</p>
<pre id="out">Loading...</pre>

<script>
const key =
  prompt('Enter ADMIN_KEY');

fetch('/api/admin',{
  headers:{
    'X-Admin-Key':key || ''
  }
})
.then(r => r.json())
.then(data => {
  document.getElementById('out').textContent =
    JSON.stringify(data,null,2);
})
.catch(err => {
  document.getElementById('out').textContent =
    String(err);
});
</script>
</body>
</html>
`;
