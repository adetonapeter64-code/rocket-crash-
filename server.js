// Live Crash server: one shared game for every player. No dependencies. Run: node server.js

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


let db = {
  players: {},
  history: [],
  nonce: 0,
  roundId: 0,

  /* ADMIN CRASH TARGET CONTROL */
  customTargets: [],
  customTargetIndex: 0
};


try {
  db = Object.assign(
    db,
    JSON.parse(
      fs.readFileSync(DATA, 'utf8')
    )
  );
} catch (e) {}


for (const p of Object.values(db.players)) {
  if (p.bet) {
    p.bal += p.bet;
    p.bet = 0;
  }
}


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


const ADMIN_KEY =
  process.env.ADMIN_KEY ||
  db.adminKey ||
  (
    db.adminKey =
      crypto.randomBytes(9).toString('hex')
  );

save();


const BOT_TOKEN =
  process.env.BOT_TOKEN || '';


const sha = s =>
  crypto
    .createHash('sha256')
    .update(s)
    .digest('hex');


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


const r2 = n =>
  Math.round(n * 100) / 100;


/* =========================================================
   ADMIN CRASH TARGET CONTROL
   =========================================================

   If there are no custom targets:
   → original random crash calculation is used.

   If admin enters targets:
   → targets are used one per round
   → in the exact order entered
   → after the last target, the list starts again

   Example:

   2.22
   1.95
   3.50
   5.20

   Round 1 → 2.22x
   Round 2 → 1.95x
   Round 3 → 3.50x
   Round 4 → 5.20x
   Round 5 → 2.22x
   ========================================================= */

function nextCrashTarget(seed, nonce) {

  const list =
    Array.isArray(db.customTargets)
      ? db.customTargets
      : [];


  /* No admin targets = original random system */

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


/* ========================================================= */

const addLog = (p, l) => {

  p.log.unshift(l);

  p.log.length =
    Math.min(
      p.log.length,
      8
    );
};


/* =========================================================
   TELEGRAM USER VERIFICATION
   ========================================================= */

function tgUser(initData) {

  if (!BOT_TOKEN || !initData)
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
      id: u.id,
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


/* =========================================================
   GAME ROUND
   ========================================================= */

let R = null;


function startRound() {

  const seed =
    crypto.randomBytes(16)
      .toString('hex');


  db.nonce++;

  db.roundId++;


  /*
    The crash point is fixed here
    before any bet is placed.
  */

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
      Date.now() + COUNT_MS,

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


/* =========================================================
   CASH OUT
   ========================================================= */

function cash(t, m) {

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
      crash: null,
      amt: b.amt,
      at: m,
      profit:
        r2(
          win -
          b.amt
        )
    }
  );


  save();

  broadcast();
}


/* =========================================================
   END ROUND
   ========================================================= */

function endRound() {

  R.phase =
    'over';


  R.overEnd =
    Date.now() +
    OVER_MS;


  for (
    const [t, b]
    of Object.entries(R.bets)
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


/* =========================================================
   GAME LOOP
   ========================================================= */

setInterval(() => {

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
      of Object.entries(R.bets)
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

}, 50);


/* =========================================================
   CONNECTIONS
   ========================================================= */

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
          h => h.crash
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


/* =========================================================
   PLAYER
   ========================================================= */

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
          null

      };

  }


  if (!p.id)
    p.id =
      sha(token)
        .slice(0, 8);


  if (!p.first)
    p.first =
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
        .slice(
          0,
          20
        ) ||
      'Player';

  }


  save();

  return p;
}


/* =========================================================
   GAME API
   ========================================================= */

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

  }

};


/* =========================================================
   HTTP SERVER
   ========================================================= */

http.createServer(
  (req, res) => {

    const u =
      new URL(
        req.url,
        'http://x'
      );


    /* =====================================================
       PLAYER EVENTS
       ===================================================== */

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


    /* =====================================================
       PLAYER API
       ===================================================== */

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
            d.length > 2000
          ) {

            req.destroy();

          }

        }
      );


      return req.on(
        'end',
        () => {

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


          const err =
            !fn || !p
              ? 'Unknown request'
              : fn(
                  p,
                  b.token,
                  b
                );


          if (!err) {

            save();

            broadcast();

          }


          res.writeHead(
            200,
            {
              'Content-Type':
                'application/json'
            }
          );


          res.end(
            JSON.stringify(
              err
                ? {
                    ok: false,
                    error: err
                  }
                : {
                    ok: true
                  }
            )
          );

        }
      );

    }


    /* =====================================================
       ADMIN PANEL
       ===================================================== */

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


    /* =====================================================
       ADMIN API
       ===================================================== */

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
            d.length > 2000
          ) {

            req.destroy();

          }

        }
      );


      return req.on(
        'end',
        () => {

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


          if (
            !crypto.timingSafeEqual(
              h(b.key),
              h(ADMIN_KEY)
            )
          ) {

            return out(
              401,
              {
                ok: false,
                error:
                  'Wrong admin key'
              }
            );

          }


          const act =
            u.pathname.slice(
              11
            );


          /* =================================================
             ADMIN STATE
             ================================================= */

          if (
            act === 'state'
          ) {

            const on =
              new Set(
                [
                  ...conns
                ]
                .map(
                  c => c.token
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
                ok: true,

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

                players

              }
            );

          }


          /* =================================================
             RESTORE PLAYER
             ================================================= */

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
                  ok: false,
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
                ok: true
              }
            );

          }


          /* =================================================
             CRASH TARGET CONTROL
             =================================================

             Admin Panel sends:

             {
               "targets": [
                 2.22,
                 1.95,
                 3.50,
                 5.20
               ]
             }

             The targets are used only for FUTURE rounds.

             The current round is not changed.
             ================================================= */

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
                  ok: false,
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
                  ok: false,
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

                ok: true,

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


          /* ================================================= */

          return out(
            404,
            {
              ok: false,
              error:
                'Unknown request'
            }
          );

        }
      );

    }


    /* =====================================================
       HISTORY
       ===================================================== */

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


    /* =====================================================
       MAIN GAME
       ===================================================== */

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


startRound();


console.log(
  process.env.ADMIN_KEY
    ? 'Admin panel: /admin (key from ADMIN_KEY)'
    : 'Admin panel: /admin   key: ' +
      ADMIN_KEY
);
