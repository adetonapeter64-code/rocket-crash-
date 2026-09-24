// Live Crash server: one shared game for every player.
// Added:
// - Paystack deposits
// - Wallet transaction ledger
// - Withdrawals
// - Bank list
// - Paystack transfer recipients
// - Admin payout-funding ledger
// - Admin payout processing
// - Transfer verification
//
// Run: node server.js

const http = require('http'),
  fs = require('fs'),
  path = require('path'),
  crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');

const GROWTH = 0.1,
  EDGE = 0.99,
  X = 2 ** 52,
  COUNT_MS = 6000,
  OVER_MS = 3500,
  MIN = 10,
  MAX = 10000,
  START = 1000,
  BONUS = 500;

/*
=========================================================
PAYMENT SETTINGS
=========================================================
*/

const PAYSTACK_SECRET_KEY =
  process.env.PAYSTACK_SECRET_KEY || '';

const PAYSTACK_URL =
  'https://api.paystack.co';

const WITHDRAW_MIN =
  Number(process.env.WITHDRAW_MIN || 3700);

const WITHDRAW_MAX =
  Number(process.env.WITHDRAW_MAX || 1000000000);


/*
=========================================================
DATABASE
=========================================================
*/

let db = {
  players: {},
  history: [],
  nonce: 0,
  roundId: 0,

  /* ADMIN CRASH TARGET CONTROL */
  customTargets: [],
  customTargetIndex: 0,

  /*
  =======================================================
  FINANCIAL SYSTEM
  =======================================================
  */

  /*
    payoutFundKobo is an ADMIN LEDGER.

    It can be greater than ₦10,000,000.
    We store kobo as an integer.
  */

  payoutFundKobo: 0,

  financialTransactions: [],

  deposits: {},

  withdrawals: {},

  nextFinancialId: 1
};


try {
  db = Object.assign(
    db,
    JSON.parse(
      fs.readFileSync(DATA, 'utf8')
    )
  );
} catch (e) {}


/*
=========================================================
DATABASE MIGRATION
=========================================================
*/

if (!Array.isArray(db.customTargets))
  db.customTargets = [];

if (!Number.isInteger(db.customTargetIndex))
  db.customTargetIndex = 0;

if (!Number.isSafeInteger(db.payoutFundKobo))
  db.payoutFundKobo = 0;

if (!Array.isArray(db.financialTransactions))
  db.financialTransactions = [];

if (!db.deposits || typeof db.deposits !== 'object')
  db.deposits = {};

if (!db.withdrawals || typeof db.withdrawals !== 'object')
  db.withdrawals = {};

if (!Number.isInteger(db.nextFinancialId))
  db.nextFinancialId = 1;


/*
=========================================================
OLD PLAYER MIGRATION
=========================================================
*/

for (const p of Object.values(db.players)) {

  if (p.bet) {

    p.bal += p.bet;

    p.bet = 0;

  }

  if (!p.st) {

    p.st = {
      r: 0,
      w: 0,
      best: 0,
      big: 0
    };

  }

  if (!Array.isArray(p.log))
    p.log = [];

  if (typeof p.bonus !== 'boolean')
    p.bonus = false;

  if (!p.email)
    p.email = '';

  if (!Array.isArray(p.transactions))
    p.transactions = [];

  if (!Array.isArray(p.deposits))
    p.deposits = [];

  if (!Array.isArray(p.withdrawals))
    p.withdrawals = [];

  if (!p.bank)
    p.bank = null;

}


/*
=========================================================
SAVE SYSTEM
=========================================================
*/

let dirty = false;

const save = () => {
  dirty = true;
};


setInterval(() => {

  if (dirty) {

    dirty = false;

    fs.writeFile(
      DATA,
      JSON.stringify(db),
      () => {}
    );

  }

}, 1000);


/*
=========================================================
ADMIN KEY
=========================================================
*/

const ADMIN_KEY =
  process.env.ADMIN_KEY ||
  db.adminKey ||
  (
    db.adminKey =
      crypto.randomBytes(9).toString('hex')
  );

save();


/*
=========================================================
TELEGRAM
=========================================================
*/

const BOT_TOKEN =
  process.env.BOT_TOKEN || '';


/*
=========================================================
HELPERS
=========================================================
*/

const sha = s =>
  crypto
    .createHash('sha256')
    .update(s)
    .digest('hex');


const r2 = n =>
  Math.round(n * 100) / 100;


const nairaToKobo = amount => {

  const n = Number(amount);

  if (!Number.isFinite(n))
    return 0;

  const k =
    Math.round(n * 100);

  if (!Number.isSafeInteger(k))
    return 0;

  return k;

};


const koboToNaira = kobo =>
  r2(
    Number(kobo || 0) / 100
  );


const money = amount =>
  koboToNaira(
    nairaToKobo(amount)
  );


const makeReference = prefix =>
  (
    prefix +
    '_' +
    Date.now() +
    '_' +
    crypto
      .randomBytes(6)
      .toString('hex')
  )
  .toLowerCase()
  .replace(
    /[^a-z0-9_-]/g,
    ''
  );


const financialId = () =>
  db.nextFinancialId++;


/*
=========================================================
FINANCIAL TRANSACTION LEDGER
=========================================================
*/

function addFinancialTransaction(data) {

  const tx = {

    id:
      financialId(),

    reference:
      data.reference ||
      makeReference('tx'),

    userId:
      data.userId || null,

    type:
      data.type || 'OTHER',

    amount:
      r2(
        Number(data.amount || 0)
      ),

    direction:
      data.direction || 'NONE',

    status:
      data.status || 'PENDING',

    description:
      data.description || '',

    provider:
      data.provider || '',

    providerReference:
      data.providerReference || '',

    createdAt:
      Date.now(),

    updatedAt:
      Date.now()

  };


  db.financialTransactions.unshift(tx);


  /*
    Keep history from growing forever.
  */

  db.financialTransactions =
    db.financialTransactions.slice(
      0,
      5000
    );


  save();

  return tx;
}


