import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Limit, Reading, Where } from '../types'

const reading = atom({ plugin: 'context-meter', key: 'reading' } as const, null)

// Asked only when the button is pressed: each ask is a model call over the session's transcript.
const IDLE: Where = { status: 'idle', lines: [] }
const where = atom({ plugin: 'context-meter', key: 'where' } as const, IDLE)
const WHERE_PROMPT = [
  'Do not continue the work. Answer in exactly three short lines of plain text, no markdown, each under 110 characters:',
  'Now: where the work in this session stands',
  'Waiting on you: what needs the user to decide, check or do, or "nothing"',
  'Next: the next step',
].join('\n')

const ask = async ($: EngineInterface) => {
  await update($, where, () => ({ status: 'asking', lines: [] }))
  const reply = await $.model.fork({ prompt: WHERE_PROMPT })
  const lines = reply.isAnswered
    ? reply.text.split('\n').map(line => line.trim()).filter(line => line !== '').slice(0, 3)
    : [`No summary: ${reply.reason}`]
  await update($, where, () => ({ status: 'ready', lines }))
}

// Each session keeps its own file under the day's folder; a day's total is the sum of that folder.

const dayOf = (ms: number) => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')

  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

const ledger = async ($: EngineInterface) => `${(await $.env.get('HOME')) ?? ''}/.claude/mods-data/context-meter/cost`

// A session's entry for one day: its running cost when the day began for it, and its running cost now.
// `offset` carries what was spent before the session's own ledger started over (a /clear).
type Entry = { start: number; now: number; offset: number }

const entryIn = async ($: EngineInterface, path: string): Promise<Entry | undefined> => {
  const text = await $.fs.read(path).catch(() => '')

  try {
    const entry = JSON.parse(text)

    return typeof entry === 'object' && entry !== null && typeof entry.now === 'number' ? entry : undefined
  } catch {
    return undefined
  }
}

const totalOf = async ($: EngineInterface, day: string) => {
  const dir = `${await ledger($)}/${day}`
  const entries = await $.fs.list(dir).catch(() => [])
  let total = 0

  for (const { name } of entries) {
    const entry = await entryIn($, `${dir}/${name}`)
    total += entry === undefined ? 0 : entry.now - entry.start
  }

  return total
}

// Writes the session's running cost into today's entry. The write states a total, never adds a
// difference, so a reload or a restart that repeats it changes nothing.
const count = async ($: EngineInterface, usd: number | undefined) => {
  if (usd === undefined) {
    return
  }

  const at = await $.clock.now()
  const id = await $.session.id()
  const root = await ledger($)
  const file = `${root}/${dayOf(at)}/${id}.json`
  let entry = await entryIn($, file)

  if (entry === undefined) {
    const before = await entryIn($, `${root}/${dayOf(at - 86_400_000)}/${id}.json`)
    const { startedAt } = await $.session.usage()
    // Carried over from yesterday; else a session begun today starts the day at zero; else its
    // earlier days are unknown and the day starts from what it has spent so far.
    entry =
      before !== undefined
        ? { start: before.now, now: before.now, offset: before.offset }
        : dayOf(startedAt) === dayOf(at)
          ? { start: 0, now: 0, offset: 0 }
          : { start: usd, now: usd, offset: 0 }
  }

  // A running cost below the last one seen means the session's ledger started over.
  const offset = entry.offset + usd < entry.now ? entry.now : entry.offset
  await $.fs.write(file, JSON.stringify({ start: entry.start, now: offset + usd, offset }))
}

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'Spend' }

const compact = (n: number) =>
  n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 100_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

const tone = (percent: number) => (percent >= 85 ? 'error' : percent >= 60 ? 'warning' : 'success')

const label = (kind: string) => {
  if (LIMIT_LABELS[kind] !== undefined) {
    return LIMIT_LABELS[kind]
  }

  const model = kind.replace(/^(seven_day|five_hour)_?/, '').replace(/_/g, ' ')
  const window = kind.startsWith('five_hour') ? '5h' : kind.startsWith('seven_day') ? '7d' : ''

  return `${window} ${model.charAt(0).toUpperCase()}${model.slice(1)}`.trim()
}

const hueOf = (kind: string) => (kind.startsWith('five_hour') ? 'blue' : kind.startsWith('seven_day') ? 'purple' : 'grey')

const iconOf = (kind: string) => (kind.startsWith('five_hour') ? 'clock' : kind.startsWith('seven_day') ? 'calendar' : 'coin')

