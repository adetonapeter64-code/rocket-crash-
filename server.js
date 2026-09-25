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
        );

      if (
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

      /*
       * bonusClaimed stays true forever.
       *
       * This prevents claiming it again.
       */

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

      /*
       * IMPORTANT:
       *
       * Never refund bonus into cash.
       */

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

    /*
     * The old system restored players to ₦1,000.
     *
     * That behavior is now removed.
     *
     * This endpoint remains only so old admin/frontend
     * requests do not break.
     */

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


    // REQUIRED EDIT:
    // Use the email submitted by the deposit form.
    // Fall back to the saved player email if the form
    // does not send one. Do not send the old .local
    // placeholder addresses to Paystack.
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

    p.email = email;


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
        payment.data
          .authorization_url,

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
      ).trim();


    if (!reference) {

      return {

        error:
          'Payment reference is required'
      };
    }


    const deposit =
      db.deposits.find(
        x =>
          x.reference ===
          reference
      );


    if (!deposit) {

      return {

        error:
          'Deposit not found'
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


    if (
      deposit.status ===
      'success'
    ) {

      return {

        message:
          'Deposit already credited'
      };
    }


    // ---------------------------------------------
    // CREDIT REAL CASH
    // ---------------------------------------------

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
          p.deposits || 0
        ) +
        Number(
          deposit.amount
        )
      );


    // FIRST SUCCESSFUL DEPOSIT
    p.firstDepositCompleted =
      true;


    db.finance.totalDeposited =
      r2(
        Number(
          db.finance
            .totalDeposited
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

        reference,

        time:
          Date.now()
      }
    );


    save();
    broadcast();


    return {

      message:
        'Deposit successful',

      amount:
        deposit.amount,

      balance:
        p.bal,

      bonusAvailable:
        !p.bonusClaimed
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
        .slice(0, 100);


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
        .slice(0, 100);


    const bankCode =
      String(
        b.bankCode ||
        ''
      )
        .trim()
        .slice(0, 20);


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


    // Reserve real cash immediately.
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
          db.finance
            .pendingWithdrawals
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
// PAYSTACK HTTP REQUEST
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

        let data = '';


        response.on(
          'data',
          chunk => {

            data += chunk;

          }
        );


        response.on(
          'end',
          () => {

            try {

              resolve(
                JSON.parse(
                  data || '{}'
                )
              );

            } catch (e) {

              resolve({

                status:
                  false,

                message:
                  'Invalid payment provider response'
              });

            }

          }
        );

      }
    );


  if (payload)
    req.write(payload);


  req.end();


  return req;
}


function verifyPaystackTransaction(
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
// PAYSTACK TRANSFER RECIPIENT
// --------------------------------------------------

async function createTransferRecipient(
  withdrawal
) {

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
        'NGN',

      metadata: {

        withdrawalId:
          withdrawal.id
      }
    }
  );
}


// --------------------------------------------------
// SEND PAYOUT
// --------------------------------------------------

async function sendPaystackTransfer(
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


  if (
    !withdrawal.recipientCode
  ) {

    const recipient =
      await createTransferRecipient(
        withdrawal
      );


    if (
      !recipient ||
      !recipient.status ||
      !recipient.data
    ) {

      return (
        recipient || {

          status:
            false,

          message:
            'Could not create transfer recipient'
        }
      );
    }


    withdrawal.recipientCode =
      recipient.data
        .recipient_code;
  }


  const reference =
    'CRW_' +
    Date.now() +
    '_' +
    crypto
      .randomBytes(5)
      .toString('hex');


  const transfer =
    await paystackRequest(
      'POST',
      '/transfer',
      {

        source:
          'balance',

        amount:
          String(
            Number(
              withdrawal.amount
            ) * 100
          ),

        recipient:
          withdrawal.recipientCode,

        reason:
          'Crazy Crash Rockets withdrawal',

        reference
      }
    );


  if (
    transfer &&
    transfer.status &&
    transfer.data
  ) {

    withdrawal.transferCode =
      transfer.data.transfer_code ||
      null;

    withdrawal.transferReference =
      transfer.data.reference ||
      reference;

    withdrawal.status =
      'processing';

    withdrawal.processedAt =
      Date.now();

    return transfer;
  }


  return (
    transfer || {

      status:
        false,

      message:
        'Transfer failed'
    }
  );
}


