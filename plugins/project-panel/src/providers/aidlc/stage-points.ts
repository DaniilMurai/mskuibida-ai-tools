// Story points per stage, for the plan's percent. Every stage is 1 point, a Unit its own points (points.ts), so the
// plan weighs real building against the stages around it. `<intent>/stage-story-points.txt` overrides a stage's
// points, or the rate for every stage it does not name:
//
//   # design work is heavier here
//   default: 1
//   domain-design: 3
//   build-and-test: 2
//
// One `<stage>: <points>` per line (`=`, `,` or spaces work as the separator too), `default` for every stage not
// named; blank lines and `#` comments are skipped, and the last line for a stage wins. Pure: the caller reads the file.

export const STAGE_POINTS_FILE = 'stage-story-points.txt'

/** A stage's points when nothing names it. */
export const DEFAULT_STAGE_POINTS = 1

export type StagePoints = {
  /** Points by stage slug, for the stages the file names. */
  byStage: Map<string, number>
  /** Points for every stage the file does not name: its `default` line, else 1. */
  fallback: number
  /** The file exists (even empty): the plan then says it counts by story points. */
  isPresent: boolean
  /** Names on the file's lines that are no stage of this plan, in file order, each once. */
  unknown: string[]
  /** Line numbers (from 1) the file has that are not `<stage>: <points>`. */
  unreadable: number[]
}

/** No file: every stage 1 point. */
export const NO_STAGE_POINTS: StagePoints = { byStage: new Map(), fallback: DEFAULT_STAGE_POINTS, isPresent: false, unknown: [], unreadable: [] }

const LINE = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:[:=,]\s*|\s+)(\d+(?:\.\d+)?)$/

/** The file's text read against the plan's stage slugs (`known`); null text = no file. Stage names match in any case. */
export function parseStagePoints(text: string | null, known: readonly string[]): StagePoints {
  if (text === null) return NO_STAGE_POINTS
  const canonical = new Map(known.map(slug => [slug.toLowerCase(), slug] as const))
  const byStage = new Map<string, number>()
  const unknown: string[] = []
  const unreadable: number[] = []
  let fallback = DEFAULT_STAGE_POINTS
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') return
    const match = LINE.exec(line)
    if (!match) {
      unreadable.push(index + 1)
      return
    }
    const name = match[1]!.toLowerCase()
    const points = Number(match[2])
    if (name === 'default') {
      fallback = points
      return
    }
    const slug = canonical.get(name)
    if (slug === undefined) {
      if (!unknown.includes(match[1]!)) unknown.push(match[1]!)
      return
    }
    byStage.set(slug, points)
  })
  return { byStage, fallback, isPresent: true, unknown, unreadable }
}

/** A stage's points. */
export const stagePointsOf = (points: StagePoints, slug: string): number => points.byStage.get(slug) ?? points.fallback