/*
=========================================================
PLAYER WALLET LEDGER
=========================================================
*/

function addPlayerTransaction(
  p,
  type,
  amount,
  description,
  reference,
  status
) {

  if (!Array.isArray(p.transactions))
    p.transactions = [];


  const tx = {

    reference:
      reference ||
      makeReference('wallet'),

    type,

    amount:
      r2(
        Number(amount || 0)
      ),

    description:
      description || '',

    status:
      status || 'SUCCESS',

    createdAt:
      Date.now()

  };


  p.transactions.unshift(tx);


  p.transactions =
    p.transactions.slice(
      0,
      100
    );


  save();

  return tx;
}


/*
=========================================================
PAYSTACK REQUEST
=========================================================
*/

function paystackRequest(
  method,
  endpoint,
  body
) {

  return new Promise(
    (resolve, reject) => {

      if (!PAYSTACK_SECRET_KEY) {

        return reject(
          new Error(
            'PAYSTACK_SECRET_KEY is missing'
          )
        );

      }


      const payload =
        body
          ? JSON.stringify(body)
          : '';


      const url =
        new URL(
          PAYSTACK_URL +
          endpoint
        );


      const req =
        httpsRequest(
          {
            hostname:
              url.hostname,

            port:
              443,

            path:
              url.pathname +
              url.search,

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

          }
        );


      let raw = '';


      req.on(
        'data',
        chunk => {

          raw += chunk;

        }
      );


      req.on(
        'end',
        () => {

          let json = null;


          try {

            json =
              JSON.parse(
                raw || '{}'
              );

          } catch (e) {

            return reject(
              new Error(
                'Invalid Paystack response'
              )
            );

          }


          if (
            !json.status
          ) {

            return reject(
              new Error(
                json.message ||
                'Paystack request failed'
              )
            );

          }


          resolve(json);

        }
      );


      req.on(
        'error',
        reject
      );


      req.end(payload);

    }
  );

}


/*
Node https is used so this server
still has no npm dependency requirement.
*/

const httpsRequest =
  require('https').request;


/*
=========================================================
CRASH CALCULATION
=========================================================
*/

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
        100 *
        EDGE *
        X /
        (X - r)
      ) / 100
    )
  );

};


/*
=========================================================
ADMIN CRASH TARGET CONTROL
=========================================================
*/

function nextCrashTarget(
  seed,
  nonce
) {

  const list =
    Array.isArray(db.customTargets)
      ? db.customTargets
      : [];


  if (!list.length) {

    return crashFrom(
      sha(seed + ':' + nonce)
    );

  }


  const i =
    Number.isInteger(
      db.customTargetIndex
    )
      ? db.customTargetIndex
      : 0;


  const target =
    Number(
      list[
        i % list.length
      ]
    );


  db.customTargetIndex =
    i + 1;


  save();


  if (!Number.isFinite(target)) {

    return crashFrom(
      sha(seed + ':' + nonce)
    );

  }


  return Math.min(
    1000,
    Math.max(
      1.01,
      r2(target)
    )
  );

}


/*
=========================================================
PLAYER LOG
=========================================================
*/

const addLog = (
  p,
  l
) => {

  p.log.unshift(l);

  p.log.length =
    Math.min(
      p.log.length,
      8
    );

};


/*
=========================================================
TELEGRAM USER VERIFICATION
=========================================================
*/

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


    q.delete('hash');


    const str =
      [
        ...q.entries()
      ]
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


    if (
      crypto
        .createHmac(
          'sha256',
          secret
        )
        .update(str)
        .digest('hex')
      !== hash
    ) {

      return null;

    }


    const u =
      JSON.parse(
        q.get('user') ||
        'null'
      );


    return u && {

      id:
        u.id,

      username:
        u.username || '',

      name:
        [
          u.first_name,
          u.last_name
        ]
        .filter(Boolean)
        .join(' ')

    };


  } catch (e) {

    return null;

  }

}


/*
=========================================================
GAME ROUND
=========================================================
*/

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
      nextCrashTarget(
        seed,
        db.nonce
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


/*
=========================================================
CASH OUT
=========================================================
*/

function cash(
  t,
  m
) {

  const b =
    R.bets[t];

  const p =
    db.players[t];


  if (
    !b ||
    b.at ||
    !p
  ) {

    return;

  }


  b.at =
    m;


  const win =
    r2(
      b.amt * m
    );


  p.bal =
    r2(
      p.bal + win
    );


  p.pnl =
    r2(
      p.pnl +
      win -
      b.amt
    );


  p.bet =
    0;


  p.st.r++;

  p.st.w++;


  p.st.best =
    Math.max(
      p.st.best,
      m
    );


  p.st.big =
    Math.max(
      p.st.big,
      r2(
        win -
        b.amt
      )
    );


  addLog(
    p,
    {

      crash:
        null,

      amt:
        b.amt,

      at:
        m,

      profit:
        r2(
          win -
          b.amt
        )

    }
  );


  /*
    Record game win in financial ledger.
  */

  addPlayerTransaction(
    p,
    'GAME_WIN',
    r2(win - b.amt),
    'Crash game winnings',
    makeReference('gamewin'),
    'SUCCESS'
  );


  addFinancialTransaction({

    userId:
      p.id,

    type:
      'GAME_WIN',

    amount:
      r2(win - b.amt),

    direction:
      'CREDIT',

    status:
      'SUCCESS',

    description:
      'Crash game winnings',

    provider:
      'GAME'

  });


  save();

  broadcast();

}


/*
=========================================================
END ROUND
=========================================================
*/

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
    ) {

      continue;

    }


    p.bet =
      0;


    p.st.r++;


    p.pnl =
      r2(
        p.pnl -
        b.amt
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
          -b.amt

      }
    );


    addPlayerTransaction(
      p,
      'GAME_LOSS',
      b.amt,
      'Crash game loss',
      makeReference('gameloss'),
      'SUCCESS'
    );


    addFinancialTransaction({

      userId:
        p.id,

      type:
        'GAME_LOSS',

      amount:
        b.amt,

      direction:
        'DEBIT',

      status:
        'SUCCESS',

      description:
        'Crash game loss',

      provider:
        'GAME'

    });

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