// --------------------------------------------------
// HTTP SERVER
// --------------------------------------------------

const server =
  http.createServer(
    (req, res) => {

      const u =
        new URL(
          req.url,
          'http://x'
        );


      // --------------------------------------------
      // TELEGRAM SSE
      // --------------------------------------------

      if (
        u.pathname ===
        '/events'
      ) {

        const token =
          u.searchParams.get(
            'token'
          );


        const p =
          player(
            token,

            u.searchParams.get(
              'name'
            ),

            tgUser(
              u.searchParams.get(
                'tg'
              )
            )
          );


        if (!p) {

          res.writeHead(
            400
          );

          return res.end();
        }


        res.writeHead(
          200,
          {

            'Content-Type':
              'text/event-stream',

            'Cache-Control':
              'no-cache',

            Connection:
              'keep-alive',

            'X-Accel-Buffering':
              'no'
          }
        );


        const c = {

          res,

          token
        };


        conns.add(c);


        res.on(
          'close',
          () => {

            conns.delete(c);


            const q =
              db.players[
                token
              ];


            if (q)
              q.seen =
                Date.now();

          }
        );


        return send(c);
      }


      // --------------------------------------------
      // PLAYER API
      // --------------------------------------------

      if (
        req.method === 'POST' &&
        u.pathname.startsWith(
          '/api/'
        )
      ) {

        let d = '';


        req.on(
          'data',
          x => {

            d += x;


            if (
              d.length >
              10000
            ) {

              req.destroy();
            }

          }
        );


        return req.on(
          'end',
          async () => {

            let b = {};


            try {

              b =
                JSON.parse(
                  d || '{}'
                );

            } catch (e) {

              b = {};

            }


            const action =
              u.pathname.slice(
                5
              );


            const fn =
              api[action];


            const p =
              okToken(
                b.token
              )

                ? db.players[
                    b.token
                  ]

                : null;


            let result;


            if (
              !fn ||
              !p
            ) {

              result = {

                ok:
                  false,

                error:
                  'Unknown request'
              };

            }


            else {

              try {

                result =
                  await fn(
                    p,
                    b.token,
                    b
                  );


                if (
                  typeof result ===
                  'string'
                ) {

                  result = {

                    ok:
                      false,

                    error:
                      result
                  };

                }

                else if (
                  result &&
                  result.error
                ) {

                  result = {

                    ok:
                      false,

                    error:
                      result.error
                  };

                }

                else {

                  result =
                    Object.assign(
                      {
                        ok:
                          true
                      },

                      result || {}
                    );
                }

              }

              catch (e) {

                console.error(
                  'API ERROR:',
                  action,
                  e
                );


                result = {

                  ok:
                    false,

                  error:
                    'Server error'
                };

              }

            }


            save();
            broadcast();


            res.writeHead(
              200,
              {

                'Content-Type':
                  'application/json'
              }
            );


            res.end(
              JSON.stringify(
                result
              )
            );

          }
        );
      }


      // --------------------------------------------
      // PAYMENT CALLBACK
      // --------------------------------------------

      if (
        req.method === 'GET' &&
        u.pathname ===
        '/payment/callback'
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
                'text/html'
            }
          );


          return res.end(
            '<h2>Payment reference missing</h2>'
          );
        }


        return handlePaymentCallback(
          reference,
          res
        );
      }


      // --------------------------------------------
      // ADMIN PAGE
      // --------------------------------------------

      if (
        u.pathname ===
        '/admin'
      ) {

        return fs.readFile(
          path.join(
            __dirname,
            'admin.html'
          ),

          (e, html) => {

            res.writeHead(
              e
                ? 500
                : 200,

              {

                'Content-Type':
                  'text/html; charset=utf-8'
              }
            );


            res.end(
              e
                ? 'admin.html missing'
                : html
            );

          }
        );
      }


      // --------------------------------------------
      // ADMIN API
      // --------------------------------------------

      if (
        req.method === 'POST' &&
        u.pathname.startsWith(
          '/admin/api/'
        )
      ) {

        let d = '';


        req.on(
          'data',
          x => {

            d += x;


            if (
              d.length >
              20000
            ) {

              req.destroy();
            }

          }
        );


        return req.on(
          'end',
          async () => {

            let b = {};


            try {

              b =
                JSON.parse(
                  d || '{}'
                );

            } catch (e) {

              b = {};

            }


            const out =
              (
                code,
                object
              ) => {

                res.writeHead(
                  code,
                  {

                    'Content-Type':
                      'application/json'
                  }
                );


                res.end(
                  JSON.stringify(
                    object
                  )
                );

              };


            if (
              !adminKeyMatches(
                b.key
              )
            ) {

              return out(
                401,
                {

                  ok:
                    false,

                  error:
                    'Wrong admin key'
                }
              );
            }


            const act =
              u.pathname.slice(
                11
              );


            // ----------------------------------------
            // ADMIN STATE
            // ----------------------------------------

            if (
              act ===
              'state'
            ) {

              const on =
                new Set(
                  [
                    ...conns
                  ].map(
                    c =>
                      c.token
                  )
                );


              const players =
                Object.entries(
                  db.players
                ).map(
                  ([t, p]) => ({

                    id:
                      p.id,

                    name:
                      p.name,

                    tg:
                      p.tg,

                    bal:
                      p.bal,

                    bonusBalance:
                      p.bonusBalance,

                    bonusClaimed:
                      !!p.bonusClaimed,

                    firstDepositCompleted:
                      !!p.firstDepositCompleted,

                    pnl:
                      p.pnl,

                    rounds:
                      p.st.r,

                    wins:
                      p.st.w,

                    best:
                      p.st.best,

                    bet:
                      R.bets[t]

                        ? {

                            amt:
                              R.bets[t]
                                .amt,

                            auto:
                              R.bets[t]
                                .auto,

                            at:
                              R.bets[t]
                                .at,

                            source:
                              R.bets[t]
                                .source ||
                              'cash'
                          }

                        : null,

                    online:
                      on.has(t),

                    first:
                      p.first,

                    seen:
                      p.seen

                  })
                );


              return out(
                200,
                {

                  ok:
                    true,

                  online:
                    on.size,

                  total:
                    players.length,

                  round: {

                    id:
                      R.id,

                    phase:
                      R.phase,

                    bets:
                      Object.keys(
                        R.bets
                      ).length
                  },

                  players

                }
              );
            }


            // ----------------------------------------
            // ADMIN FINANCE SUMMARY
            // ----------------------------------------

            if (
              act ===
              'finance'
            ) {

              const pending =
                db.withdrawals
                  .filter(
                    x =>
                      x.status ===
                        'pending' ||
                      x.status ===
                        'processing'
                  );


              const deposits =
                db.deposits;


              return out(
                200,
                {

                  ok:
                    true,

                  totalDeposited:
                    db.finance
                      .totalDeposited,

                  totalWithdrawn:
                    db.finance
                      .totalWithdrawn,

                  pendingWithdrawals:
                    pending.reduce(
                      (
                        sum,
                        x
                      ) =>
                        sum +
                        Number(
                          x.amount
                        ),
                      0
                    ),

                  depositsCount:
                    deposits.length,

                  withdrawalsCount:
                    db.withdrawals
                      .length,

                  pendingCount:
                    pending.length,

                  balanceLiability:
                    Object.values(
                      db.players
                    ).reduce(
                      (
                        sum,
                        p
                      ) =>
                        sum +
                        Number(
                          p.bal ||
                          0
                        ),
                      0
                    )
                }
              );
            }


            // ----------------------------------------
            // ADMIN DEPOSITS
            // ----------------------------------------

            if (
              act ===
              'deposits'
            ) {

              return out(
                200,
                {

                  ok:
                    true,

                  deposits:
                    db.deposits
                      .slice(
                        0,
                        500
                      )
                }
              );
            }


            // ----------------------------------------
            // ADMIN WITHDRAWALS
            // ----------------------------------------

            if (
              act ===
              'withdrawals'
            ) {

              return out(
                200,
                {

                  ok:
                    true,

                  withdrawals:
                    db.withdrawals
                      .slice(
                        0,
                        500
                      )
                }
              );
            }


            // ----------------------------------------
            // RESTORE PLAYER
            // ----------------------------------------

            if (
              act ===
              'restore'
            ) {

              const p =
                Object.values(
                  db.players
                ).find(
                  x =>
                    x.id ===
                    b.id
                );


              if (!p) {

                return out(
                  404,
                  {

                    ok:
                      false,

                    error:
                      'Player not found'
                  }
                );
              }


              /*
               * No virtual-money restoration.
               */

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    'Restore is disabled because the game no longer creates virtual money'
                }
              );
            }


            // ----------------------------------------
            // APPROVE WITHDRAWAL
            // ----------------------------------------

            if (
              act ===
              'approve-withdrawal'
            ) {

              const withdrawal =
                db.withdrawals.find(
                  x =>
                    x.id ===
                    b.id
                );


              if (!withdrawal) {

                return out(
                  404,
                  {

                    ok:
                      false,

                    error:
                      'Withdrawal not found'
                  }
                );
              }


              if (
                withdrawal.status !==
                'pending'
              ) {

                return out(
                  400,
                  {

                    ok:
                      false,

                    error:
                      'Withdrawal is not pending'
                  }
                );
              }


              if (
                !PAYSTACK_SECRET_KEY
              ) {

                return out(
                  500,
                  {

                    ok:
                      false,

                    error:
                      'PAYSTACK_SECRET_KEY is not configured'
                  }
                );
              }


              const result =
                await sendPaystackTransfer(
                  withdrawal
                );


              // --------------------------------------
              // PAYSTACK FAILED
              // RETURN THE RESERVED MONEY
              // --------------------------------------

              if (
                !result ||
                !result.status
              ) {

                const p =
                  Object.values(
                    db.players
                  ).find(
                    x =>
                      x.id ===
                      withdrawal.playerId
                  );


                if (p) {

                  // Return the reserved withdrawal
                  // amount to the player's wallet.
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
                        'withdrawal_refunded',

                      amount:
                        withdrawal.amount,

                      id:
                        withdrawal.id,

                      reason:
                        String(
                          result &&
                          result.message
                            ? result.message
                            : 'Paystack payout could not be started'
                        ).slice(
                          0,
                          300
                        ),

                      time:
                        Date.now()
                    }
                  );
                }


                withdrawal.status =
                  'failed';


                withdrawal.failure =
                  String(
                    result &&
                    result.message
                      ? result.message
                      : 'Payout could not be started'
                  ).slice(
                    0,
                    300
                  );


                withdrawal.processedAt =
                  Date.now();


                db.finance.pendingWithdrawals =
                  Math.max(
                    0,

                    r2(
                      Number(
                        db.finance
                          .pendingWithdrawals
                      ) -
                      Number(
                        withdrawal.amount
                      )
                    )
                  );


                save();
                broadcast();


                return out(
                  400,
                  {

                    ok:
                      false,

                    error:
                      withdrawal.failure,

                    refunded:
                      true,

                    refundAmount:
                      withdrawal.amount
                  }
                );
              }


              // --------------------------------------
              // PAYSTACK ACCEPTED THE TRANSFER
              // --------------------------------------

              db.finance.pendingWithdrawals =
                Math.max(
                  0,

                  r2(
                    Number(
                      db.finance
                        .pendingWithdrawals
                    ) -
                    Number(
                      withdrawal.amount
                    )
                  )
                );


              save();
              broadcast();


              return out(
                200,
                {

                  ok:
                    true,

                  message:
                    'Withdrawal payout started',

                  withdrawal

                }
              );
            }


            // ----------------------------------------
            // REJECT WITHDRAWAL
            // ----------------------------------------

            if (
              act ===
              'reject-withdrawal'
            ) {

              const withdrawal =
                db.withdrawals.find(
                  x =>
                    x.id ===
                    b.id
                );


              if (!withdrawal) {

                return out(
                  404,
                  {

                    ok:
                      false,

                    error:
                      'Withdrawal not found'
                  }
                );
              }


              if (
                withdrawal.status !==
                'pending'
              ) {

                return out(
                  400,
                  {

                    ok:
                      false,

                    error:
                      'Withdrawal is not pending'
                  }
                );
              }


              const p =
                Object.values(
                  db.players
                ).find(
                  x =>
                    x.id ===
                    withdrawal.playerId
                );


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
                      'withdrawal_rejected',

                    amount:
                      withdrawal.amount,

                    id:
                      withdrawal.id,

                    time:
                      Date.now()
                  }
                );
              }


              withdrawal.status =
                'rejected';


              withdrawal.failure =
                String(
                  b.reason ||
                  'Rejected by admin'
                )
                  .slice(
                    0,
                    300
                  );


              withdrawal.processedAt =
                Date.now();


              db.finance.pendingWithdrawals =
                Math.max(
                  0,

                  r2(
                    Number(
                      db.finance
                        .pendingWithdrawals
                    ) -

                    Number(
                      withdrawal.amount
                    )
                  )
                );


              save();
              broadcast();


              return out(
                200,
                {

                  ok:
                    true,

                  message:
                    'Withdrawal rejected and player balance restored'
                }
              );
            }


            // ----------------------------------------
            // VERIFY PAYSTACK TRANSFER
            // ----------------------------------------

            if (
              act ===
              'verify-transfer'
            ) {

              const withdrawal =
                db.withdrawals.find(
                  x =>
                    x.id ===
                    b.id
                );


              if (!withdrawal) {

                return out(
                  404,
                  {

                    ok:
                      false,

                    error:
                      'Withdrawal not found'
                  }
                );
              }


              if (
                !withdrawal.transferReference
              ) {

                return out(
                  400,
                  {

                    ok:
                      false,

                    error:
                      'No transfer reference'
                  }
                );
              }


              const result =
                await paystackRequest(
                  'GET',
                  '/transfer/verify/' +
                    encodeURIComponent(
                      withdrawal.transferReference
                    )
                );


              if (
                !result ||
                !result.status ||
                !result.data
              ) {

                return out(
                  400,
                  {

                    ok:
                      false,

                    error:
                      result &&
                      result.message

                        ? result.message

                        : 'Could not verify transfer'
                  }
                );
              }


              const status =
                result.data.status;


              if (
                status ===
                  'success' ||
                status ===
                  'successful'
              ) {

                if (
                  withdrawal.status !==
                  'paid'
                ) {

                  withdrawal.status =
                    'paid';

                  withdrawal.processedAt =
                    Date.now();

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
                }
              }


              else if (
                status ===
                  'failed' ||
                status ===
                  'reversed'
              ) {

                const p =
                  Object.values(
                    db.players
                  ).find(
                    x =>
                      x.id ===
                      withdrawal.playerId
                  );


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
                }


                withdrawal.status =
                  'failed';

                withdrawal.failure =
                  status;

                withdrawal.processedAt =
                  Date.now();
              }


              save();
              broadcast();


              return out(
                200,
                {

                  ok:
                    true,

                  status,

                  withdrawal

                }
              );
            }


            // ----------------------------------------
            // MANUAL CREDIT
            // ----------------------------------------

            if (
              act ===
              'credit'
            ) {

              const p =
                Object.values(
                  db.players
                ).find(
                  x =>
                    x.id ===
                    b.id
                );


              const amount =
                Number(
                  b.amount
                );


              if (!p) {

                return out(
                  404,
                  {

                    ok:
                      false,

                    error:
                      'Player not found'
                  }
                );
              }


              if (
                !Number.isFinite(
                  amount
                ) ||
                amount <= 0
              ) {

                return out(
                  400,
                  {

                    ok:
                      false,

                    error:
                      'Invalid amount'
                  }
                );
              }


              p.bal =
                r2(
                  Number(
                    p.bal
                  ) +
                  amount
                );


              addLog(
                p,
                {

                  type:
                    'admin_credit',

                  amount,

                  time:
                    Date.now()
                }
              );


              save();
              broadcast();


              return out(
                200,
                {

                  ok:
                    true,

                  balance:
                    p.bal
                }
              );
            }


            // ----------------------------------------
            // MANUAL DEBIT
            // ----------------------------------------

            if (
              act ===
              'debit'
            ) {

              const p =
                Object.values(
                  db.players
                ).find(
                  x =>
                    x.id ===
                    b.id
                );


              const amount =
                Number(
                  b.amount
                );


              if (!p) {

                return out(
                  404,
                  {

                    ok:
                      false,

                    error:
                      'Player not found'
                  }
                );
              }


              if (
                !Number.isFinite(
                  amount
                ) ||
                amount <= 0
              ) {

                return out(
                  400,
                  {

                    ok:
                      false,

                    error:
                      'Invalid amount'
                  }
                );
              }


              if (
                amount >
                Number(
                  p.bal
                )
              ) {

                return out(
                  400,
                  {

                    ok:
                      false,

                    error:
                      'Player balance is too low'
                  }
                );
              }


              p.bal =
                r2(
                  Number(
                    p.bal
                  ) -
                  amount
                );


              addLog(
                p,
                {

                  type:
                    'admin_debit',

                  amount,

                  time:
                    Date.now()
                }
              );


              save();
              broadcast();


              return out(
                200,
                {

                  ok:
                    true,

                  balance:
                    p.bal
                }
              );
            }


            return out(
              404,
              {

                ok:
                  false,

                error:
                  'Unknown admin request'
              }
            );

          }
        );
      }


      // --------------------------------------------
      // PUBLIC HISTORY
      // --------------------------------------------

      if (
        u.pathname ===
        '/api/history'
      ) {

        res.writeHead(
          200,
          {

            'Content-Type':
              'application/json'
          }
        );


        return res.end(
          JSON.stringify(
            db.history
          )
        );
      }


      // --------------------------------------------
      // FRONTEND
      // --------------------------------------------

      fs.readFile(
        path.join(
          __dirname,
          'index.html'
        ),

        (e, html) => {

          if (e) {

            res.writeHead(
              500
            );

            return res.end(
              'index.html missing'
            );
          }


          res.writeHead(
            200,
            {

              'Content-Type':
                'text/html; charset=utf-8'
            }
          );


          res.end(
            html
          );

        }
      );

    }
  );