const until = (resetsAt: string | undefined, now: number) => {
  const ms = resetsAt === undefined ? NaN : Date.parse(resetsAt) - now

  if (!(ms > 0)) {
    return undefined
  }

  const minutes = Math.round(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  return days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`
}

// The desktop band: one SVG of pills, each a label, a bar, a percentage and a detail.
const CHAR = 7.25
const BAR = 48
const PILL_H = 24
// One colour per pill, mid-tones that read on a light and a dark window.
const HUES = { green: '#2e8b4d', blue: '#2f6fd0', purple: '#7a54c7', grey: '#7b7f87', yellow: '#9a7300', orange: '#c2571a' }
const TONES = { success: '#3f9d5c', warning: '#c98a12', error: '#d9483b' }

// 16px line icons, drawn in the pill's own colour.
const ICONS = {
  gauge: '<path d="M3 11.5a5 5 0 1 1 10 0"/><path d="M8 11.5l2.4-3.6"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
  calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="2"/><path d="M2.5 7h11M5.5 2v3M10.5 2v3"/>',
  coin: '<circle cx="8" cy="8" r="5.5"/><path d="M9.7 6.4c-.5-.7-3.2-.9-3.2.5 0 1.5 3.2.8 3.2 2.3 0 1.3-2.8 1.3-3.4.5M8 4.6v6.8"/>',
}

type Pill = { name: string; icon: keyof typeof ICONS; hue: keyof typeof HUES; percent?: number; detail?: string; hasBar?: boolean }

const drawPills = (pills: Pill[]) => {
  let x = 0
  let body = ''

  for (const pill of pills) {
    const start = x
    const hue = HUES[pill.hue]
    let inner = ''
    let cx = start + 12
    const text = (s: string, fill: string, weight = 400, opacity = 1) => {
      inner += `<text x="${cx}" y="16.5" fill="${fill}" fill-opacity="${opacity}" font-weight="${weight}">${s}</text>`
      cx += s.length * CHAR + 8
    }

    inner += `<g transform="translate(${cx} 4)" fill="none" stroke="${hue}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[pill.icon]}</g>`
    cx += 16 + 6

    // A pill whose icon says what it is carries no name.
    if (pill.name !== '') {
      text(pill.name, hue, 600)
    }

    if (pill.percent !== undefined) {
      // The pill's own colour until the figure needs attention, then amber, then red.
      const level = tone(pill.percent)
      const fill = level === 'success' ? hue : TONES[level]
      const width = Math.max(pill.percent > 0 ? 3 : 0, (Math.min(100, pill.percent) / 100) * BAR)

      if (pill.hasBar !== false) {
        inner += `<rect x="${cx}" y="9.5" width="${BAR}" height="5" rx="2.5" fill="${hue}" fill-opacity="0.22"/>`
        inner += `<rect x="${cx}" y="9.5" width="${width}" height="5" rx="2.5" fill="${fill}"/>`
        cx += BAR + 8
      }

      text(`${Math.round(pill.percent)}%`, fill, 700)
    }

    if (pill.detail !== undefined) {
      if (pill.percent !== undefined) {
        inner += `<rect x="${cx}" y="6" width="1" height="12" fill="${hue}" fill-opacity="0.35"/>`
        cx += 9
        text(pill.detail, hue, 400, 0.8)
      } else {
        text(pill.detail, hue, 700)
      }
    }

    const width = cx - 8 + 12 - start
    body += `<rect x="${start}" y="0" width="${width}" height="${PILL_H}" rx="12" fill="${hue}" fill-opacity="0.13"/>${inner}`
    x = start + width + 8
  }

  const total = Math.max(1, x - 8)

  return {
    width: total,
    source: `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${PILL_H}" viewBox="0 0 ${total} ${PILL_H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">${body}</svg>`,
  }
}

const pillsOf = (now: Reading, at: number): Pill[] => [
  {
    name: 'Context',
    icon: 'gauge',
    hue: 'green',
    percent: now.percent ?? 0,
    detail: now.tokens === undefined ? 'no reading yet' : `${compact(now.tokens)} / ${compact(now.window)}`,
  },
  ...now.limits.map((limit: Limit) => ({
    name: label(limit.kind),
    icon: iconOf(limit.kind),
    hue: hueOf(limit.kind),
    // The plan windows are glance figures: percentage and reset only.
    hasBar: false,
    percent: limit.percentUsed,
    detail: until(limit.resetsAt, at),
  })),
  ...(now.usd === undefined ? [] : [{ name: '', icon: 'coin' as const, hue: 'yellow' as const, detail: `$${now.usd.toFixed(2)}` }]),
]