/*
=========================================================
GAME LOOP
=========================================================
*/

setInterval(
  () => {

    const now =
      Date.now();


    if (
      R.phase === 'count' &&
      now >= R.countEnd
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
            now -
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


    } else if (
      R.phase === 'over' &&
      now >= R.overEnd
    ) {

      startRound();

    }

  },
  50
);


/*
=========================================================
CONNECTIONS
=========================================================
*/

const conns =
  new Set();


function snap(token) {

  const p =
    db.players[token];

  const b =
    R.bets[token];

  const over =
    R.phase === 'over';


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

        bal:
          p.bal,

        pnl:
          p.pnl,

        st:
          p.st,

        log:
          p.log,

        bonus:
          !!p.bonus,

        bet:
          b
            ? {

                amt:
                  b.amt,

                auto:
                  b.auto,

                at:
                  b.at

              }
            : null,

        email:
          p.email || '',

        bank:
          p.bank || null

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
    const c of conns
  ) {

    send(c);

  }

}


setInterval(
  () => {

    for (
      const c of conns
    ) {

      c.res.write(
        ':\n\n'
      );

    }

  },
  15000
);


setInterval(
  broadcast,
  10000
);


/*
=========================================================
PLAYER
=========================================================
*/

const okToken =
  t =>
    typeof t === 'string' &&
    /^[a-f0-9]{16,64}$/
      .test(t);


function player(
  token,
  name,
  tg
) {

  if (
    !okToken(token)
  ) {

    return null;

  }


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
      db.players[token] =
      {

        name:
          'Player',

        bal:
          START,

        pnl:
          0,

        st:
          {

            r: 0,
            w: 0,
            best: 0,
            big: 0

          },

        log:
          [],

        bet:
          0,

        bonus:
          false,

        first:
          Date.now(),

        tg:
          null,

        email:
          '',

        bank:
          null,

        transactions:
          [],

        deposits:
          [],

        withdrawals:
          []

      };

  }


  if (!p.id)
    p.id =
      sha(token)
        .slice(0, 8);


  if (!p.first)
    p.first =
      Date.now();


  if (!Array.isArray(p.transactions))
    p.transactions = [];

  if (!Array.isArray(p.deposits))
    p.deposits = [];

  if (!Array.isArray(p.withdrawals))
    p.withdrawals = [];


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
        .slice(
          0,
          20
        ) ||
      'Player';

  }


  save();

  return p;
}


/*
=========================================================
GAME API
=========================================================
*/

const now = () =>
  Math.exp(
    GROWTH *
    (
      Date.now() -
      R.flyStart
    ) /
    1000
  );


const api = {

  /*
  =======================================================
  BET
  =======================================================
  */

  bet(
    p,
    t,
    b
  ) {

    const amt =
      Math.floor(
        Number(b.amt)
      );


    const auto =
      Number(b.auto) >= 1.01
        ? r2(
            Number(b.auto)
          )
        : 0;


    if (
      R.phase !== 'count'
    ) {

      return 'Betting is closed for this round';

    }


    if (
      R.bets[t]
    ) {

      return 'You already have a bet in this round';

    }


    if (
      !(
        amt >= MIN &&
        amt <= MAX
      )
    ) {

      return (
        'Bet must be between ' +
        MIN +
        ' and ' +
        MAX
      );

    }


    if (
      amt > p.bal
    ) {

      return 'Not enough balance';

    }


    p.bal =
      r2(
        p.bal -
        amt
      );


    p.bet =
      amt;


    R.bets[t] =
      {

        amt,
        auto,
        at: 0

      };

  },


  /*
  =======================================================
  CANCEL
  =======================================================
  */

  cancel(
    p,
    t
  ) {

    const b =
      R.bets[t];


    if (
      R.phase !== 'count' ||
      !b
    ) {

      return 'Nothing to cancel';

    }


    p.bal =
      r2(
        p.bal +
        b.amt
      );


    p.bet =
      0;


    delete R.bets[t];

  },


  /*
  =======================================================
  CASHOUT
  =======================================================
  */

  cashout(
    p,
    t
  ) {

    const b =
      R.bets[t];


    if (
      R.phase !== 'fly' ||
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

      return 'Too late, it crashed';

    }


    cash(
      t,
      m
    );

  },


  /*
  =======================================================
  RESTORE
  =======================================================
  */

  restore(
    p,
    t
  ) {

    if (
      p.bal >= MIN ||
      R.bets[t]
    ) {

      return 'You still have coins';

    }


    p.bal =
      START;

  },


  /*
  =======================================================
  BONUS
  =======================================================
  */

  bonus(
    p
  ) {

    if (
      p.bonus
    ) {

      return 'Already claimed';

    }


    p.bonus =
      true;


    p.bal =
      r2(
        p.bal +
        BONUS
      );


    addPlayerTransaction(
      p,
      'BONUS',
      BONUS,
      'Welcome bonus',
      makeReference('bonus'),
      'SUCCESS'
    );


    addFinancialTransaction({

      userId:
        p.id,

      type:
        'BONUS',

      amount:
        BONUS,

      direction:
        'CREDIT',

      status:
        'SUCCESS',

      description:
        'Welcome bonus',

      provider:
        'SYSTEM'

    });

  }

};