// --------------------------------------------------
// PAYMENT CALLBACK HANDLER
// --------------------------------------------------

async function handlePaymentCallback(
  reference,
  res
) {

  try {

    const deposit =
      db.deposits.find(
        x =>
          x.reference ===
          reference
      );


    if (!deposit) {

      res.writeHead(
        404,
        {

          'Content-Type':
            'text/html'
        }
      );


      return res.end(
        '<h2>Deposit not found</h2>'
      );
    }


    if (
      deposit.status ===
      'success'
    ) {

      return paymentPage(
        res,
        true,
        'Payment already credited successfully.'
      );
    }


    const result =
      await verifyPaystackTransaction(
        reference
      );


    if (
      !result ||
      !result.status ||
      !result.data
    ) {

      return paymentPage(
        res,
        false,
        'Payment could not be verified yet. Return to the game and try again.'
      );
    }


    const tx =
      result.data;


    if (
      tx.status !==
      'success'
    ) {

      return paymentPage(
        res,
        false,
        'Payment was not completed.'
      );
    }


    const amount =
      Number(
        tx.amount
      ) / 100;


    if (
      amount !==
      Number(
        deposit.amount
      )
    ) {

      return paymentPage(
        res,
        false,
        'Payment amount does not match the deposit.'
      );
    }


    const p =
      db.players[
        deposit.token
      ];


    if (!p) {

      return paymentPage(
        res,
        false,
        'Player account could not be found.'
      );
    }


    if (
      deposit.status !==
      'success'
    ) {

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
            p.deposits || 0
          ) +
          Number(
            deposit.amount
          )
        );


      // FIRST SUCCESSFUL DEPOSIT
      p.firstDepositCompleted =
        true;


      db.finance.totalDeposited =
        r2(
          Number(
            db.finance
              .totalDeposited
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

          reference,

          time:
            Date.now()
        }
      );


      save();
      broadcast();
    }


    return paymentPage(
      res,
      true,

      '₦' +
        Number(
          deposit.amount
        ).toLocaleString() +

        ' has been added to your game wallet.'
    );

  }

  catch (e) {

    console.error(
      'PAYMENT CALLBACK ERROR:',
      e
    );


    return paymentPage(
      res,
      false,
      'Payment verification error. Return to the game and check your wallet.'
    );
  }
}


