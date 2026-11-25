// HyperLens — heads-up Hyperliquid glance for Even G2 glasses.
// Live data only: Hyperliquid public info API (no key, no account, no funds).
// All code written 26 Nov 2026 for the "Heads Up: Even Realities" hackathon.
// No mocks, no hardcoded prices. If the API is unreachable we say OFFLINE.

const HL_INFO = 'https://api.hyperliquid.xyz/info'
const COINS = ['BTC', 'ETH', 'SOL']
const ALERT_PCT = 5 // |24h change| >= 5% triggers the alert line
const BRIDGE_TIMEOUT_MS = 2500

const $ = (id) => document.getElementById(id)
const nowTime = () => new Date().toTimeString().slice(0, 8)
const fmtUsd = (n, dec = 2) =>
  '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
const fmtSignedPct = (n, dec = 2) => (n >= 0 ? '+' : '') + n.toFixed(dec) + '%'
const fmtVol = (n) => {
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'
  return '$' + Math.round(n).toLocaleString('en-US')
}
const shortAddr = (a) => (a ? a.slice(0, 6) + '...' + a.slice(-4) : '')

// ---------------------------------------------------------------- state
const store = {
  get wallet() { return (localStorage.getItem('hyperlens.wallet') || '').trim() },
  set wallet(v) { v ? localStorage.setItem('hyperlens.wallet', v) : localStorage.removeItem('hyperlens.wallet') },
  get watchlist() {
    try {
      const v = JSON.parse(localStorage.getItem('hyperlens.watchlist') || 'null')
      if (Array.isArray(v) && v.length && v.every((c) => COINS.includes(c))) return v
    } catch { /* fall through */ }
    return [...COINS]
  },
  set watchlist(v) { localStorage.setItem('hyperlens.watchlist', JSON.stringify(v)) },
  get intervalSec() {
    const v = parseInt(localStorage.getItem('hyperlens.interval') || '30', 10)
    return [15, 30, 60].includes(v) ? v : 30
  },
  set intervalSec(v) { localStorage.setItem('hyperlens.interval', String(v)) },
}

const state = {
  coins: {},          // BTC/ETH/SOL -> { mark, chg24, funding, vol24 }
  wallet: null,       // { accountValue, upnl, top: {coin, side, size, value} | null }
  walletError: null,
  online: false,
  lastOk: null,
  screen: 0,          // index into screens()
  bridge: null,       // Even bridge when running on glasses/simulator
  sdk: null,
}

function screens() {
  const list = store.watchlist.map((c) => ({ kind: 'coin', coin: c }))
  if (store.wallet) list.push({ kind: 'wallet' })
  return list
}
const currentScreen = () => screens()[state.screen % screens().length]