/*
=========================================================
DEPOSIT
=========================================================
*/

api.deposit = async function(
  p,
  t,
  b
) {

  if (!PAYSTACK_SECRET_KEY)
    return 'Payment system is not configured';


  const amount =
    money(
      b.amount
    );


  if (
    amount < 100
  ) {

    return 'Minimum deposit is ₦100';

  }


  const email =
    String(
      b.email ||
      p.email ||
      ''
    )
    .trim()
    .toLowerCase();


  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/
      .test(email)
  ) {

    return 'Valid email is required for deposit';

  }


  p.email =
    email;


  const reference =
    makeReference('dep');


  try {

    const result =
      await paystackRequest(
        'POST',
        '/transaction/initialize',
        {

          email,

          amount:
            nairaToKobo(
              amount
            ).toString(),

          currency:
            'NGN',

          reference,

          metadata:
            JSON.stringify({

              user_id:
                p.id,

              player_token:
                t,

              type:
                'deposit'

            })

        }
      );


    const item = {

      reference,

      userId:
        p.id,

      token:
        t,

      amount,

      amountKobo:
        nairaToKobo(
          amount
        ),

      status:
        'PENDING',

      provider:
        'PAYSTACK',

      createdAt:
        Date.now(),

      authorizationUrl:
        result.data.authorization_url

    };


    db.deposits[
      reference
    ] =
      item;


    p.deposits.unshift(
      reference
    );


    p.deposits =
      p.deposits.slice(
        0,
        100
      );


    addFinancialTransaction({

      userId:
        p.id,

      type:
        'DEPOSIT',

      amount,

      direction:
        'CREDIT',

      status:
        'PENDING',

      description:
        'Deposit initiated',

      provider:
        'PAYSTACK',

      providerReference:
        reference,

      reference

    });


    save();


    return JSON.stringify({

      deposit: true,

      reference,

      authorizationUrl:
        result.data.authorization_url

    });


  } catch (e) {

    return (
      'Deposit initialization failed: ' +
      e.message
    );

  }

};


/*
=========================================================
VERIFY DEPOSIT
=========================================================
*/

api.verifyDeposit = async function(
  p,
  t,
  b
) {

  const reference =
    String(
      b.reference || ''
    );


  if (!reference)
    return 'Deposit reference is required';


  const dep =
    db.deposits[
      reference
    ];


  if (!dep)
    return 'Deposit not found';


  if (
    dep.userId !== p.id
  ) {

    return 'Deposit does not belong to this account';

  }


  /*
    Prevent double credit.
  */

  if (
    dep.status === 'SUCCESS'
  ) {

    return JSON.stringify({

      verified: true,

      alreadyCredited: true,

      amount:
        dep.amount

    });

  }


  try {

    const result =
      await paystackRequest(
        'GET',
        '/transaction/verify/' +
        encodeURIComponent(
          reference
        )
      );


    const data =
      result.data;


    if (
      data.status !== 'success'
    ) {

      dep.status =
        String(
          data.status ||
          'PENDING'
        ).toUpperCase();

      save();


      return (
        'Payment is not successful yet'
      );

    }


    /*
      Verify amount as well.
    */

    if (
      Number(data.amount) !==
      Number(dep.amountKobo)
    ) {

      dep.status =
        'AMOUNT_MISMATCH';

      save();

      return 'Payment amount mismatch';

    }


    /*
      Credit exactly once.
    */

    if (
      dep.status !== 'SUCCESS'
    ) {

      p.bal =
        r2(
          p.bal +
          dep.amount
        );


      dep.status =
        'SUCCESS';


      dep.paidAt =
        Date.now();


      dep.providerId =
        data.id;


      addPlayerTransaction(

        p,

        'DEPOSIT',

        dep.amount,

        'Verified Paystack deposit',

        reference,

        'SUCCESS'

      );


      addFinancialTransaction({

        userId:
          p.id,

        type:
          'DEPOSIT',

        amount:
          dep.amount,

        direction:
          'CREDIT',

        status:
          'SUCCESS',

        description:
          'Deposit credited',

        provider:
          'PAYSTACK',

        providerReference:
          reference,

        reference

      });


      save();

      broadcast();

    }


    return JSON.stringify({

      verified: true,

      amount:
        dep.amount,

      balance:
        p.bal

    });


  } catch (e) {

    return (
      'Deposit verification failed: ' +
      e.message
    );

  }

};


/*
=========================================================
GET BANKS
=========================================================
*/

api.banks = async function(
  p,
  t,
  b
) {

  try {

    const result =
      await paystackRequest(
        'GET',
        '/bank?country=nigeria&currency=NGN&perPage=100'
      );


    return JSON.stringify({

      banks:
        result.data || []

    });


  } catch (e) {

    return (
      'Could not load banks: ' +
      e.message
    );

  }

};


/*
=========================================================
SAVE BANK DETAILS
=========================================================
*/