// The summary's three parts, each drawn as a chip in the pills' style ahead of its line.
const PARTS = [
  { match: /^now\b/i, name: 'Now', hue: 'blue', icon: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.4"/>' },
  { match: /^waiting\b/i, name: 'Waiting on you', hue: 'orange', icon: '<path d="M4.5 2.5h7M4.5 13.5h7M5.2 2.5c0 3.2 5.6 3.4 5.6 5.5s-5.6 2.3-5.6 5.5M10.8 2.5c0 3.2-5.6 3.4-5.6 5.5s5.6 2.3 5.6 5.5"/>' },
  { match: /^next\b/i, name: 'Next', hue: 'green', icon: '<path d="M3 8h9.5M9 4.5L12.5 8 9 11.5"/>' },
] as const
const CHIP_W = 150

const drawChip = (name: string, hue: string, icon: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${CHIP_W}" height="${PILL_H}" viewBox="0 0 ${CHIP_W} ${PILL_H}" font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="12">` +
  `<rect width="${CHIP_W}" height="${PILL_H}" rx="12" fill="${hue}" fill-opacity="0.13"/>` +
  `<g transform="translate(12 4)" fill="none" stroke="${hue}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${icon}</g>` +
  `<text x="34" y="16.5" fill="${hue}" font-weight="700">${name}</text></svg>`

// Splits "Now: the work stands here" into its part and its text; an unlabelled line gets no chip.
const partOf = (line: string) => {
  const colon = line.indexOf(':')
  const part = colon === -1 ? undefined : PARTS.find(p => p.match.test(line.slice(0, colon).trim()))

  return part === undefined ? { text: line } : { part, text: line.slice(colon + 1).trim() }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const { context, rateLimits, cost } = await $.session.usage()
    const first: Reading = { ...context, limits: rateLimits, usd: cost?.usd }
    await update($, reading, () => first)
    await count($, cost?.usd)
    await $.command.register({ name: 'spend', description: 'Show the cost of Claude Code sessions per day, last 14 days' })
    // The countdowns read the clock while drawing, so they need a redraw between turns.
    $.clock.every(20_000, () => $.ui.invalidate('ui.render'))

    return next(e)
  })

  // A summary describes the turn it was asked in; the next prompt makes it stale.
  on('prompt.submit', async ($, e, next) => {
    await update($, where, () => IDLE)

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    const latest: Reading = { ...e.context, limits: e.rateLimits, usd: e.cost?.usd }
    await update($, reading, () => latest)
    await count($, e.cost?.usd)

    return next(e)
  })

  on('command.run', { command: 'spend' }, async $ => {
    const days = (await $.fs.list(await ledger($)).catch(() => [])).map(entry => entry.name).sort().slice(-14)
    const rows = []

    for (const day of days) {
      rows.push(`${day}  $${(await totalOf($, day)).toFixed(2)}`)
    }

    return { text: rows.length === 0 ? 'No spend recorded yet.' : rows.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, reading)

    if (e.props.hasSurvey || now === null) {
      return next(e)
    }

    const pills = pillsOf(now, await $.clock.now())

    if (e.surface === 'desktop') {
      const { Box, Button, Svg, Text } = $.ui.resolve(e)
      const asked = (await read($, where)) ?? IDLE
      const { source, width } = drawPills(pills)
      const alt = pills.map(p => [p.name || 'Cost', p.percent === undefined ? '' : `${Math.round(p.percent)}%`, p.detail ?? ''].join(' ')).join(', ')

      return (
        <Box flexDirection="column">
          <Box alignItems="center" gap={1} flexWrap="wrap">
            <Svg source={source} alt={alt} width={width} height={PILL_H} />
            <Box flexShrink={0}>
              {asked.status === 'ready' ? (
                <Button key="hide" label="Hide" onPress={() => update($, where, () => IDLE)} />
              ) : (
                <Button key="where" label={asked.status === 'asking' ? 'Asking…' : 'Recap'} onPress={() => ask($)} />
              )}
            </Box>
          </Box>
          {asked.lines.map((line, i) => {
            const { part, text } = partOf(line)

            return (
              <Box key={`where-${i}`} alignItems="center" gap={1} marginTop={1}>
                {part !== undefined && (
                  <Svg source={drawChip(part.name, HUES[part.hue], part.icon)} alt={part.name} width={CHIP_W} height={PILL_H} />
                )}
                <Text color={part === undefined ? undefined : HUES[part.hue]}>{text}</Text>
              </Box>
            )
          })}
        </Box>
      )
    }

    const { Box, Text } = $.ui.resolve(e)
    const CELLS = 12

    return (
      <Box gap={3}>
        {pills.map(pill => {
          const filled = Math.min(CELLS, Math.round(((pill.percent ?? 0) / 100) * CELLS))

          return (
            <Text key={pill.name}>
              <Text dimColor>{pill.name} </Text>
              {pill.percent !== undefined && (
                <Text>
                  {pill.hasBar !== false && <Text color={tone(pill.percent)}>{'█'.repeat(filled)}</Text>}
                  {pill.hasBar !== false && <Text dimColor>{'░'.repeat(CELLS - filled)} </Text>}
                  <Text color={tone(pill.percent)}>{Math.round(pill.percent)}% </Text>
                </Text>
              )}
              <Text dimColor>{pill.detail ?? ''}</Text>
            </Text>
          )
        })}
      </Box>
    )
  })
}