// ---------------------------------------------------------------- data
async function hlPost(body) {
  const r = await fetch(HL_INFO, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error('HTTP ' + r.status)
  return r.json()
}

async function fetchMarkets() {
  const [meta, ctxs] = await hlPost({ type: 'metaAndAssetCtxs' })
  const out = {}
  meta.universe.forEach((asset, i) => {
    if (!COINS.includes(asset.name)) return
    const c = ctxs[i]
    const mark = parseFloat(c.markPx)
    const prev = parseFloat(c.prevDayPx)
    out[asset.name] = {
      mark,
      chg24: prev > 0 ? ((mark - prev) / prev) * 100 : 0,
      funding: parseFloat(c.funding), // per-hour rate, e.g. 0.0000125
      vol24: parseFloat(c.dayNtlVlm),
    }
  })
  return out
}

async function fetchWallet(addr) {
  const d = await hlPost({ type: 'clearinghouseState', user: addr })
  const positions = (d.assetPositions || []).map((p) => p.position)
  let upnl = 0
  let top = null
  for (const p of positions) {
    upnl += parseFloat(p.unrealizedPnl || '0')
    const value = Math.abs(parseFloat(p.positionValue || '0'))
    if (!top || value > top.value) {
      top = {
        coin: p.coin,
        side: parseFloat(p.szi) >= 0 ? 'LONG' : 'SHORT',
        size: Math.abs(parseFloat(p.szi)),
        value,
      }
    }
  }
  return {
    accountValue: parseFloat(d.marginSummary?.accountValue || '0'),
    upnl,
    top,
  }
}

async function refreshAll() {
  try {
    state.coins = await fetchMarkets()
    state.online = true
    state.lastOk = nowTime()
    state.walletError = null
    if (store.wallet) {
      try {
        state.wallet = await fetchWallet(store.wallet)
      } catch (e) {
        state.wallet = null
        state.walletError = String(e.message || e)
      }
    } else {
      state.wallet = null
    }
  } catch (e) {
    state.online = false
    console.warn('[hyperlens] market fetch failed:', e)
  }
  renderPhone()
  pushToGlasses()
}

// ------------------------------------------------------- glasses rendering
function glassesText() {
  const s = currentScreen()
  const head = 'HYPERLENS'
  if (!state.online && !state.lastOk) {
    return [
      head,
      '',
      'OFFLINE - retrying...',
      'No live data yet.',
      'Check connection.',
      '',
      'Tap: next   Dbl-tap: exit',
    ].join('\n')
  }
  const stale = state.online ? '' : '  (STALE ' + (state.lastOk || '?') + ')'
  if (s.kind === 'coin') {
    const c = state.coins[s.coin]
    if (!c) return head + '\n\nLoading ' + s.coin + '...\n\nTap: next   Dbl-tap: exit'
    const idx = store.watchlist.indexOf(s.coin) + 1
    const arrow = c.chg24 >= 0 ? '▲' : '▼'
    const lines = [
      head + '  ' + s.coin + ' PERP' + stale,
      fmtUsd(c.mark),
      '24h ' + fmtSignedPct(c.chg24) + ' ' + arrow + '  Fund ' + (c.funding * 100).toFixed(4) + '%/h',
      'Vol 24h ' + fmtVol(c.vol24),
    ]
    if (Math.abs(c.chg24) >= ALERT_PCT) {
      lines.push('ALERT ' + arrow + ' ' + fmtSignedPct(c.chg24) + ' in 24h!')
    }
    lines.push('Updated ' + (state.lastOk || nowTime()) + '  ' + idx + '/' + store.watchlist.length)
    lines.push('Tap: next   Dbl-tap: exit')
    return lines.join('\n')
  }
  // wallet screen
  const w = state.wallet
  const lines = [head + '  WALLET' + stale, shortAddr(store.wallet)]
  if (state.walletError) {
    lines.push('Wallet lookup failed.', 'Retrying next refresh.')
  } else if (!w) {
    lines.push('Loading wallet...')
  } else {
    lines.push('Value ' + fmtUsd(w.accountValue))
    lines.push('uPnL ' + (w.upnl >= 0 ? '+' : '') + fmtUsd(w.upnl))
    if (w.top) {
      lines.push('Top ' + w.top.coin + ' ' + w.top.side + ' ' + w.top.size.toFixed(4))
      lines.push('      ' + fmtUsd(w.top.value))
    } else {
      lines.push('No open positions')
    }
  }
  lines.push('Updated ' + (state.lastOk || nowTime()))
  lines.push('Tap: back   Dbl-tap: exit')
  return lines.join('\n')
}

async function pushToGlasses() {
  if (!state.bridge) return
  try {
    await state.bridge.textContainerUpgrade(
      new state.sdk.TextContainerUpgrade({
        containerID: 1,
        containerName: 'main',
        content: glassesText(),
      }),
    )
  } catch (e) {
    console.warn('[hyperlens] glasses update failed:', e)
  }
}

function cycleScreen() {
  const n = screens().length
  state.screen = (state.screen + 1) % n
  renderPhone()
  pushToGlasses()
}

// ---------------------------------------------------------- phone rendering
function renderPhone() {
  const pill = $('status-pill')
  if (pill) {
    pill.textContent = state.online ? '● LIVE' : '○ OFFLINE — retrying'
    pill.className = 'pill ' + (state.online ? 'live' : 'offline')
  }
  const upd = $('last-updated')
  if (upd) upd.textContent = state.lastOk ? 'Last update ' + state.lastOk + ' WIB' : 'Waiting for first update…'
  for (const coin of COINS) {
    const c = state.coins[coin]
    const card = $('card-' + coin)
    if (!card) continue
    if (!c) {
      card.querySelector('.price').textContent = state.online ? '—' : 'OFFLINE'
      continue
    }
    card.querySelector('.price').textContent = fmtUsd(c.mark)
    const chg = card.querySelector('.chg')
    chg.textContent = fmtSignedPct(c.chg24) + ' 24h ' + (c.chg24 >= 0 ? '▲' : '▼')
    chg.className = 'chg ' + (c.chg24 >= 0 ? 'up' : 'down')
    card.querySelector('.fund').textContent = 'Funding ' + (c.funding * 100).toFixed(4) + '%/h'
    card.querySelector('.vol').textContent = 'Vol 24h ' + fmtVol(c.vol24)
    const alert = card.querySelector('.alert')
    if (Math.abs(c.chg24) >= ALERT_PCT) {
      alert.textContent = '⚠ ' + (c.chg24 >= 0 ? '▲' : '▼') + ' ' + fmtSignedPct(c.chg24) + ' in 24h — big move'
      alert.hidden = false
    } else {
      alert.hidden = true
    }
  }
  const wv = $('wallet-value')
  if (wv) {
    if (!store.wallet) {
      wv.textContent = 'No wallet set — add one below.'
      $('wallet-pnl').textContent = ''
      $('wallet-top').textContent = ''
    } else if (state.walletError) {
      wv.textContent = 'Wallet lookup failed — retrying.'
      $('wallet-pnl').textContent = ''
      $('wallet-top').textContent = ''
    } else if (state.wallet) {
      wv.textContent = 'Account value ' + fmtUsd(state.wallet.accountValue)
      $('wallet-pnl').textContent =
        'Unrealized PnL ' + (state.wallet.upnl >= 0 ? '+' : '') + fmtUsd(state.wallet.upnl)
      $('wallet-top').textContent = state.wallet.top
        ? 'Top position: ' + state.wallet.top.coin + ' ' + state.wallet.top.side + ' ' +
          state.wallet.top.size.toFixed(4) + ' (' + fmtUsd(state.wallet.top.value) + ')'
        : 'No open positions.'
    } else {
      wv.textContent = 'Loading wallet…'
    }
  }
  const prev = $('glasses-preview')
  if (prev) prev.textContent = glassesText()
  const scr = $('screen-indicator')
  if (scr) {
    const s = currentScreen()
    scr.textContent = s.kind === 'coin' ? 'Glasses: ' + s.coin + ' perp' : 'Glasses: wallet watch'
  }
}

// ------------------------------------------------------------------- events
async function initBridge() {
  let sdk
  try {
    sdk = await import('./sdk/even_hub_sdk.js')
  } catch (e) {
    console.log('[hyperlens] SDK unavailable in this browser, phone-only mode:', e)
    return
  }
  state.sdk = sdk
  let bridge = null
  try {
    bridge = await Promise.race([
      sdk.waitForEvenAppBridge(),
      new Promise((resolve) => setTimeout(() => resolve(null), BRIDGE_TIMEOUT_MS)),
    ])
  } catch (e) {
    console.log('[hyperlens] bridge wait failed, phone-only mode:', e)
  }
  if (!bridge) {
    console.log('[hyperlens] no Even bridge — phone panel mode')
    return
  }
  state.bridge = bridge
  const { TextContainerProperty, CreateStartUpPageContainer, OsEventTypeList } = sdk
  const mainText = new TextContainerProperty({
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 288,
    borderWidth: 0,
    borderColor: 5,
    paddingLength: 4,
    containerID: 1,
    containerName: 'main',
    content: 'HYPERLENS\n\nLoading live prices...',
    isEventCapture: 1,
  })
  const result = await bridge.createStartUpPageContainer(
    new CreateStartUpPageContainer({ containerTotalNum: 1, textObject: [mainText] }),
  )
  if (result !== 0) {
    // No real glasses/simulator attached (the SDK also resolves a stub
    // bridge in a plain browser) — fall back to phone-panel-only mode.
    console.log('[hyperlens] no glasses container (result ' + result + ') — phone-only mode')
    state.bridge = null
    return
  }
  console.log('[hyperlens] page created: success')

  const eventTypeOf = (env) => (env ? (env.eventType ?? OsEventTypeList.CLICK_EVENT) : null)
  bridge.onEvenHubEvent((event) => {
    const sysType = eventTypeOf(event.sysEvent)
    const textType = eventTypeOf(event.textEvent)
    // Double-tap exits via the system confirmation dialog (required on root page).
    if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
      bridge.shutDownPageContainer(1)
      return
    }
    if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
      cycleScreen()
    }
  })
}