api.saveBank = async function(
  p,
  t,
  b
) {

  const bankCode =
    String(
      b.bankCode || ''
    ).trim();


  const accountNumber =
    String(
      b.accountNumber || ''
    ).trim();


  const accountName =
    String(
      b.accountName || ''
    ).trim();


  if (
    !bankCode ||
    !/^\d{10}$/.test(
      accountNumber
    )
  ) {

    return 'Valid bank code and 10-digit account number are required';

  }


  if (
    accountName.length < 2
  ) {

    return 'Account name is required';

  }


  p.bank = {

    bankCode,

    accountNumber,

    accountName:

      accountName
        .slice(
          0,
          100
        ),

    bankName:
      String(
        b.bankName || ''
      ).slice(
        0,
        100
      ),

    updatedAt:
      Date.now()

  };


  save();

  return JSON.stringify({

    saved: true,

    bank:
      p.bank

  });

};


/*
=========================================================
WITHDRAWAL REQUEST
=========================================================
*/

api.withdraw = async function(
  p,
  t,
  b
) {

  const amount =
    money(
      b.amount
    );


  if (
    amount < WITHDRAW_MIN
  ) {

    return (
      'Minimum withdrawal is ₦' +
      WITHDRAW_MIN.toLocaleString()
    );

  }


  if (
    amount > WITHDRAW_MAX
  ) {

    return (
      'Maximum withdrawal is ₦' +
      WITHDRAW_MAX.toLocaleString()
    );

  }


  if (
    amount > p.bal
  ) {

    return 'Not enough balance';

  }


  if (
    !p.bank ||
    !p.bank.bankCode ||
    !p.bank.accountNumber
  ) {

    return 'Add your bank account first';

  }


  /*
    Only one pending withdrawal per user.
  */

  const existing =
    Object.values(
      db.withdrawals
    )
    .find(
      w =>
        w.userId === p.id &&
        (
          w.status === 'PENDING' ||
          w.status === 'PROCESSING'
        )
    );


  if (existing) {

    return 'You already have a pending withdrawal';

  }


  /*
    Reserve the money immediately.
  */

  p.bal =
    r2(
      p.bal -
      amount
    );


  const reference =
    makeReference('wd');


  const withdrawal = {

    reference,

    userId:
      p.id,

    token:
      t,

    amount,

    amountKobo:
      nairaToKobo(
        amount
      ),

    bankCode:
      p.bank.bankCode,

    accountNumber:
      p.bank.accountNumber,

    accountName:
      p.bank.accountName,

    bankName:
      p.bank.bankName || '',

    recipientCode:
      '',

    status:
      'PENDING',

    provider:
      'PAYSTACK',

    createdAt:
      Date.now(),

    paidAt:
      0,

    failedAt:
      0

  };


  db.withdrawals[
    reference
  ] =
    withdrawal;


  p.withdrawals.unshift(
    reference
  );


  p.withdrawals =
    p.withdrawals.slice(
      0,
      100
    );


  addPlayerTransaction(

    p,

    'WITHDRAWAL',

    amount,

    'Withdrawal request',

    reference,

    'PENDING'

  );


  addFinancialTransaction({

    userId:
      p.id,

    type:
      'WITHDRAWAL',

    amount,

    direction:
      'DEBIT',

    status:
      'PENDING',

    description:
      'Withdrawal requested',

    provider:
      'PAYSTACK',

    providerReference:
      reference,

    reference

  });


  save();

  broadcast();


  return JSON.stringify({

    withdrawal: true,

    reference,

    amount,

    status:
      'PENDING'

  });

};


/*
=========================================================
PLAYER TRANSACTIONS
=========================================================
*/

api.transactions = function(
  p
) {

  return JSON.stringify({

    transactions:
      p.transactions || [],

    deposits:
      (p.deposits || [])
        .map(
          ref =>
            db.deposits[ref]
        )
        .filter(Boolean),

    withdrawals:
      (p.withdrawals || [])
        .map(
          ref =>
            db.withdrawals[ref]
        )
        .filter(Boolean)

  });

};


/*
=========================================================
HTTP SERVER
=========================================================
*/