// --------------------------------------------------
// PAYMENT PAGE
// --------------------------------------------------

function paymentPage(
  res,
  success,
  message
) {

  res.writeHead(
    200,
    {

      'Content-Type':
        'text/html; charset=utf-8'
    }
  );


  res.end(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Crazy Crash Rockets Payment</title>

<style>

body{
  margin:0;
  min-height:100vh;
  display:flex;
  align-items:center;
  justify-content:center;
  background:#050505;
  color:white;
  font-family:Arial,sans-serif;
  padding:20px;
  box-sizing:border-box;
}

.box{
  max-width:420px;
  width:100%;
  background:#111;
  border:1px solid #333;
  border-radius:18px;
  padding:30px;
  text-align:center;
  box-sizing:border-box;
}

.icon{
  font-size:55px;
  margin-bottom:15px;
}

h2{
  margin:0 0 12px;
}

p{
  color:#ccc;
  line-height:1.5;
}

button{
  border:0;
  border-radius:12px;
  padding:13px 22px;
  font-size:16px;
  font-weight:bold;
  cursor:pointer;
}

</style>

</head>

<body>

<div class="box">

<div class="icon">
${success ? '✅' : '⚠️'}
</div>

<h2>
${success ? 'Payment Successful' : 'Payment Update'}
</h2>

<p>
${escapeHtml(message)}
</p>

<button onclick="window.close();history.back();">
Return
</button>

</div>

</body>
</html>
`);
}


function escapeHtml(
  value
) {

  return String(value)

    .replace(
      /&/g,
      '&amp;'
    )

    .replace(
      /</g,
      '&lt;'
    )

    .replace(
      />/g,
      '&gt;'
    )

    .replace(
      /"/g,
      '&quot;'
    )

    .replace(
      /'/g,
      '&#039;'
    );
}


// --------------------------------------------------
// ADMIN KEY
// --------------------------------------------------

function adminKeyMatches(
  supplied
) {

  if (
    !ADMIN_KEY ||
    !supplied
  ) {

    return false;
  }


  const a =
    crypto
      .createHash('sha256')
      .update(
        String(
          supplied
        )
      )
      .digest();


  const b =
    crypto
      .createHash('sha256')
      .update(
        String(
          ADMIN_KEY
        )
      )
      .digest();


  return crypto.timingSafeEqual(
    a,
    b
  );
}


// --------------------------------------------------
// START SERVER
// --------------------------------------------------

server.listen(
  PORT,
  () => {

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
        'WARNING: PAYSTACK_SECRET_KEY is not configured'
      );

    }


    if (
      APP_URL
    ) {

      console.log(
        'APP_URL: ' +
        APP_URL
      );

    } else {

      console.log(
        'WARNING: APP_URL is not configured'
      );

    }

  }
);


startRound();


console.log(
  'Crash engine started'
);