// --------------------------------------------------------------------- boot
function initPanel() {
  // Deep link: ?wallet=0x... pre-fills the wallet watch (e.g. from a shared link).
  const qs = new URLSearchParams(location.search)
  const qw = (qs.get('wallet') || '').trim()
  if (qw && /^0x[0-9a-fA-F]{40}$/.test(qw)) store.wallet = qw
  const addr = $('wallet-addr')
  if (addr) {
    addr.value = store.wallet
    addr.placeholder = '0x... (Hyperliquid wallet address)'
  }
  const save = $('wallet-save')
  if (save) {
    save.addEventListener('click', () => {
      const v = addr.value.trim()
      const err = $('wallet-error')
      if (v && !/^0x[0-9a-fA-F]{40}$/.test(v)) {
        err.textContent = 'That does not look like a wallet address (0x + 40 hex characters).'
        err.hidden = false
        return
      }
      err.hidden = true
      store.wallet = v
      state.screen = 0
      state.wallet = null
      refreshAll()
    })
  }
  const clear = $('wallet-clear')
  if (clear) {
    clear.addEventListener('click', () => {
      addr.value = ''
      store.wallet = ''
      state.screen = 0
      state.wallet = null
      refreshAll()
    })
  }
  for (const coin of COINS) {
    const box = $('watch-' + coin)
    if (!box) continue
    box.checked = store.watchlist.includes(coin)
    box.addEventListener('change', () => {
      let wl = COINS.filter((c) => $('watch-' + c).checked)
      if (!wl.length) {
        // keep at least one coin on the watchlist
        box.checked = true
        wl = [coin]
      }
      store.watchlist = wl
      state.screen = 0
      refreshAll()
    })
  }
  const iv = $('refresh-interval')
  if (iv) {
    iv.value = String(store.intervalSec)
    iv.addEventListener('change', () => {
      store.intervalSec = parseInt(iv.value, 10)
      startTimer()
      refreshAll()
    })
  }
  const next = $('preview-next')
  if (next) next.addEventListener('click', cycleScreen)
}

let timer = null
function startTimer() {
  if (timer) clearInterval(timer)
  timer = setInterval(refreshAll, store.intervalSec * 1000)
}

initPanel()
renderPhone()
initBridge()
refreshAll()
startTimer()