http.createServer(
  (req, res) => {

    const u =
      new URL(
        req.url,
        'http://x'
      );


    /*
    =======================================================
    PLAYER EVENTS
    =======================================================
    */

    if (
      u.pathname ===
      '/events'
    ) {

      const token =
        u.searchParams.get(
          'token'
        );


      if (
        !player(
          token,
          u.searchParams.get(
            'name'
          ),
          tgUser(
            u.searchParams.get(
              'tg'
            )
          )
        )
      ) {

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


      const c =
        {

          res,
          token

        };


      conns.add(c);


      res.on(
        'close',
        () => {

          conns.delete(c);


          const q =
            db.players[token];


          if (q)
            q.seen =
              Date.now();

        }
      );


      return send(c);

    }


    /*
    =======================================================
    PLAYER API
    =======================================================
    */

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
            d.length > 10000
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

          } catch (e) {}


          const fn =
            api[
              u.pathname.slice(
                5
              )
            ];


          const p =
            okToken(
              b.token
            ) &&
            db.players[
              b.token
            ];


          if (
            !fn ||
            !p
          ) {

            res.writeHead(
              200,
              {
                'Content-Type':
                  'application/json'
              }
            );


            return res.end(
              JSON.stringify({

                ok:
                  false,

                error:
                  'Unknown request'

              })
            );

          }


          try {

            const result =
              await fn(
                p,
                b.token,
                b
              );


            /*
              Functions that return a string beginning
              with JSON are treated as structured success.
            */

            let parsed =
              null;


            if (
              typeof result === 'string'
            ) {

              try {

                parsed =
                  JSON.parse(
                    result
                  );

              } catch (e) {}

            }


            if (
              parsed
            ) {

              /*
                Some JSON responses contain an error
                property. Otherwise return as success.
              */

              res.writeHead(
                200,
                {
                  'Content-Type':
                    'application/json'
                }
              );


              return res.end(
                JSON.stringify({

                  ok:
                    !parsed.error,

                  ...parsed

                })
              );

            }


            if (result) {

              res.writeHead(
                200,
                {
                  'Content-Type':
                    'application/json'
                }
              );


              return res.end(
                JSON.stringify({

                  ok:
                    false,

                  error:
                    result

                })
              );

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


            return res.end(
              JSON.stringify({

                ok:
                  true

              })
            );


          } catch (e) {

            res.writeHead(
              500,
              {
                'Content-Type':
                  'application/json'
              }
            );


            return res.end(
              JSON.stringify({

                ok:
                  false,

                error:
                  e.message ||
                  'Server error'

              })
            );

          }

        }
      );

    }


    /*
    =======================================================
    ADMIN PANEL
    =======================================================
    */

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
            e ? 500 : 200,
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


    /*
    =======================================================
    ADMIN API
    =======================================================
    */

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
            d.length > 20000
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

          } catch (e) {}


          const h =
            x =>
              crypto
                .createHash(
                  'sha256'
                )
                .update(
                  String(x || '')
                )
                .digest();


          const out =
            (code, o) => {

              res.writeHead(
                code,
                {

                  'Content-Type':
                    'application/json'

                }
              );


              res.end(
                JSON.stringify(o)
              );

            };


          const keyA =
            h(
              b.key
            );

          const keyB =
            h(
              ADMIN_KEY
            );


          if (
            keyA.length !==
            keyB.length ||
            !crypto.timingSafeEqual(
              keyA,
              keyB
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


          /*
          =================================================
          ADMIN STATE
          =================================================
          */

          if (
            act === 'state'
          ) {

            const on =
              new Set(
                [
                  ...conns
                ]
                .map(
                  c =>
                    c.token
                )
              );


            const players =
              Object.entries(
                db.players
              )
              .map(
                ([t, p]) => ({

                  id:
                    p.id,

                  name:
                    p.name,

                  tg:
                    p.tg,

                  email:
                    p.email || '',

                  bank:
                    p.bank || null,

                  bal:
                    p.bal,

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
                            R.bets[t].amt,

                          auto:
                            R.bets[t].auto,

                          at:
                            R.bets[t].at

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

                round:
                  {

                    id:
                      R.id,

                    phase:
                      R.phase,

                    bets:
                      Object.keys(
                        R.bets
                      ).length

                  },

                /*
                  Financial summary
                */

                payoutFund:
                  koboToNaira(
                    db.payoutFundKobo
                  ),

                totalDeposits:
                  r2(
                    Object.values(
                      db.deposits
                    )
                    .filter(
                      d =>
                        d.status ===
                        'SUCCESS'
                    )
                    .reduce(
                      (a, d) =>
                        a +
                        Number(
                          d.amount
                        ),
                      0
                    )
                  ),

                totalWithdrawals:
                  r2(
                    Object.values(
                      db.withdrawals
                    )
                    .filter(
                      w =>
                        w.status ===
                        'SUCCESS'
                    )
                    .reduce(
                      (a, w) =>
                        a +
                        Number(
                          w.amount
                        ),
                      0
                    )
                  ),

                pendingWithdrawals:
                  Object.values(
                    db.withdrawals
                  )
                  .filter(
                    w =>
                      w.status ===
                      'PENDING'
                  ).length,

                players

              }
            );

          }


          /*
          =================================================
          RESTORE PLAYER
          =================================================
          */

          if (
            act === 'restore'
          ) {

            const p =
              Object.values(
                db.players
              )
              .find(
                x =>
                  x.id === b.id
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


            p.bal =
              Math.max(
                p.bal,
                START
              );


            save();

            broadcast();


            return out(
              200,
              {

                ok:
                  true

              }
            );

          }


          /*
          =================================================
          CRASH TARGET CONTROL
          =================================================
          */

          if (
            act === 'targets'
          ) {

            if (
              !Array.isArray(
                b.targets
              )
            ) {

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    'targets must be an array'

                }
              );

            }


            const targets =
              b.targets
                .map(Number)
                .filter(
                  n =>
                    Number.isFinite(n) &&
                    n >= 1.01 &&
                    n <= 1000
                )
                .map(
                  n =>
                    r2(n)
                );


            if (
              targets.length !==
              b.targets.length
            ) {

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    'Each target must be between 1.01x and 1000x'

                }
              );

            }


            db.customTargets =
              [
                ...new Set(
                  targets
                )
              ];


            db.customTargetIndex =
              0;


            save();


            return out(
              200,
              {

                ok:
                  true,

                targets:
                  db.customTargets,

                message:
                  db.customTargets.length

                    ?

                    'Crash targets saved for future rounds'

                    :

                    'Crash target control cleared; random targets restored'

              }
            );

          }


          /*
          =================================================
          ADMIN FINANCIAL STATE
          =================================================
          */

          if (
            act ===
            'financial-state'
          ) {

            return out(
              200,
              {

                ok:
                  true,

                payoutFund:
                  koboToNaira(
                    db.payoutFundKobo
                  ),

                payoutFundKobo:
                  db.payoutFundKobo,

                deposits:
                  Object.values(
                    db.deposits
                  )
                  .slice(
                    0,
                    200
                  ),

                withdrawals:
                  Object.values(
                    db.withdrawals
                  )
                  .slice(
                    0,
                    200
                  ),

                transactions:
                  db.financialTransactions
                    .slice(
                      0,
                      500
                    )

              }
            );

          }


          /*
          =================================================
          ADD PAYOUT FUND
          =================================================

          No ₦10m limit.

          Example:
          10000000
          50000000
          100000000

          The amount is recorded as an admin ledger entry.
          It does NOT magically create money at Paystack.
          =================================================
          */

          if (
            act ===
            'payout-fund-add'
          ) {

            const amount =
              money(
                b.amount
              );


            if (
              amount <= 0
            ) {

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    'Invalid funding amount'

                }
              );

            }


            const kobo =
              nairaToKobo(
                amount
              );


            if (
              !Number.isSafeInteger(
                db.payoutFundKobo +
                kobo
              )
            ) {

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    'Funding amount is too large'

                }
              );

            }


            db.payoutFundKobo +=
              kobo;


            const reference =
              String(
                b.reference ||
                makeReference(
                  'fund'
                )
              );


            addFinancialTransaction({

              userId:
                null,

              type:
                'PAYOUT_FUND',

              amount,

              direction:
                'CREDIT',

              status:
                'SUCCESS',

              description:
                b.description ||
                'Admin payout funding',

              provider:
                'ADMIN_LEDGER',

              reference

            });


            save();


            return out(
              200,
              {

                ok:
                  true,

                reference,

                added:
                  amount,

                payoutFund:
                  koboToNaira(
                    db.payoutFundKobo
                  )

              }
            );

          }


          /*
          =================================================
          REMOVE PAYOUT FUND
          =================================================
          */

          if (
            act ===
            'payout-fund-remove'
          ) {

            const amount =
              money(
                b.amount
              );


            if (
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


            const kobo =
              nairaToKobo(
                amount
              );


            if (
              kobo >
              db.payoutFundKobo
            ) {

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    'Amount exceeds payout-fund balance'

                }
              );

            }


            db.payoutFundKobo -=
              kobo;


            addFinancialTransaction({

              type:
                'PAYOUT_FUND_REMOVE',

              amount,

              direction:
                'DEBIT',

              status:
                'SUCCESS',

              description:
                b.description ||
                'Admin removed payout funds',

              provider:
                'ADMIN_LEDGER',

              reference:
                String(
                  b.reference ||
                  makeReference(
                    'fundremove'
                  )
                )

            });


            save();


            return out(
              200,
              {

                ok:
                  true,

                removed:
                  amount,

                payoutFund:
                  koboToNaira(
                    db.payoutFundKobo
                  )

              }
            );

          }


          /*
          =================================================
          ADMIN LIST DEPOSITS
          =================================================
          */

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
                  Object.values(
                    db.deposits
                  )
                  .sort(
                    (a, b) =>
                      b.createdAt -
                      a.createdAt
                  )
                  .slice(
                    0,
                    500
                  )

              }
            );

          }


          /*
          =================================================
          ADMIN LIST WITHDRAWALS
          =================================================
          */

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
                  Object.values(
                    db.withdrawals
                  )
                  .sort(
                    (a, b) =>
                      b.createdAt -
                      a.createdAt
                  )
                  .slice(
                    0,
                    500
                  )

              }
            );

          }


          /*
          =================================================
          ADMIN TRANSACTIONS
          =================================================
          */

          if (
            act ===
            'transactions'
          ) {

            return out(
              200,
              {

                ok:
                  true,

                transactions:
                  db.financialTransactions
                    .slice(
                      0,
                      1000
                    )

              }
            );

          }


          /*
          =================================================
          PAY WITH PAYSTACK
          =================================================
          */

          if (
            act ===
            'withdrawal-pay'
          ) {

            if (
              !PAYSTACK_SECRET_KEY
            ) {

              return out(
                500,
                {

                  ok:
                    false,

                  error:
                    'PAYSTACK_SECRET_KEY is missing'

                }
              );

            }


            const reference =
              String(
                b.reference ||
                ''
              );


            const w =
              db.withdrawals[
                reference
              ];


            if (!w) {

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
              w.status !==
              'PENDING'
            ) {

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    'Withdrawal is already being processed or completed'

                }
              );

            }


            /*
              Check payout-fund ledger.
            */

            if (
              w.amountKobo >
              db.payoutFundKobo
            ) {

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    'Insufficient payout-fund balance'

                }
              );

            }


            try {

              /*
              Create Paystack transfer recipient.
              Paystack validates the destination bank
              account as part of recipient creation.
              */

              const recipient =
                await paystackRequest(
                  'POST',
                  '/transferrecipient',
                  {

                    type:
                      'nuban',

                    name:
                      w.accountName,

                    account_number:
                      w.accountNumber,

                    bank_code:
                      w.bankCode,

                    currency:
                      'NGN',

                    description:
                      'Withdrawal ' +
                      reference

                  }
                );


              const recipientCode =
                recipient.data.recipient_code;


              w.recipientCode =
                recipientCode;


              /*
              Initiate transfer.
              Paystack amount is in kobo.
              */

              const transfer =
                await paystackRequest(
                  'POST',
                  '/transfer',
                  {

                    source:
                      'balance',

                    amount:
                      w.amountKobo,

                    recipient:
                      recipientCode,

                    reference,

                    reason:
                      'User withdrawal',

                    currency:
                      'NGN'

                  }
                );


              w.status =
                'PROCESSING';


              w.providerReference =
                reference;


              w.transferId =
                transfer.data &&
                transfer.data.id;


              /*
                Reserve the payout ledger amount.
              */

              db.payoutFundKobo -=
                w.amountKobo;


              addFinancialTransaction({

                userId:
                  w.userId,

                type:
                  'PAYOUT',

                amount:
                  w.amount,

                direction:
                  'DEBIT',

                status:
                  'PROCESSING',

                description:
                  'Paystack withdrawal transfer',

                provider:
                  'PAYSTACK',

                providerReference:
                  reference,

                reference

              });


              save();


              return out(
                200,
                {

                  ok:
                    true,

                  status:
                    w.status,

                  reference,

                  payoutFund:
                    koboToNaira(
                      db.payoutFundKobo
                    )

                }
              );


            } catch (e) {

              /*
                If transfer failed before money was
                removed from the payout ledger, the ledger
                remains unchanged.
              */

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    e.message ||
                    'Payout failed'

                }
              );

            }

          }


          /*
          =================================================
          VERIFY PAYOUT
          =================================================
          */

          if (
            act ===
            'withdrawal-verify'
          ) {

            if (
              !PAYSTACK_SECRET_KEY
            ) {

              return out(
                500,
                {

                  ok:
                    false,

                  error:
                    'PAYSTACK_SECRET_KEY is missing'

                }
              );

            }


            const reference =
              String(
                b.reference ||
                ''
              );


            const w =
              db.withdrawals[
                reference
              ];


            if (!w) {

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
              w.status ===
              'SUCCESS'
            ) {

              return out(
                200,
                {

                  ok:
                    true,

                  status:
                    'SUCCESS'

                }
              );

            }


            try {

              const result =
                await paystackRequest(
                  'GET',
                  '/transfer/verify/' +
                  encodeURIComponent(
                    reference
                  )
                );


              const status =
                String(
                  result.data.status ||
                  ''
                ).toLowerCase();


              if (
                status ===
                'success'
              ) {

                w.status =
                  'SUCCESS';


                w.paidAt =
                  Date.now();


                /*
                  Mark matching player withdrawal.
                */

                const p =
                  Object.values(
                    db.players
                  )
                  .find(
                    x =>
                      x.id ===
                      w.userId
                  );


                if (p) {

                  addPlayerTransaction(

                    p,

                    'WITHDRAWAL',

                    w.amount,

                    'Withdrawal paid',

                    reference,

                    'SUCCESS'

                  );

                }


                const tx =
                  db.financialTransactions
                    .find(
                      x =>
                        x.reference ===
                        reference &&
                        x.type ===
                        'PAYOUT'
                    );


                if (tx) {

                  tx.status =
                    'SUCCESS';

                  tx.updatedAt =
                    Date.now();

                }


                save();

                broadcast();


                return out(
                  200,
                  {

                    ok:
                      true,

                    status:
                      'SUCCESS',

                    reference

                  }
                );

              }


              if (
                status ===
                'failed' ||
                status ===
                'reversed'
              ) {

                /*
                  Return the reserved payout money
                  to the payout-fund ledger.
                */

                db.payoutFundKobo +=
                  w.amountKobo;


                w.status =
                  'FAILED';


                w.failedAt =
                  Date.now();


                const p =
                  Object.values(
                    db.players
                  )
                  .find(
                    x =>
                      x.id ===
                      w.userId
                  );


                if (p) {

                  /*
                    Return reserved user money.
                  */

                  p.bal =
                    r2(
                      p.bal +
                      w.amount
                    );


                  addPlayerTransaction(

                    p,

                    'WITHDRAWAL_REFUND',

                    w.amount,

                    'Failed withdrawal refunded',

                    reference,

                    'SUCCESS'

                  );

                }


                const tx =
                  db.financialTransactions
                    .find(
                      x =>
                        x.reference ===
                        reference &&
                        x.type ===
                        'PAYOUT'
                    );


                if (tx) {

                  tx.status =
                    'FAILED';

                  tx.updatedAt =
                    Date.now();

                }


                addFinancialTransaction({

                  userId:
                    w.userId,

                  type:
                    'WITHDRAWAL_REFUND',

                  amount:
                    w.amount,

                  direction:
                    'CREDIT',

                  status:
                    'SUCCESS',

                  description:
                    'Failed payout returned',

                  provider:
                    'PAYSTACK',

                  providerReference:
                    reference,

                  reference:
                    makeReference(
                      'refund'
                    )

                });


                save();

                broadcast();


                return out(
                  200,
                  {

                    ok:
                      true,

                    status:
                      'FAILED',

                    refunded:
                      true,

                    reference

                  }
                );

              }


              return out(
                200,
                {

                  ok:
                    true,

                  status:
                    status ||
                    'PROCESSING',

                  reference

                }
              );


            } catch (e) {

              return out(
                400,
                {

                  ok:
                    false,

                  error:
                    e.message

                }
              );

            }

          }


          /*
          =================================================
          UNKNOWN ADMIN REQUEST
          =================================================
          */

          return out(
            404,
            {

              ok:
                false,

              error:
                'Unknown request'

            }
          );

        }
      );

    }


    /*
    =======================================================
    HISTORY
    =======================================================
    */

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


    /*
    =======================================================
    MAIN GAME
    =======================================================
    */

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

).listen(
  PORT,
  () =>
    console.log(
      'Live Crash running on port ' +
      PORT
    )
);


/*
=========================================================
START GAME
=========================================================
*/

startRound();


console.log(
  process.env.ADMIN_KEY
    ? 'Admin panel: /admin (key from ADMIN_KEY)'
    : 'Admin panel: /admin   key: ' +
      ADMIN_KEY
);


console.log(
  PAYSTACK_SECRET_KEY
    ? 'Paystack payment system: configured'
    : 'Paystack payment system: NOT configured'
);


console.log(
  'Withdrawal minimum: ₦' +
  WITHDRAW_MIN.toLocaleString()
);


console.log(
  'Payout funding has no ₦10,000,000 application limit.'
);
